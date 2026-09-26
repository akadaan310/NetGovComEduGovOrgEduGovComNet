# ACSP Protocol Harness

The harness tests ACSP as a **deterministic system**, with no LLM involved.
Simulated actors (Human, Agent A, Agent B, Agent C) perform real protocol
operations over the real HTTP surface. The harness then checks ownership,
authority, provenance, history, versioning and failure behaviour.

## Design

```
harness/
  world.ts       builds a World: env (db + controllable clock + seeded RNG) and a transport
  client.ts      AcspClient: speaks HTTP (JSON and plain HTML) to a Transport
  actors.ts      Actor = { name, session_id, agent_id, capability? } + protocol verbs
  scenarios/     named scenarios, each a list of steps with assertions
  runner.ts      executes scenarios, collects a transcript, reports pass/fail
  cli.ts         `npm run harness` entry point
tests/           vitest suites: every scenario, plus unit tests
```

### Transports

The harness never calls engine functions directly. It sends `Request`
objects and reads `Response` objects:

| Transport | How | Use |
|---|---|---|
| **in-process** (default) | calls `createHandler(env)` directly, the exact handler Next.js mounts | fast, deterministic, zero setup |
| **http** (`--base-url https://…`) | real `fetch` against a running deployment | smoke-testing a deployment |

### Databases

| Mode | How |
|---|---|
| PGlite (default) | a fresh in-memory Postgres (WASM) per world, with migrations applied |
| Postgres | `--db postgres` or `ACSP_TEST_DATABASE_URL=postgres://…`. Each world uses a fresh schema. |

### Determinism

* **Clock:** a `ManualClock` starts at `2026-01-01T00:00:00Z` and advances
  1 ms per read. `world.clock.advance(ms)` jumps forward, which is used for
  capability expiry.
* **Randomness:** a seeded PRNG (sfc32) generates resource IDs, capability
  IDs and secrets. The same seed gives the same IDs.
* Production uses `crypto.randomBytes` and the system clock, injected through
  the same `Env` interface.

Scenarios that need clock control are skipped in `http` mode, and the
runner reports them as skipped.

## Actors

```ts
const human = world.actor('human', { kind: 'human' });
const a = world.actor('agent-a', { session: 'session-a', agent: 'agent-a' });
const b = world.actor('agent-b', { session: 'session-b', agent: 'agent-b' });
```

Actor verbs map one-to-one onto protocol operations: `create`, `append`,
`annotate`, `update`, `supersede`, `checkpoint`, `fork`, `delegate`,
`revoke`, `handoff`, `acknowledge`, `propose`, `resolveProposal`, `close`,
plus the reads `openHtml(url)`, `inspect(id)`, `status`, `events`,
`checkpointAt`, `diff` and `operations`. A verb returns the raw HTTP status
and the parsed body, and it never throws on protocol errors, so assertions
can check failures precisely.

An actor holds **only** the capabilities that were explicitly handed to it,
through `actor.receive(token)`. Nothing is shared between actors implicitly.
This is how the harness models session isolation.

## Scenarios

