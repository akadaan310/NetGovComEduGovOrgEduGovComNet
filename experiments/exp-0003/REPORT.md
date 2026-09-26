# exp-0003 — Report

**Question:** Can two independent sessions communicate through ACSP state
transitions rather than through conversation messages?

**Answer, as measured:** yes, in the narrow sense this experiment defines.
Separate processes, and separately four independent language-model
sessions, continued one another's work when the only thing passed between
them was a URL to persisted state. Each receiving session:

- read that state;
- verified the history it served;
- determined its own authority from the resource;
- acted under its own identity;
- returned a new URL.

No transcript, model state, identity or authority crossed between sessions.
A human (or a human-playing orchestrator) still carried every URL.

| | |
|---|---|
| Protocol | ACSP/0.2 (this branch) |
| Pre-registration | `definition.json`, commit `6c04020` |
| Recorded run | code of commit `bd3915b`; outcome hash `sha256:46ef1115c5d2a53de54fa0c6bc76c22e0bb684577bf6d4443de079b07ee1a0bb` |
| Reproduced | `npm run exp:0003 -- --verify` → `REPRODUCED` (fresh processes, new ids, same normalised outcomes) |
| LLM sessions | 4 sessions, one run, resource `D36B29YE08TE`; [`llm-sessions.md`](llm-sessions.md) |

Kinds of statement are labelled **OBS** (observed), **TRF** (computed from
observations), **INT** (interpretation) and **HYP** (pre-registered
hypothesis and its mechanical outcome).

## 1. Hypotheses (scripted, separate processes)

| | Statement | Outcome |
|---|---|---|
| H1 | B, given only A's continuation URL, resolves the resource and verifies its history | supported |
| H2 | B determines its own authority; holding the URL grants it nothing | supported |
| H3 | B's contribution is persisted as an attributed, cited transition | supported |
| H4 | A, in a new process with only its own capability and B's URL, continues | supported |
| H5 | A third session with no credentials reconstructs why the final state exists | supported |
| H6 | No capability secret crosses between sessions | supported |
| H7 | An operation reference does not confer authority to repeat or resolve | supported |
| H8 | A retried request from a restarted process replays instead of re-executing | supported |
| H9 | Explicit delegation is the only way B gains authority, and it is visible | supported |

## 2. What happened (scripted run)

**OBS.** The orchestrator started the ACSP service as its own process, then
ran each session turn as a separate process. Process ids were `a1` 3213,
`b` 3233, `bRetry` 3253, `a2` 3273 and `c` 3293. Each process had:

- a minimal environment (`PATH`, `PRIVATE_DIR`);
- its own private directory.

What crossed between sessions, verbatim
([`raw/proposal-passed-between-sessions.json`](raw/proposal-passed-between-sessions.json)):
three continuation URLs, one per hand-over. Nothing else.

1. **A** created a resource, appended a task, appended a finding (citing
   the task), and checkpointed (citing the finding). It kept its owner
   capability in its own directory and printed a continuation URL.
2. **B** received only that URL.
   - Its continuation document validated against `acsp.continuation/0.2`.
   - Using only GETs it confirmed that the operation chain was contiguous,
     the current state digest recomputed and equalled the last `state_after`,
     every checkpoint recomputed, and every record matched `acsp.operation/0.2`.
   - `viewer`: `authenticated: false`, scopes `[]`, permitted `["fork", "propose"]`.
   - Its `append` attempt returned `401 authentication_required`.
   - It proposed, citing A's checkpoint operation: `200`, identity `asserted`.
   - Its attempt to resolve its own proposal returned `401`.
3. **B's restarted process** re-sent the same propose envelope. It got
   `replayed: true` with the same operation id, and the resource still had
   one proposal.
4. **A's new process** loaded its own capability from its own directory and
   opened B's URL.
   - It verified the chain and the proposal's payload hash.
   - It accepted: one operation, two events, `on_behalf_of: session-b`,
     causation derived from the proposal.
5. **C**, with no credential, rebuilt the causation chain from the final URL:
   `resolve_proposal (A, capability, derived) ← propose (B, asserted) ←
   checkpoint (A) ← append (A) ← append (A)`. There was one correlation id
   throughout.
   - Re-submitting the recorded accept without a capability returned `401`,
     and the version was unchanged.
6. **Delegation run.**
   - A additionally delegated `[append]` to session-b. The orchestrator
     handed B that one token, which differs from A's owner token.
   - B appended directly, with identity `capability` and kind `delegation`.
   - C saw `append (B) ← delegate (A) ← checkpoint (A) ← …`.

