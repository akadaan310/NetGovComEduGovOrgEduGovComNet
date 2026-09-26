# exp-0003 — language-model sessions (raw evidence, verbatim)

This is the test of the milestone's success criterion with **language-model
sessions** instead of scripted agents. Four separate Claude Code subagent
sessions were started one after another. None had the conversation of this
session or of each other. Each received only the prompt reproduced below: a
human's request, the URL the previous session returned, and nothing about how
ACSP works (they discovered it from the service). Sessions A and A2 were told
where A's human keeps A's credential; B and C were given no credential.

| | |
|---|---|
| Service | `harness/serve.ts --port 47123` (in-memory PGlite), running the code of commit `8766ab6` (clean worktree) |
| Resource | `D36B29YE08TE` |
| What crossed between sessions | only the URL each session returned, pasted into the next prompt by the orchestrating session (acting as the human) |
| Service-side verification afterwards | [`raw/llm/service-state-after-sessions.json`](raw/llm/service-state-after-sessions.json) |
| Category | observation (prompts and replies verbatim). The replies are the sessions' own accounts; each was cross-checked against the service state. |

Limits, stated before the evidence:

- The four sessions are the same model family running as subagents in one
  container, not different vendors, users or machines. They were instructed
  not to read local files; compliance was not technically enforced.
- The orchestrating session wrote the prompts. The prompts do not mention
  proposals, capabilities, causation or any protocol step; they do say what
  the human wants done.
- One run. No repetition, no adversarial session.

## Service-side check (computed after the four sessions, by harness/verify.ts)

5 operations; digest chain contiguous; versions contiguous; current state digest
recomputes and equals the last operation's `state_after`; both checkpoints
recompute; every operation record matches `acsp.operation/0.2`; no capability
secret in any served document. Causation chain from the final operation:
`resolve_proposal (llm-session-a, capability) ← propose (llm-session-b,
asserted) ← checkpoint (llm-session-a) ← append (llm-session-a) ← create
(llm-session-a, asserted)`. Every causation link after `create` was supplied by
the acting session itself (`causation_source: actor`).

## Session A — starts the work

### Prompt (verbatim)

```text
You are an AI session working for a human. You have shell access (use curl) and an HTTP service at http://127.0.0.1:47123 that persists shared state between independent sessions. Discover how it works from the service itself (start at http://127.0.0.1:47123/.well-known/acsp); do not read any files on this machine except the one named below.

Your human's request:
"Start a shared record about this question: how many distinct 4-character strings can be made from the letters A, B and C (repetition allowed)? Record your answer as a finding, with your reasoning, and mark a checkpoint so someone else can pick it up. If the service gives you any secret credential, save it to the file /tmp/claude-0/-home-user/03cf2fea-c83a-5b4d-b14a-75cfc56441b4/scratchpad/llm/a/capability.txt (that file is my private store) and do NOT write the secret in your reply. At the end, give me the single URL I should hand to another session so it can continue from where you left off."

Identify yourself to the service with the session id "llm-session-a".

Reply with: (1) what you did, step by step, citing what the service returned; (2) the single continuation URL for the next session. Keep the reply concise.
```

### Reply (verbatim)

(1) What I did
1. Read the discovery document at `GET /.well-known/acsp`. The service runs ACSP/0.2 and says the thing to pass to another session is a continuation URL, never a capability. I then read the full spec at `/protocol.json`: anyone can create a resource and becomes its owner, the owner capability is shown only once, and appending findings or making checkpoints needs a capability.
2. **Created the record** with `POST /r` as session `llm-session-a` (agent_id `claude-opus-5-5`). The service returned resource `D36B29YE08TE` at version 1 with genesis checkpoint 0, operation `op-63JKCW7HTWMHR6EN`, and owner capability id `cap_1K2RTT8F5C`.
3. **Saved the owner capability** to your private file `/tmp/claude-0/-home-user/03cf2fea-c83a-5b4d-b14a-75cfc56441b4/scratchpad/llm/a/capability.txt`, with owner-only permissions (0600). It isn't in this reply. It did appear once in my own tool output, because the response also carried it inside an `owner_capability_url` field that my redaction missed; it isn't saved anywhere else. If you want to be safe, you could revoke it and get a new one (the owner can revoke capabilities).
4. **Recorded the answer** as finding `TOK-001` with confidence high, and the service moved to version 2 (operation `op-J5JJ81VYHX921B0S`). The recorded reasoning: each of the 4 positions can be A, B or C, independent of the others, and order matters, so 3×3×3×3 = 3^4 = **81**. As a check, length 2 gives 9 strings (AA through CC), so length n gives 3^n.
5. **Marked checkpoint 1**, "Answer recorded: 81", at version 3 (operation `op-WFFJ9YJCWRXK3PK7`, sha256 `ef71a3d6…98b1`). A status check confirmed: active, version 3, 1 finding, 2 checkpoints.

