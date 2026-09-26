# PROGRAM 001 — Experiment A: session termination and recovery

Program 001 (Agent Identity + Computational Substrate + Scroll) is the first
member of a sequence. Its governing question is:

> What computational phenomena emerge when persistent identity and state
> continuity are decoupled from the transient model substrate that performs
> each transition?

Experiment A tests a much narrower property.

**Procedural note.** The brief specified this procedure before
implementation. The harness that implements it
(`harness/scenarios/p001-experiments.ts`, scenario `p001-exp-a-kill-recover`)
was written in the same session as the substrate under test. That makes it
a specification fixed in advance, but not an independent pre-registration.

## Question

Can an externally persisted ACSP identity survive a session boundary while
retaining enough computational state to continue operating on the same
Scroll lineage?

## Hypotheses

**H1.** An identity represented independently of a transient session can
recover its persisted state after session termination and continue a
previously established computational trajectory.

**H0.** The apparent continuity depends on the original session and cannot
be reconstructed from the persisted ACSP state alone.

## System and actors

* **System under test:** ACSP/0.1 + `program-001`, the real HTTP handler
  (`createHandler`), PGlite (and, separately, PostgreSQL 16 and the Next.js
  server over HTTP).
* **Actors (SIMULATED):** deterministic harness code. `principal-alice`
  (human principal, owner), `session-a`, `session-b`, `session-c`. No model
  is run. `model` fields are declared labels (`model-a`, `model-b`).
* **Isolation:** an actor holds only the capabilities explicitly handed to
  it. Terminating a session means `release` + revocation +
  `actor.forget()`: the session retains nothing.

## Procedure (exact sequence)

```
CREATE IDENTITY        principal creates kind=agent_identity (owner capability stays with the principal)
CREATE SESSION A       principal delegates [embody, substrate, scroll, alias, execute, checkpoint, announce] to session-a; A embodies (model-a)
DISCOVER SUBSTRATE     A reads /r/{id}/substrates; selects deterministic-calculator
DISCOVER OPERATION     A reads /substrates/deterministic-calculator; finds the multiply contract
CREATE SCROLL          SCR-001:v1  multiply(a, b)
EXECUTE SCROLL         EXE-001  {a: 6, b: 7}
CREATE ALIAS           "multiply" → SCR-001:v1
CHECKPOINT             checkpoint 1
TERMINATE SESSION A    A releases EMB-001; principal revokes A's capability; A forgets everything
CREATE SESSION B       a fresh actor; principal delegates a capability bound to session-b
RECOVER IDENTITY       B opens the identity URL (HTML), follows <link rel=alternate> to JSON
READ CHECKPOINT        B reads identity.current_checkpoint, verifies its SHA-256
                       B embodies (model-b)
RESOLVE ALIAS          from the checkpoint snapshot AND live (GET, no credential)
REUSE SCROLL           execute via "multiply" with A's inputs
EXECUTE AGAIN          execute via "multiply" with new inputs
CHECKPOINT             checkpoint 2
```

**Arm 2 (ungraceful termination):** B then disappears without releasing.
Session C is authorized, is refused embodiment while B's is active, the
principal terminates B's embodiment, and C embodies and executes.

## Controlled variables

Same ACSP resource · same identity · same Scroll (SCR-001:v1) · same
checkpoint · same substrate (deterministic-calculator).

## Variable

Session embodiment: session-a (model-a) → session-b (model-b) → session-c.

## Measurements

| Measurement | How |
|---|---|
| identity recovered | B's document `identity.agent_id` = the identity A embodied |
| checkpoint recovered | B recomputes `sha256(canonical(snapshot))` and compares it with A's checkpoint hash |
| Scroll recovered | the snapshot's `SCR-001:v1.content_sha256` equals the hash in A's execution record |
| alias resolved | resolution from the snapshot equals live resolution (no credential, no session) |
| execution reproduced | B's outputs and operation sequence equal A's for the same inputs |
| provenance preserved | executions attributed to (session, embodiment, model) without ambiguity |
| session changed | session-a → session-b; model-a → model-b |
| observations | transition labels on B's embodiment |
| request count | HTTP requests made by B from creation of session B to its checkpoint |

"It felt continuous" is not a measurement.

## Falsification criteria

The experiment fails (H1 rejected for the run) if any of these holds. Each
is an assertion in the scenario:

1. the identity cannot be recovered;
2. the Scroll lineage is lost;
3. alias resolution depends on the terminated session;
4. execution provenance is ambiguous;
5. the new session must impersonate the old session (any event after A's
   release with actor `session-a`, or B needing A's id or capability);
6. authority leaks across sessions (A's revoked capability still works, or B
   can act as A).

## What a pass would and would not show

A pass shows that persistent computational identity and state can survive
session termination **when represented externally by the protocol**. It
says nothing about model-independent intelligence, memory, or
"continuity" in any experiential sense. The actors are deterministic code.

Results: [PROGRAM-001-RESULTS.md](PROGRAM-001-RESULTS.md).
