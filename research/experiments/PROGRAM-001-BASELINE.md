# PROGRAM 001 — Baseline (captured before any Program 001 change)

Captured 2026-09-26, before modifying behaviour. Everything below was read
from the repository or produced by running its own commands at the commit
listed. Nothing here is a claim about Program 001.

## Identification

| Item | Value |
|---|---|
| Repository | `akadaan310/NetGovComEduGovOrgEduGovComNet` (package name `acsp`) |
| Branch | `claude/acsp-program-001-k616hw` |
| Commit | `62aee3712080b8b893285aaeaf7f787987c60400` ("README: link live deployment and field-trial resource") |
| Protocol version | `ACSP/0.1` (`src/protocol/constants.ts`, `PROTOCOL_VERSION`) |
| Runtime | Node.js 22.22.2, TypeScript 5.9, Next.js 16 (one catch-all route), zod 4, vitest 5 |
| Database | PostgreSQL via `pg`; PGlite (WASM Postgres) for harness/tests |
| Size | ~8.4k lines tracked (excluding `package-lock.json`) |

## Test and harness status

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` (vitest) | **2 files, 24 tests, 24 passed** (16 harness scenarios as tests + 8 unit tests), ~33 s |
| `npm run harness` | **16/16 scenarios passed, 402 checks, 0 skipped** (in-process, PGlite) |
| `npm run harness -- --db postgres` | not run: no Postgres server in this container (CI runs it) |
| `npm run build` | not run for the baseline (CI runs it) |

Scenario check counts: core-demonstration 89, lifecycle 23, authority-matrix 25,
handoff 22, proposals 19, supersession 13, fork 25, provenance-history 12,
checkpoint-resume 13, failures 47, concurrency 11, get-safety 34,
representations 26, restricted 13, human-form-path 23, rate-limits 7.

## Architecture as found

```
TRANSPORT    src/transport/  one Fetch-API handler (routing, negotiation, HTML, intents, rate limits)
CONTINUITY   src/continuity/ engine (tx, versions, idempotency), handlers, authority, records,
             src/protocol/   state, representation; operation registry, bootstrap, errors
RESEARCH     src/research/   TOK types and schemas
DB           src/db/         pg / PGlite behind one `Sql` interface; SQL migrations in db/migrations
```

The operation registry (`src/protocol/operations.ts`) is the single source of
operation semantics; the engine, HTML, JSON, `/protocol` and a docs-sync test
all read it.

## Existing invariants

```
Continuity does not imply identity.
Reference does not imply ownership.
Awareness does not imply authority.
Handoff does not imply merger.
```

Mechanically enforced:

* GET never changes state (the `get-safety` scenario opens every GET URL, including prepare and capability URLs).
* Every mutation is one transaction: lock resource row → idempotency → authorize → lifecycle → `expected_version` → handler → idempotency record.
* Each event has `version = previous + 1` (`PRIMARY KEY (resource_id, version)`, `CHECK (parent_version = version - 1)`).
* `events` and `checkpoints` are append-only (Postgres trigger `acsp_forbid_history_mutation`).
* A capability is bound to one resource and one session; claiming another session → `403 session_mismatch`.
* HTML embeds the identical JSON document.

## Resource lifecycle

`create` (version 1, genesis checkpoint 0, owner capability) → `active` →
mutations (each +1 version) → `close` (terminal; readable and forkable
forever). `fork` creates a new resource with lineage; the parent is not
modified. There is one kind of resource: the research **continuity resource**
holding TOKs.

## Authority model

Five separate concepts: ownership (one owner session, owner capability),
access (`unlisted` URL-readable / `restricted`), authority (capability
scopes `read, append, annotate, checkpoint, supersede, handoff`, plus
`owner`), delegation (owner grants a session-bound, expiring, revocable
capability; no re-delegation), task responsibility (per task TOK, moved by
`handoff` + `acknowledge`). `identity_assurance` is `capability` or
`asserted`. `actor.agent_id` is always self-asserted.

## Checkpoint model

Checkpoints are numbered separately from versions. A checkpoint stores the
canonical JSON snapshot `{ protocol, resource, knowledge, handoffs }` at the
checkpoint's version and its SHA-256 (`sha256:` + hex of canonical JSON with
sorted keys). Resume = read checkpoint N, then `diff?since_checkpoint=N`.

## Event model

One `events` row per state change: operation, actor (session, agent label,
kind), identity_assurance, capability_id, on_behalf_of, proposal_id,
occurred_at, summary, data, request_hash, idempotency_key. The event log is
the operation log; other tables are projections updated in the same
transaction.

## Proposal / handoff / intent model

* **Prepared intent:** `GET /r/{id}?action=prepare_{op}` returns a request, a
  validation report and a no-JS form; never stored.
* **Proposal:** `propose` stores an operation intent (`append`, `annotate`,
  `supersede`, `checkpoint`) with asserted or capability identity; the owner
  `resolve_proposal`s it, emitting `resolve_proposal` and then the executed
  operation's event with `on_behalf_of` the proposer.
* **Handoff:** task-scoped, two-phase, grants no authority.

## Existing limitations relevant to Program 001

1. **No agent identity.** Sessions and agents are only identifiers in
   events and capabilities (ARCHITECTURE §4.4: "No sessions, agents, actors …
   tables"). `actor.agent_id` is a self-asserted *software label* (e.g.
   `claude`) — closer to "model identity" than to a persistent agent.
2. **Ownership is bound to a session.** The owner capability is bound to the
   creating `session_id`, and there is no ownership transfer or
   re-delegation. A new session can continue only by receiving a *new*
   delegated capability bound to its own session.
3. **No computation.** Nothing is executed; ACSP stores TOKs (text) only.
   There is no substrate, operation-contract or execution concept.
4. **No versioned artifacts other than TOK supersession.**
5. **Identity is not cryptographic.** Assurance is capability possession.
6. Resource documents are not paginated.
7. Postgres-only paths (`--db postgres`, `next build`) were not exercised in
   this container.

## Repositories in scope and their roles

| Repository | Role for Program 001 |
|---|---|
| `NetGovComEduGovOrgEduGovComNet` | **ACSP** — the system under observation; all Program 001 code goes here |
| `substrateIO` | Python 3.11 stdlib research instrument with its own protocol and registries; consumes an exported projection only |
| `purl` | Separate addressing/operation-surface protocol; kept conceptually separate, referenced only |