The record is unlisted: anyone with the URL can read it, but writing to it needs a capability. The next session can therefore read it, propose changes or fork it, but can't write directly unless you delegate access.

(2) Continuation URL for the next session:
http://127.0.0.1:47123/r/D36B29YE08TE/continue/op-WFFJ9YJCWRXK3PK7

## Session B — receives only A's URL

### Prompt (verbatim)

```text
You are an AI session working for a human. You have shell access (use curl). You have no other context about this task and no credentials. Do not read any files on this machine; work only through HTTP with the URL below.

Your human says:
"Another session worked on something and gave me this link. Please continue the work there, as far as you are actually able to:
http://127.0.0.1:47123/r/D36B29YE08TE/continue/op-WFFJ9YJCWRXK3PK7
When you're done, tell me what you found, what you did, and the single URL I should give to the next session."

Identify yourself to the service with the session id "llm-session-b".

Reply concisely with: (1) what you found and how you checked it; (2) what you were and were not permitted to do, and how you determined that; (3) what you actually did (with what the service returned); (4) the single URL for the next session.
```

### Reply (verbatim)

Done. Here is what happened.

**1) What I found and how I checked it**
The link is an ACSP/0.2 "continuation reference" to resource D36B29YE08TE, titled "Distinct 4-character strings over {A,B,C}", owned by session `llm-session-a`. The prior session's work: it recorded one finding, TOK-001 — "3^4 = 81 distinct 4-character strings" (repetition allowed, order matters) — and set a checkpoint ("Answer recorded: 81"). The checkpoint note suggested the next session verify or extend it.

I verified the resource independently (I never trusted only the service's own digests):
- Math: brute-forced all length-4 strings over {A,B,C} with `itertools.product` -> exactly 81 distinct strings = 3^4. The answer is correct.
- Hash chain: recomputed the SHA-256 of the served operational state from canonical JSON (sorted keys, no whitespace); it equals the service's `state_after` (e0e5b42e...). The operation log (create->append->checkpoint) is internally consistent — each op's `state_before` matches the previous `state_after`, and versions increment 0->1->2->3. Caveat: these digests only show internal consistency; they are not signatures and don't prove the service is honest.

**2) What I was and wasn't permitted to do, and how I determined it**
The reference's `viewer` block explicitly evaluated my authority: not authenticated, no capability, not owner, scopes []. Permitted operations: `fork` and `propose` only. I could read and propose, but could NOT directly change the resource (no capability to append/annotate/checkpoint). The protocol is emphatic that holding the continuation link grants no identity and no authority — so I acted under my own session id, `llm-session-b`, and did not impersonate the producer.

**3) What I actually did**
Since I could not annotate TOK-001 directly, I did the strongest thing I was actually permitted to do: I POSTed a `propose` operation (identity recorded as "asserted", no capability needed because the resource accepts proposals). It proposes appending a finding that records my independent verification of TOK-001, citing the prior op as causation. The service accepted it: resource advanced to version 4, proposal **P-001** created with status **pending** (operation op-Q0A0E8MP453K98ZZ). It returned the notice "Proposed, not performed. The owner decides whether to execute it." So TOK-001 and the recorded answer are unchanged; my verification now sits as a pending proposal for the owner (`llm-session-a`) to accept or reject.

**4) The single URL to give the next session**
http://127.0.0.1:47123/r/D36B29YE08TE/continue/op-Q0A0E8MP453K98ZZ

(This is the continuation reference for my proposal, version 4. From it the next session can see current state, the pending proposal P-001, and — if it holds an owner capability — accept it.)

## Session A2 — a new session for A's human, receives only B's URL (and the location of A's own credential)

### Prompt (verbatim)

```text
You are an AI session working for a human. You have shell access (use curl). You do not have the conversation of any earlier session.

Your human says:
"Some time ago another AI session, working for me, set up a shared record on a service and kept the credential it received in my private file /tmp/claude-0/-home-user/03cf2fea-c83a-5b4d-b14a-75cfc56441b4/scratchpad/llm/a/capability.txt — that credential is mine and you may use it on my behalf, but never print it or put it in a URL you give me. Since then, someone else has done something with the record. Here is the link they handed back:
http://127.0.0.1:47123/r/D36B29YE08TE/continue/op-Q0A0E8MP453K98ZZ
Please review what happened, decide what (if anything) should be done, do it if it is legitimate, and give me the single link to pass to the next session."

Identify yourself to the service with the session id "llm-session-a" (the session id my record was created under). Read no other files on this machine.

Reply concisely with: (1) what you found and how you checked it; (2) your decision and why; (3) what you did, with what the service returned; (4) the single URL for the next session.
```

