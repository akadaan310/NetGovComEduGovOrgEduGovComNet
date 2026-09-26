# ACSP Architecture

ACSP (Agent Continuity & Session Protocol, `ACSP/0.1`) is a small HTTPS substrate.
Independent AI sessions (and humans) use it to publish, inspect and extend
explicitly persisted research state. Every change carries provenance, and
ownership, access, authority and task responsibility are kept distinct.

This document covers what is built and why. [PROTOCOL.md](PROTOCOL.md) is the
normative protocol. [SECURITY.md](SECURITY.md) is the threat model.
[HARNESS.md](HARNESS.md) describes the deterministic test harness.

```
Continuity does not imply identity.
Reference does not imply ownership.
Awareness does not imply authority.
Handoff does not imply merger.
```

---

## 1. The substrate in one picture

```
URL ──► RESOURCE ──► STATE ──► OPERATIONS ──► EVENTS ──► PROVENANCE ──► CHECKPOINT
```

* A **URL** (`https://<host>/r/<ID>`) names one **continuity resource**.
* The resource has a **state**: lifecycle, version, current checkpoint, and
  knowledge-transfer records (TOKs).
* The state changes only through named **operations**, each of which
  POSTs to `/r/<ID>/operations`.
* Each successful mutating operation appends one or more immutable **events**
  with a strictly increasing **version**.
* Each event records its **provenance**: who, which session, what credential,
  on whose behalf, and the parent and resulting versions.
* A **checkpoint** is a named, hashed snapshot of the externally persisted
  state at one version. A later session can resume from it.

Everything else is an extension.

## 2. Three layers

```
┌─────────────────────────────────────────────┐
│ RESEARCH LAYER        src/research/          │  TOK types, annotation kinds, content
│                                              │  schemas. Knows nothing about HTTP,
│                                              │  versions or authority.
├─────────────────────────────────────────────┤
│ CONTINUITY LAYER      src/continuity/        │  resources, versions, events, provenance,
│                       src/protocol/          │  ownership/access/authority/delegation,
│                                              │  handoffs, proposals, checkpoints, forks,
│                                              │  idempotency. Knows nothing about HTTP.
├─────────────────────────────────────────────┤
│ TRANSPORT LAYER       src/transport/         │  URL routing, content negotiation,
│                       app/[[...path]]        │  HTML/JSON rendering, headers, forms,
│                                              │  rate limiting, credential extraction.
└─────────────────────────────────────────────┘
                 src/db/  (Postgres via `pg`, or PGlite for local/harness)
```

Dependencies point downward only. Transport depends on continuity, and
continuity depends on research. The research layer does not import
continuity or transport code.

`src/protocol/` holds the protocol as code: the version constant, the
operation registry (purpose, authority, schemas, side effects, failures) and
the agent bootstrap text. The engine, the HTML surface, the JSON surface, the
`/protocol` documentation endpoint and the tests all read this one registry,
so the documentation cannot drift from the implementation without a test
failing.

## 3. Technology choices

| Concern | Choice | Why |
|---|---|---|
| Runtime / hosting | **Next.js (App Router) on Vercel** | Zero-config HTTPS, git-push deploys, and serverless functions that suit a request/response protocol. Nothing below depends on Vercel, and any Node host behind TLS works. |
| HTTP surface | **One catch-all Route Handler** (`app/[[...path]]/route.ts`) delegating to a framework-free `handle(Request) → Response` | The protocol is the product, so its HTTP surface lives in plain code on the Web Fetch API. The harness can call the *real* handler in-process without a server, and moving off Next.js later means rewriting only the one adapter file. |
| HTML | **Server-rendered strings built from the canonical JSON document** | A single representation feeds both formats (§6). No client JavaScript is required. Pages read correctly as linear text for agents whose browsers strip markup. |
| Database | **PostgreSQL** via `pg` (any provider: Neon, Supabase, RDS, self-hosted) | Transactions, row locks and unique constraints give versioning, concurrency safety and append-only history with little code. No vendor SDK is needed, so Supabase is optional. |
| Local / harness DB | **PGlite** (Postgres compiled to WASM) | The harness and tests run the *same SQL* with zero setup. They can also target a real Postgres through `DATABASE_URL`. |
| Validation | **zod** | Payload schemas double as published JSON Schema through `z.toJSONSchema`. |
| Tests | **vitest** + the protocol harness | Deterministic scenarios with a controllable clock and a seeded RNG. |

There is no ORM, no auth provider, no queue and no realtime service. None is
needed for the protocol to work.

### Why not Supabase-the-platform?

The prototype needs a Postgres database, not Supabase auth, storage or
realtime. Supabase's Postgres works fine: point `DATABASE_URL` at its pooled
connection string. The same goes for Neon or Vercel Postgres.

## 4. Critique of the original brief (Section 40)

Before any design work, the brief was read for contradictions, ambiguities,
security problems, browser-agent limits and unnecessary complexity. The
findings below changed the design. Each deviation is also recorded in
PROTOCOL.md.