| Scenario | What it proves |
|---|---|
| `core-demonstration` | The complete Section 42 flow. A creates, publishes a TOK and checkpoints. The Human hands the URL to B. B opens the **HTML**, finds the bootstrap and the JSON link, inspects protocol, state, provenance, knowledge, operations and authority, proposes without authority, receives a delegation, and appends. A re-inspects and sees B's contribution with B's provenance. A "disappears" and a new session C can still reconstruct the state. |
| `lifecycle` | create → inspect → append → checkpoint → close. Closed resources refuse mutation and stay readable. |
| `authority-matrix` | read ≠ write, write ≠ ownership, ownership ≠ universal authority. Non-owners cannot delegate. |
| `handoff` | task handoff → acknowledge. Responsibility moves, ownership does not. The wrong session cannot acknowledge. |
| `proposals` | propose without authority, then owner accept or reject. `source` ≠ `recorded_by`, and `on_behalf_of` is recorded. |
| `supersession` | H3 is superseded by H4 and both are retained with lineage. Double supersession is refused. |
| `fork` | parent ├ child A └ child B. The children are independent, ancestry is retained, the parent is unmodified, and nothing merges. |
| `provenance-history` | every version has exactly one event, parent/resulting versions chain, and events cannot be updated or deleted (DB trigger). |
| `failures` | invalid resource, invalid operation, malformed payload, unsupported protocol, stale version, replayed mutation, key reuse, expired capability, revoked capability, cross-resource token, session spoofing, oversize body. |
| `concurrency` | parallel appends get distinct consecutive versions. Parallel writes with the same `expected_version` let exactly one succeed. |
| `get-safety` | opening every GET URL, including prepare and capability URLs, never changes the version. |
| `representations` | the HTML embeds exactly the JSON document, and `.json`, `?format=json` and `Accept` all agree. |
| `restricted` | a restricted resource needs a capability to read, and a `["read"]` capability reads but cannot write. |
| `checkpoint-resume` | resume from checkpoint N: the snapshot hash verifies, and the diff since N contains exactly the later changes. |
| `human-form-path` | A GET-only agent composes an intent URL. The human submits the no-JS form. Double submission is an idempotent replay. |
| `rate-limits` | unauthenticated writes are limited per client, reads never are, and the window resets. |
| `inter-session-operation-handoff` | **0.2.** A creates, publishes and checkpoints, then stops. B receives only the continuation URL, verifies the history (operation chain, state digest, checkpoints, schemas), finds from `viewer` that it may only propose, is refused `append`, and proposes citing A's operation. A (a new actor with only its saved capability) accepts; causation is derived. C (no capability) rebuilds the causation chain from the final URL. Variant: explicit delegation. |
| `idempotency-semantics` | **0.2.** Same request twice, after a week, concurrently, across two sessions, with a stale version, with a reused key; then every mutating operation repeated under a new key, checked against the registry's declared repeat semantics. |
| `extension-operations` | **0.2.** Registry and schemas; enable rules; draft/retired/unknown/version refusals; union-of-effects authority before any effect; replay; template injection; TOK-published and submitted definitions never run; no proposing; forks do not inherit. |
| `operational-security` | **0.2.** Leakage, record replay, forged/cross-resource references, spoofing, confused deputy, escalation, malicious text, URL injection, CSRF, races, secret flags, restricted references. |
| `protocol-compatibility` | **0.2.** Verbatim ACSP/0.1 envelopes still execute with all 0.1 response fields; unknown versions refused; `core:` names. |
| `computation-envelope` | the ACSP half of the ACSP × PURL composition bridge: a task whose refs are PURL URLs moves owner → A → B → owner. Refs stay verbatim and are never fetched (they use the `.invalid` TLD), checkpoint hashes recompute from served snapshots, B needs its own delegated capability to accept, and every contribution stays attributed to its own session. |

## Running

```bash
npm run harness                               # all scenarios, PGlite, in-process
npm run harness -- core-demonstration -v      # one scenario, full transcript
npm run harness -- --db postgres              # against DATABASE_URL / ACSP_TEST_DATABASE_URL
npm run harness -- --base-url https://acsp.example.com   # against a deployment
npm test                                      # vitest: all scenarios + unit tests
```

Against a deployment, scenarios needing clock control or direct database
access (`failures`, `rate-limits`, `provenance-history`) are skipped. Checks
that require HTTPS apply only to non-localhost origins. The full suite makes
about 60 unauthenticated writes, so raise `ACSP_RATE_LIMIT_ANON_PER_HOUR` on
the deployment while smoke-testing, or run `core-demonstration` alone.
Idempotency keys are prefixed with a per-run ID so that repeated runs never
replay each other.

### Two-process (and more) experiment: exp-0003

The in-process scenarios model session isolation with separate `Actor`
objects. `experiments/exp-0003` removes that shortcut: `npm run exp:0003`
starts `harness/serve.ts` as its own process and runs every session turn —
A, B, B's restart, A's review, C — as a **separate OS process**
(`scripts/exp-0003/agent.ts`) with a minimal environment and its own
private directory. The orchestrator plays the human and passes between
processes only the continuation URL the previous process printed (plus, in
the delegation run, the one capability the owner delegated). It records
every process's HTTP transcript (secrets redacted), output and exactly what
crossed between sessions, evaluates the pre-registered criteria, and
writes `record.json`. `npm run exp:0003 -- --verify` re-runs everything and
compares the normalised outcome hash with the committed record. The same
flow was then run with four independent language-model sessions
(`experiments/exp-0003/llm-sessions.md`).

### A local HTTP server for multi-process experiments

`npm run serve:local` (`harness/serve.ts`) serves the same handler over plain
HTTP on `127.0.0.1`, backed by in-memory PGlite (or `--data <dir>`), with
`--port` and `--seed` options. It prints `{"acsp":"http://127.0.0.1:<port>"}`
when ready. The PURL repository's composition experiment
(`npm run handoff` there) starts it so that separate agent processes can
reach one ACSP instance. It is for local experiments only: ACSP must be served
over HTTPS everywhere else.

The verbose transcript prints each step as:

```
[core-demonstration] step 07  agent-b  GET /r/7F82KQ3M9XTA  (html)  → 200
  ✓ page identifies itself as an Agent Continuity Resource
  ✓ bootstrap section present
  ✓ machine representation discoverable via <link rel="alternate">
```

## Adding a scenario

1. Create `harness/scenarios/<name>.ts` exporting a `Scenario`
   (`{ name, description, needsClock?, run(world, t) }`).
2. Use `t.step(label, fn)` and `t.check(condition, message)` for assertions.
3. Register it in `harness/scenarios/index.ts`. The CLI and vitest pick it
   up automatically.

When a scenario exposes a protocol flaw, fix PROTOCOL.md first, then the code.