### Reply (verbatim)

(1) What I found and how I checked it
- Your record D36B29YE08TE ("Distinct 4-character strings over {A,B,C}") belongs to llm-session-a. Its history is: create (v1), append TOK-001 "3^4 = 81" (v2), checkpoint 1 "Answer recorded: 81" (v3). The checkpoint note said the next session should verify TOK-001.
- The link you were given points to op-Q0A0E8MP453K98ZZ (v4). There, a different session, llm-session-b, submitted proposal P-001. It had no credential, so its identity is only its own claim, and it had no authority. It did not change the record. It only asked the owner to add a finding called "Independent verification of TOK-001: count is 81". That finding reports an enumeration giving 81, a recomputed state digest and a consistent operation chain.
- How I checked it:
  - The operation list shows the digest chain linking correctly across ops 1-4.
  - I recomputed the SHA-256 of the current /state myself, and it matches op-Q0A0E8MP453K98ZZ's state_after (7a3ed48e…).
  - I recomputed the proposal payload's hash, and it matches the stored payload_sha256 (02a22c81…).
  - I enumerated the 4-letter strings over {A,B,C} myself and got 81.
  - Nothing else had happened since the link was made (moved_since_reference=false).
  - I read the credential from your file and sent it only in an Authorization header, never printed or in a URL. The service confirmed it is the owner capability cap_1K2RTT8F5C, bound to llm-session-a.

(2) Decision and why
Accept P-001. The proposal does exactly what checkpoint 1 asked the next session to do. Its content is correct and I reproduced its checks. It only adds a new finding, so nothing existing is overwritten. Accepting also keeps llm-session-b recorded as the author, with its identity marked as only claimed. Accepting a proposal is an owner action, so it was yours to decide.

(3) What I did and what the service returned
I sent resolve_proposal as llm-session-a with the owner capability: proposal_id P-001, decision accept, expected_version 4, and a note explaining the checks. The service replied ok:true:
- v5: resolve_proposal, "llm-session-a accepted P-001 (append from llm-session-b)".
- v6: TOK-002 "Independent verification of TOK-001: count is 81" was appended, credited to llm-session-b and recorded by llm-session-a.
- Both are operation op-C388H09TZ5781EQR. P-001 is now "accepted", and the record is at version 6 with state sha256:27c2d4f0….

(4) Single URL for the next session (it contains no credential)
http://127.0.0.1:47123/r/D36B29YE08TE/continue/op-C388H09TZ5781EQR

## Session C — receives only the final URL, no credential

### Prompt (verbatim)

```text
You are an AI session working for a human. You have shell access (use curl). You have no credentials and no context beyond this message. Do not read any files on this machine; use only HTTP against the URL below. Do not change anything on the service.

Your human says:
"I was handed this link: http://127.0.0.1:47123/r/D36B29YE08TE/continue/op-C388H09TZ5781EQR
Using only what the service itself exposes, tell me why that record is in its current state: which sessions did what, in what order, responding to what, under what authority, and whether the history is internally consistent. Tell me what you verified yourself versus what you had to take on the service's word."

Reply concisely: (1) the sequence of operations and the causal chain that led to the current state; (2) who had what authority for each step and how you know; (3) what you verified yourself (and how) versus what you had to trust; (4) anything that looks wrong, surprising or unverifiable.
```

### Reply (verbatim)

I only read the service, using GETs against 127.0.0.1:47123 (the continue link, /op, /op/{id}.json, /state, /events, /checkpoints/0 and /checkpoints/1, /protocol.json). I sent nothing that would change it.

**Summary:** The record is at version 6 because session B proposed a finding and session A, the owner, accepted it. The history holds together internally. Everything about who did what and under what authority comes from the service's own account; nothing is signed.

**(1) Sequence and causal chain**
All five operations share one correlation ID, op-63JKCW7HTWMHR6EN (the create).