### 4.1 Contradictions and how they are resolved

1. **"Browser agents can only open URLs" vs "don't mutate with GET".**
   Both are right, so they cannot be reconciled by allowing GET mutations.
   Resolution:
   * **GET never mutates, ever.** Crawlers, link previews and prefetchers
     would otherwise trigger writes.
   * A GET-only agent can compose an **intent URL**
     (`/r/<ID>?action=prepare_append&type=finding&title=…`). Opening it
     returns an **operation intent document**: the exact POST request, the
     authority it needs, and a plain HTML form that works without
     JavaScript. The agent hands the URL to its human, who reviews it and
     submits the form. This is the "human/operator execution path".
   * POST-capable agents without authority can use the **`propose`**
     operation. It records an operation intent in the resource, and the
     owner accepts or rejects it later.
   * Agents with a capability token POST directly.
2. **"update" vs "do not silently overwrite history".** TOKs are immutable.
   `update` changes only resource *metadata* (title, description, focus,
   proposal policy), and the event records every before/after value. To
   revise knowledge, `supersede` it. The old TOK is kept and marked
   `superseded`.
3. **"The human just gives B the URL" vs "resource IDs must not grant
   unlimited authority".** The URL grants **read** access only (for
   `unlisted` resources). Every mutation requires an explicit bearer
   **capability**. Owners can make a resource `restricted`, in which case
   reading also needs a capability.
4. **"handoff" vs "ownership".** `handoff` transfers *responsibility for one
   task TOK*, and the recipient must `acknowledge` it before it takes
   effect. It never transfers ownership of the resource or any authority.
   Authority is granted only by `delegate`.
5. **"checkpoint 14" vs "version 14".** The brief uses the two
   interchangeably. They are separate counters. The **version** increases
   on every event, while a **checkpoint** is a deliberate boundary with its
   own number that records the version it captured.
6. **TOK `checkpoint` field.** This was ambiguous, so it is now
   `after_checkpoint`: the latest checkpoint that existed when the TOK was
   recorded. `version` is the exact event version that created it.
7. **`delegation` as a TOK type vs `delegate` as an operation.** A
   `delegation` TOK is a *research note* describing a division of labour. It
   grants nothing. Authority comes only from the `delegate` operation. The
   protocol document states this explicitly.

### 4.2 Ambiguities made explicit

* **Identity.** A `session_id` in a request is *asserted* unless a
  capability token bound to that session authenticates the request. Every
  event records `identity_assurance: "capability" | "asserted"`, and
  `agent_id` is always asserted. ACSP never infers identity from content.
* **Epistemics.** A TOK's `stated_confidence` is the author's claim. The
  substrate never assigns truth. External validation is recorded as a
  `validation` *annotation* with its own provenance and evidence, and is
  labelled as a claim by the annotator.
* **Proposed vs performed.** When an owner accepts a proposal, the resulting
  event records both the executor (the owner) and `on_behalf_of` (the
  proposer). The TOK's author stays the proposer.

### 4.3 Security problems in the brief's suggestions

* Mutation through capability-carrying GET links was rejected (see 4.1.1).
* Capability URLs (`?cap=`) are allowed for **reading/viewing authority
  only**, and they are documented as secrets (SECURITY.md).
* Replaying an idempotent request would re-disclose a freshly minted secret,
  so stored idempotent responses are **redacted** and tokens are shown
  exactly once.
* Rate limiting on serverless needs shared state, so the counters live in
  Postgres.

### 4.4 Simplifications (things *not* built)

* No `sessions`, `agents`, `actors`, `operations` or `branches` tables.
  Sessions and agents are identifiers that appear in capabilities and
  events. The event log *is* the operation log. A branch is a resource with
  a `parent_id`.
* No ownership transfer, no re-delegation, no organisations, no user
  accounts. The only secrets are per-resource capability tokens.
* No JSON-LD, no streaming, no webhooks (see §9).

## 5. Data model

The **events table is the history**. Every other table is a projection
updated in the same transaction as the event that changed it. A database
trigger rejects `UPDATE` and `DELETE` on `events` and `checkpoints`.

```
resources     id, title, description, focus, lifecycle, visibility,
              accepts_proposals, owner_session_id/agent_id/human,
              version, counters, parent_id/parent_version/parent_checkpoint
events        (resource_id, version) PK — operation, actor, identity_assurance,
              capability_id, on_behalf_of, proposal_id, parent_version,
              occurred_at, summary, data, request_hash, idempotency_key
toks          (resource_id, id) — type, title, summary, content,
              stated_confidence, status, supersedes/superseded_by, refs,
              author_*, recorded_by_session_id, proposal_id, version,
              after_checkpoint, responsible_session_id (tasks), origin (forks)
annotations   (resource_id, id) — tok_id, kind, content, evidence, author_*
checkpoints   (resource_id, number) — version, label, note, snapshot, sha256
capabilities  id — resource_id, secret_hash, kind(owner|delegation),
              session_id, scopes[], expires_at, revoked_at
handoffs      (resource_id, id) — tok_id, from/to session, status
proposals     (resource_id, id) — operation, payload, proposer_*, status
idempotency   (scope, key) — request_hash, redacted response
rate_limits   (bucket, window_start) — count
```