**OBS.** No response body received by B or C contained a capability
secret. No argument or environment variable given to B or C did either,
except B's own delegated token in the delegation run. None of the
committed raw files contain a secret.

## 3. Independent language-model sessions

**OBS** ([`llm-sessions.md`](llm-sessions.md), verbatim). Four separate
Claude subagent sessions were run one after another. Each was told only a
human's request and the URL the previous one returned. None was told how
ACSP works, and none was told about proposals, capabilities or causation.

- **Session A** discovered the protocol from `/.well-known/acsp` and
  `/protocol.json`. It created a resource, recorded "81" as a finding with
  its reasoning, checkpointed, saved its credential to the human's file, and
  returned a continuation URL.
  - It reported that its own redaction missed the second copy of the secret
    in `owner_capability_url`, so the secret appeared once in its tool output.
- **Session B** received only the URL.
  - It verified the maths by enumeration, recomputed the state digest and
    checked the operation chain.
  - It read from `viewer` that it could only fork or propose.
  - It proposed its verification, citing A's operation, and returned a new URL.
  - Its own words: "I acted under my own session id … and did not
    impersonate the producer."
- **Session A2** was a new session for A's human, with only B's URL and the
  location of A's credential file. It re-verified everything, including the
  proposal's payload hash, accepted, and returned a URL without the credential.
- **Session C**, with no credential, reconstructed the full sequence,
  authority and causation.
  - It separated precisely what it verified itself from what it had to take
    on the service's word.

**OBS** (service side, [`raw/llm/service-state-after-sessions.json`](raw/llm/service-state-after-sessions.json)):

- 5 operations;
- the digest chain, versions, state digest, checkpoints and schemas all verify;
- no secret in any served document.

**INT.** This is the milestone's success criterion, met once, with one
model family, in one container. The receiving session was not told the
protocol. It found its authority in the resource and chose the permitted
operation, which is the behaviour the protocol was designed to make
discoverable. One run is an existence demonstration, not a rate.

## 4. What failed or surprised, with evidence kept

1. **Secret copies.** The create response carries the owner secret twice:
   in `owner_capability.token` and in `owner_capability_url` (a 0.1 field).
   A language-model session's redaction missed the second copy (Session A's
   report).
   - **Fixed after the run.** Responses that mint a secret now list the
     paths in `secrets.paths`; tested in `operational-security`.
   - Not changed: the 0.1 field itself, for compatibility.
2. **`/state?version=3` silently returned the current state** (Session C's
   report). A reader could mistake it for a historical state.
   - **Fixed after the run.** Historical query parameters are now refused
     with `400`, and the message points to the operation records and
     checkpoints.
3. **Idempotency keys across restarts** (harness, while building the
   scenario). A restarted process of the same session that reuses its key
   counter under the same capability is refused (`idempotency_key_reuse`).
   That is the correct behaviour, but it is a trap for clients. Documented
   in PROTOCOL.md §6.4.
4. **The recorded run's `dirty_worktree: true`.** This was a runner defect:
   repository state was read after the runner had written `raw/`. The tree
   was clean when the run started (`git status --porcelain` printed `0`
   immediately before). The runner now reads it first. The committed record
   is kept as written.
5. **Two dry runs** (debugging, nothing written) preceded the recorded run.
   They had the same outcomes and the same hash.

## 5. What this does and does not show

**Supported (observed):**

- Sessions communicated only through persisted operations and references.
- The receiving session's authority came only from its own credential.
- Provenance and lineage were reconstructable by a third party with no
  credential.
- Replays did not re-execute.
- Nothing secret moved.

**Not shown:**

- Autonomous forwarding. A human, or an orchestrator acting as one,
  carried every URL.
- That the service is honest. The digests are self-reported, and Session C
  said so.
- That the sessions were really distinct principals: both language-model
  sessions report the same model id, and session ids are asserted.
- That TOK-002's "independent verification" was independent: it is B's
  claim, accepted by A (Session C's point).
- Anything about memory, identity or model-state transfer. None occurred,
  by design.
- Performance or scale. This was one resource with a handful of operations.

## 6. Unresolved

- Past operational states are available only as digests, so a third party
  cannot recompute the digest of an arbitrary past version.
- Service honesty needs signatures or external anchoring.
- Session identity beyond capabilities: two sessions can claim the same
  model and nothing distinguishes them.
- A forwarding layer (webhook, queue, orchestrator) that carries
  continuation objects without a human, and what authority model it needs.
- Repetition: more runs, other model families, adversarial sessions (for
  example a B that tries to smuggle instructions to A through TOK content).