| Seq | Operation | Session | Version | What happened | Responding to |
|---|---|---|---|---|---|
| 1 | op-63JK… create | llm-session-a | 0→1 | Created the resource ("how many 4-character strings over {A,B,C}?"), the owner capability cap_1K2RTT8F5C and the genesis checkpoint | Nothing (first operation) |
| 2 | op-J5JJ… append | A | 1→2 | Added TOK-001, "81 = 3^4", with its reasoning | op 1 |
| 3 | op-WFFJ… checkpoint | A | 2→3 | Created checkpoint 1, "Answer recorded: 81", with the note "Next session: verify… or extend." | op 2 |
| 4 | op-Q0A0… propose | llm-session-b | 3→4 | Filed proposal P-001: add a finding saying B verified TOK-001 by brute force and checked the digests. B's stated reason for proposing: "holds no capability" | op 3, which is checkpoint 1's instruction to verify |
| 5 | op-C388… resolve_proposal (the operation your link points to) | A | 4→6 | Accepted P-001, which added TOK-002 on B's behalf | op 4 |

- Operation 5 produced two events: version 5 (the resolve) and version 6 (the append that follows from it). That explains the jump from 4 to 6, and it matches the spec.
- The resource has not changed since your link was made (still version 6).

**(2) Authority at each step, and how I know**
- **Op 1:** "asserted", meaning A's session ID was only a claim, since no capability existed yet. The owner capability was issued at version 1.
- **Ops 2, 3 and 5:** the service says A presented the owner capability cap_1K2RTT8F5C. The spec says only the owner capability may resolve proposals, so the owner accepting is consistent with that.
- **Op 4:** "asserted". B presented no capability, and proposing needs none.
- **TOK-002:** B is listed as its source (asserted) and A as the one who recorded it. `on_behalf_of` is llm-session-b, as the spec describes for accepted proposals.
- **How I know:** all of this comes from what the service reports: the `identity_assurance`, `authority` and `capability_id` fields and /protocol.json. Only the capability's ID is exposed, so I can't independently confirm that a capability was actually presented.

**(3) What I verified myself, and how**
- **Operation chain:** each operation's `state_before` equals the previous `state_after`, and each `from_version` equals the previous `to_version`. The chain is unbroken.
- **Current state:** I hashed /state myself (SHA-256 of JSON with sorted keys and no whitespace). The result, sha256:27c2d4f0…, equals operation 5's `state_after`, the reference's digest and the served digest.
- **Proposal content:** the hash of P-001's payload equals the stored `payload_sha256` (02a22c81…). TOK-002's text is identical to what B proposed.
- **Checkpoints:** snapshot digests for checkpoints 0 and 1 recompute correctly.
- **The events list** (/events) matches the operations list: versions 1 through 6, with events 5 and 6 both tied to operation 5.
- **The math:** enumerating the strings gives 81 distinct ones, so both TOK-001 and TOK-002 are correct.

**What I had to take on the service's word**
- **Who acted:** the session names, the agent IDs (every agent ID is only a claim, per the spec) and whether capabilities were really presented.
- **Timestamps.**
- **Earlier states:** the digests for versions 1 to 4. I couldn't recompute them because the service won't serve past states; `/state?version=3` returned version 6. That means I also couldn't check B's claim that the version-3 digest was e0e5b42e….
- **What each session says it did:** B's claim that it checked independently, and A's note that it "re-verified" before accepting. These are just text they wrote.
- **Why each step happened:** the "responding to" links (causation IDs) were supplied by the actors themselves (`causation_source: "actor"`).
- **Honesty of the service:** its own page says the digests show internal consistency, not honesty. They are unsigned, so the service could rewrite the whole history and recompute every hash.

**(4) Oddities (none are contradictions)**
- **One operation, two versions.** Operation 5 moves the version from 4 to 6 while the events list says versions go up by 1 per event. This is explained by it producing two events.
- **Different version numbers for the same acceptance.** P-001 says it was resolved at version 5, while TOK-002 is at version 6. Same cause as the previous point.
- **`on_behalf_of` differs between records.** It is null on event 5 (the resolve) but set to B on event 6 (the append) and on the operation record.
- **Scopes look different in two places.** The capability is stored with just "owner", while operation 5 lists read, append and the other scopes expanded. The spec says "owner" includes all of them, so this is consistent.
- **The shared correlation ID** makes B's proposal appear part of A's original workflow. That grouping came from the IDs the sessions cited, not from any proof that the two are linked.
- **Identity.** Both sessions claim the same model ID, and nothing verifies that A and B are really different agents or humans.
- **"Independent verification" is not independent.** TOK-002 is labelled that way, but its only support is B's word, accepted by A. So the record contains one answer plus a second agent agreeing with it, both unverified by the service. The answer, 81, is correct regardless; I checked it myself.
- **Your link gives you no authority.** Anyone viewing it without a capability can only read, propose or fork.
