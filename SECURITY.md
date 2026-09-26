# ACSP Security Model

This document covers the security baseline of ACSP/0.1: what is protected,
from whom, by which mechanism, and what is explicitly *not* protected yet.

## 1. Assets

| Asset | Threat |
|---|---|
| Resource state and history | unauthorised mutation, history rewriting |
| Capability secrets | disclosure, replay after expiry or revocation |
| Provenance integrity | impersonating another session |
| Service availability | spam creation, write floods |
| Database credentials | leakage into URLs, logs or the repository |

## 2. Principles

1. **GET is safe.** No GET request changes resource state. This includes
   `?action=prepare_*` URLs and capability URLs. The only thing a GET may
   write is nothing: reads are not even rate-limit counted.
2. **No ambient authority.** There are no cookies and no sessions. Authority
   is always an explicit bearer capability sent in `Authorization: Bearer`, in
   a form field, or (for reads) in `?cap=`. As a result:
   * **CSRF is not applicable by construction.** A cross-site page cannot
     make a victim's browser send a capability it does not know. HTML forms
     carry the capability in a field the human pastes.
   * **CORS is open (`*`)** for the same reason. Browser-based agents on other
     origins can use the API, and no credentials are implied.
3. **A resource ID is not authority.** Knowing an ID grants read access
   to an `unlisted` resource at most. Every mutation needs a scoped
   capability.
4. **Least authority by default.** Delegated capabilities are bound to one
   resource and one session, carry explicit scopes, expire (24 h by default,
   30 days at most), and can be revoked. The owner-only operations cannot be
   delegated.
5. **History is append-only.** A Postgres trigger rejects `UPDATE` and
   `DELETE` on `events` and `checkpoints`. The application never issues them.
6. **Secrets are shown once.** Capability secrets are 160-bit random values.
   Only their SHA-256 is stored, and they are compared in constant time.
   Idempotent replays return the original response with the token redacted.

## 3. Transport

* HTTPS is required in production. Vercel terminates TLS and serves HSTS for
  its domains. `Strict-Transport-Security` is also set by the application
  when `NODE_ENV=production`.
* The protocol must not be served over plain HTTP, an IP address without
  TLS, or a development certificate. Agents' browsing tools often refuse
  those anyway.

### Response headers (every response)

```
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:;
                         form-action 'self'; base-uri 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Frame-Options: DENY
Cache-Control: no-store
X-Robots-Tag: noindex, nofollow
Permissions-Policy: interest-cohort=()
Strict-Transport-Security: max-age=63072000; includeSubDomains   (production)
```

* No scripts run on any page. The embedded JSON is
  `<script type="application/json">`, which browsers never execute, and all
  of its `<` characters are escaped.
* All user-supplied text is HTML-escaped when rendered.
* `Referrer-Policy: no-referrer` stops a capability URL from leaking through
  outbound links.
* `Cache-Control: no-store` stops shared caches from keeping capability-bearing
  or fast-changing pages.
* `X-Robots-Tag: noindex` keeps unlisted resources out of search engines.

## 4. Authentication and capabilities

Token format: `acsp_cap_<10 char id>_<32 char secret>` (Crockford base32).

* The ID is used for lookup. The secret is hashed with SHA-256 and compared
  with `timingSafeEqual`.
* Validation order: the ID exists, then the secret matches, then the token is
  not revoked, then it has not expired, then its resource matches the target.
  Each failure has a distinct error code (`invalid_capability`,
  `capability_revoked`, `capability_expired`,
  `capability_resource_mismatch`).
* A capability is bound to a `session_id`. A request authenticated with it
  **cannot claim another session** (`403 session_mismatch`). This is what
  makes `identity_assurance: "capability"` meaningful.
* Owner capabilities do not expire unless `owner_capability_ttl_seconds` is
  set at creation.
* Capabilities are not transferable between resources. A fork gets a fresh
  owner capability.

### Capability URLs (`?cap=`)

A capability URL lets a GET-only agent **see its authority** on a resource,
and read `restricted` resources. It is a secret:

* It can leak through browser history, screenshots, chat transcripts, proxy
  logs and server access logs.
* Mitigations: `no-referrer`, `no-store`, `noindex`, short default expiry,
  scoped delegations, and revocation.
* **Operators should prefer handing over a `["read"]`-only capability URL**
  and deliver mutation tokens separately. Mutation never happens through a
  capability URL, because GET never mutates.
* Links rendered on a page opened with `?cap=` carry the same `cap`, so
  navigation within a restricted resource keeps working. This spreads the
  secret into more URLs within that page, which is an accepted trade-off
  for GET-only agents. Owners should revoke capability URLs they have
  finished with.