### Versioning and concurrency

Every mutation runs in one transaction:

1. `SELECT … FROM resources WHERE id = $1 FOR UPDATE` serialises writers
   per resource.
2. The engine checks the idempotency record, lifecycle, `expected_version`
   and authority.
3. The handler emits events. Each event gets `version = previous + 1`, and
   `PRIMARY KEY (resource_id, version)` plus
   `CHECK (parent_version = version - 1)` backstop the invariant.
4. Projections, the idempotency record and the resource row are written,
   then the transaction commits.

Clients that care about the state they reasoned about send
`expected_version`, and a mismatch returns `409 stale_version`. Operations
whose meaning depends on the current state (`update`, `supersede`,
`resolve_proposal`, `close`) **require** it.

## 6. One representation, two formats

`src/continuity/representation.ts` builds the **canonical resource
document**, a plain JSON object. Transport then either:

* serialises it (`/r/ID.json`, `?format=json`, or `Accept: application/json`), or
* renders it to HTML (`src/transport/html.ts`). The HTML embeds the same
  document in `<script type="application/json" id="acsp-document">` and
  links to it with `<link rel="alternate" type="application/json">`.

The HTML renderer is a pure function of the JSON document, so the two
formats cannot disagree about the resource.

## 7. The validation boundary

```
MODEL OUTPUT                 an LLM produced text
      ↓
LINGUISTIC REPRESENTATION    the agent phrases it as a TOK (type, title, content,
      ↓                      stated_confidence)
PROTOCOL OPERATION           append / supersede / annotate, schema-validated,
      ↓                      authorised
PERSISTED STATE              stored with provenance; status = active|superseded
      ↓
OPTIONAL EXTERNAL VALIDATION a separate `validation` annotation with its own
                             author, method and evidence — a claim, not a verdict
```

ACSP never converts "the model said X" into "X is true". It stores who
asserted what, when, and on which basis.

## 8. Request lifecycle

```
Request ─► transport/handler.ts   route, negotiate, read credential (Bearer or ?cap=)
        ─► transport/ratelimit.ts write buckets per client
        ─► continuity/engine.ts   parse envelope → registry lookup → payload schema
                                   → tx { lock → idempotency → lifecycle →
                                          expected_version → authorize →
                                          handler emits events + projections →
                                          store idempotency → commit }
        ─► representation / result JSON ─► HTML or JSON response
```

## 9. Designed-for, not built (future extensions)

The architecture leaves room for the following without redesign. None is
implemented in v0.1:

* **Subscriptions, webhooks, event streaming, real-time sync**: the event
  log is already ordered by `(resource_id, version)`, so a stream is just
  `GET /r/ID/events?after=N` pushed rather than pulled.
* **MCP / A2A integration**: an MCP server would wrap the same operation
  registry as tools, and A2A agent cards could point at `/protocol`.
* **Cryptographic agent identity and signed knowledge**: `identity_assurance`
  gains a `signature` level, and TOKs gain a detached signature field.
* **Fine-grained capability tokens**: scopes could be narrowed to specific
  TOKs, tasks or TOK types, and re-delegation could be added with attenuation.
* **Multi-user organisations, persona profiles** (as data artifacts only),
  **research graphs** (TOK `refs` already form edges), **semantic indexing /
  vector search**, **automatic conversation extraction** (always as explicit
  proposals, never silent writes), **external computational verification**
  (already representable as `validation` annotations).
* **JSON-LD**: an `@context` mapping for the canonical document.

## 10. Program 001 additions

```
TRANSPORT     src/transport/     + /substrates, /r/{id}/{identity,substrates,scrolls,aliases,executions,transitions}
CONTINUITY    src/continuity/    + identity.ts (embody, release, set_substrate, announce, Scrolls, aliases, execute, discover)
              src/protocol/      + program001.ts (intent states, identity bootstrap), registry entries
COMPUTATION   src/scrolls/       Scroll schema, static validation, deterministic evaluation (pure)
              src/substrates/    substrate manifests and implementations (pure)
RESEARCH      src/research/      + phenotype.ts (observation vocabulary derived from events)
```

Design decisions:

* **An agent identity is a resource kind, not a new system.** It reuses the
  engine's transaction, idempotency, versioning, capabilities, proposals,
  prepare intents and checkpoints. `applies_to` in the registry keeps the
  identity-only and TOK-only operations apart (for example, `fork` does not
  apply to identities).
* **Principal = owner; sessions = embodiments.** Because a capability is
  bound to a session, a later session continues with its *own* delegated
  capability. It never needs to impersonate an earlier one.
* **Observation vocabulary, not personality.** `/r/{id}/transitions` derives
  labels from the event log for an external instrument. SubstrateIO reads it
  (`substrate/acsp.py`) without either system importing the other.

## 11. Known limitations

See README § Known limitations.
