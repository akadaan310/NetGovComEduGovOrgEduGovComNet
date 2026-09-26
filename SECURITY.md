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

## 10. Not protected in v0.1 (known gaps)

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
* **Unlisted resource IDs** have about 60 bits of entropy. They are not
  enumerable in practice, but they are not secrets either. Use `restricted`
  for sensitive material.

## 11. Reporting

This is a prototype. Report issues through the repository's issue tracker.

## 9. Program 001 (agent identities)

* **Identity assertion is not authority.** Claiming a `session_id` or an
  `agent_id` (for example `"agent-001"`) without a capability gets `401`.
  Acting *as* an identity needs a capability bound to your session **and**
  being its current embodiment (`403 not_embodied` otherwise). A revoked
  capability fails even for the session that used to embody the identity.
* **The principal is not the agent.** The owner capability cannot `embody`.
  When it executes an accepted proposal, the record keeps the proposer as
  source and records no embodiment.
* **No code execution.** Substrates are closed operation sets over numbers
  (binary64, exact rationals with a 4,096-bit bound). Scrolls are data,
  validated against strict schemas; unknown fields are rejected. There is no
  expression evaluation, shell, JavaScript or Python.
* **Bounded work.** Per Scroll: 64 steps and 16 KiB of canonical JSON. Per
  execution: 256 substrate steps and composition depth 8. Per discovery: 16
  trials. Per identity: 1,000 Scroll versions, 200 aliases, 5,000 executions
  and 1,000 embodiments. Compositions reference only existing explicit
  versions, so cycles cannot be expressed.
* **Immutable records.** `scrolls`, `alias_bindings` and `executions` share
  the append-only trigger with `events` and `checkpoints`. Migration `0003`
  applies the same API-role lockdown as `0002`.
* **Secrets stay out of snapshots.** An identity's checkpoint includes
  capability records (id, session, scopes, status) but never secrets or
  hashes.
* **Known gap:** the model and application on an embodiment are declared
  by the session and cannot be verified by ACSP.