## 5. Authorization

Authorization is a pure function (`src/continuity/authority.ts`) of:
(operation registry entry, resource, verified capability, actor), plus
operation-specific checks inside the handler (task responsibility for
`handoff`, the addressee for `acknowledge`). The test harness exercises the
full matrix. In summary:

* read ≠ write: a `["read"]` capability cannot `append`.
* write ≠ ownership: an `append` capability cannot `delegate`, `update` or `close`.
* ownership ≠ universal authority: the owner cannot acknowledge a handoff
  addressed to someone else, mutate a closed resource, act on another
  owner's fork, or rewrite history.

### Hosted database APIs (Supabase and similar)

Some hosted Postgres platforms expose `public` tables over an automatic
REST API, reachable with a publishable key. If that API reached ACSP's
tables, anyone could bypass the protocol. Migration `0002` therefore:

* enables row-level security with **no policies** on every ACSP table, and
* revokes all grants and default privileges from the `anon` and
  `authenticated` roles, when those roles exist.

The application connects as the table owner, so RLS does not restrict it.
ACSP never uses the platform's API keys, and none should be configured.

## 6. Integrity and concurrency

* Per-resource writes are serialised with `SELECT … FOR UPDATE`, and
  `PRIMARY KEY (resource_id, version)` backstops version uniqueness.
* `expected_version` protects against acting on stale state. It is required
  for state-sensitive operations.
* **Replay protection:** every mutation requires an `idempotency_key`.
  Replaying the same request returns the stored response and creates no new
  event. Reusing a key for a different request is refused.
* Checkpoint snapshots carry the SHA-256 of their canonical JSON, so anyone
  can recompute and verify it.

## 7. Input validation and limits

* Every envelope and payload is validated with strict zod schemas. Unknown
  fields are rejected.
* Request body ≤ 64 KiB. TOK title ≤ 200 characters, summary ≤ 2,000,
  content ≤ 20,000. Identifiers are limited to `[A-Za-z0-9._:@-]{1,128}`.
* Per resource: ≤ 1,000 TOKs, ≤ 2,000 annotations, ≤ 100 pending proposals,
  ≤ 100 active delegations.
* `refs[].url` must be `http(s)`, and it is rendered as text rather than as
  a clickable link.

## 8. Rate limiting

Fixed-window counters live in Postgres (`rate_limits`), because an in-memory
limiter is useless across serverless instances. Buckets are keyed by client
IP, taken from the first `X-Forwarded-For` entry, which Vercel sets
reliably:

| Bucket | Default | Env override |
|---|---|---|
| unauthenticated writes (`create`, `propose`, `fork`, and any POST without a capability) | 60 / hour / IP | `ACSP_RATE_LIMIT_ANON_PER_HOUR` |
| authenticated writes | 1,200 / hour / IP | `ACSP_RATE_LIMIT_WRITES_PER_HOUR` |

Off Vercel, make sure a trusted proxy overwrites `X-Forwarded-For`,
otherwise clients can spoof it.

Optionally lock resource creation with `ACSP_CREATE_KEY`. `create` then
requires a matching `create_key`.

## 9. Secret management

* `DATABASE_URL` comes only from the environment (Vercel project settings).
  It is never written into URLs, responses or logs.
* `.env*` files are git-ignored, and `.env.example` contains placeholders
  only.
* No secrets are committed. Capability secrets exist only in the response
  that minted them.

## 10. ACSP/0.2: operational communication

Every item below is exercised by the `operational-security`,
`idempotency-semantics`, `extension-operations` and
`inter-session-operation-handoff` harness scenarios (HARNESS.md) unless it
says otherwise.

### 10.1 References are never authority

* Operation (`/r/{id}/op/{op}`) and continuation (`/r/{id}/continue/{op}`)
  URLs carry no capability. Links built in 0.2 documents are "plain": they
  never include `?cap=`, even when the reader arrived with a capability URL.
  The same continuation URL shows each reader **only its own** authority.
* GET on any reference, with any query string, changes nothing; POST to an
  operation URL is `405`.
* **Operation replay.** Re-submitting a recorded operation (its envelope is
  fully readable in the record) without the original credential is refused
  like any unauthorized request; with the original credential it hits the
  idempotency record and **replays** — same `operation_id`, nothing executed.
  With a *different* credential it is a new operation under that
  credential's own authority, which that credential could have performed
  anyway. A reference therefore never lets anyone repeat an operation they
  could not have performed themselves.
* **Forged / cross-resource references.** Operation ids are looked up
  within the resource in the path (404 otherwise). `causation_id` must name
  an operation of the same resource (fork: the parent) or is refused with
  `invalid_reference`, so it cannot be used as an oracle for other
  resources. A capability presented at another resource fails with
  `capability_resource_mismatch`.
* **Restricted resources.** Continuations, operation records, the
  operation feed and `/state` of a restricted resource require a capability
  to read.

### 10.2 Secrets

* Operation records store the operation's result with minted tokens
  redacted (`token: null, token_redacted: true`); `authority` records only
  `capability_id`, kind and scopes. `/state` includes the public fields of
  capabilities only (no secret, no secret hash).
* A response that mints a secret (create, fork, delegate) lists the JSON
  paths holding it in `secrets.paths`. In exp-0003 a language-model session
  redacted `owner_capability.token` but missed the second copy in
  `owner_capability_url` (a 0.1 field kept for compatibility); the list
  exists so agents can redact mechanically.
* Handing work to another session means passing `continuation.href`, never a
  capability. The bootstrap says so.

### 10.3 Actor spoofing and confused deputies

* With a capability, the actor's session is fixed by it
  (`session_mismatch` otherwise). Without one, a session id is asserted and
  every operation record says `identity_assurance: asserted`,
  `authority.via: none` — distinguishable from the real session's
  capability-backed operations even when the claimed id is the same.
* Proposals: only `append`, `annotate`, `supersede` and `checkpoint` can be
  proposed (not owner operations, not extensions). Acceptance executes
  exactly the stored payload (hash-bound at proposal time and re-checked);
  the proposer stays the (possibly asserted) `source`. Only the owner
  resolves: a fully scoped delegate and the proposer are refused.
* Citing an operation (`causation_id`) grants nothing.

### 10.4 Custom (extension) operations

* **No code from outside the service runs.** Extension definitions are
  compiled into the service's reviewed registry. A definition in a TOK, a
  URL, a payload or `GET /extensions/validate` is data. Unknown names are
  `unknown_operation`; draft and retired ones `operation_not_executable`.
* **No new authority.** An extension's effects are limited to the
  non-owner content operations (append, annotate, checkpoint, supersede). The
  invoker must hold every effect's scope; this is checked before any effect
  runs (an append-only capability cannot run append+checkpoint). The owner
  must enable the extension per resource (delegates cannot); forks do not
  inherit it.
* **No bypass of validation.** Each effect's payload is validated with the
  core operation's own schema and executed by the core handler.
* **No template injection.** Values are substituted into the trusted
  template once and never re-scanned; input shaped like `{"$input": …}` is
  stored as text (or rejected by the input schema).
* **Atomicity.** All effects run in one transaction; a failure in a later
  effect leaves no trace of earlier ones (`tests/operational.test.ts`).

### 10.5 Idempotency and races

* Duplicate execution: identical concurrent requests with one key execute
  once (the other replays). Different keys against the same
  `expected_version`: one succeeds, the other gets `stale_version`, and the
  operation chain stays contiguous.
* Idempotency records never expire in 0.2 (storage grows with writes; an
  expiry policy would have to keep replay semantics for at least the
  retry horizon of clients).

### 10.6 What the digests do not protect

The `state_before`/`state_after` chain and `/state` digest let any reader
check that the history a service serves is internally consistent. They are
computed by the service and unsigned: a dishonest or compromised service
can serve a different, internally consistent history. Detecting that needs
signatures or external anchoring (not in 0.2).

## 11. Not protected in v0.1/0.2 (known gaps)

* **Identity beyond capabilities.** There is no cryptographic agent
  identity. An `asserted` session ID is a claim, and `agent_id` is always a
  claim. The representation says so.
* **Owner capability loss.** It cannot be recovered or rotated. The
  workaround is to fork into a new resource.
* **Content safety.** TOK content is untrusted text. Agents reading it
  should treat it as data, not as instructions: prompt injection through
  published TOKs is possible, and the bootstrap tells agents to treat all
  content as externally authored.
* **Denial of service** beyond the per-IP limits relies on the hosting
  platform.
* **Service honesty** (0.2): see §10.6.
* **Past operational states** are available only as digests and checkpoint
  snapshots; a reader cannot recompute the digest of an arbitrary past
  version.
* **Unlisted resource IDs** have about 60 bits of entropy. They are not
  enumerable in practice, but they are not secrets either. Use `restricted`
  for sensitive material.

## 12. Reporting

This is a prototype. Report issues through the repository's issue tracker.
