# PROGRAM 001 — Experiment B: substrate change under one identity

Scenario: `p001-exp-b-substrate-switch` (`harness/scenarios/p001-experiments.ts`).
The procedural note in [PROGRAM-001.md](PROGRAM-001.md) applies here too.

## Question

Can one persistent identity move between computational substrates without
changing its identity?

This experiment does **not** assume that behaviour stays the same after the
move. Whether it does is exactly what it measures.

## Design

```
Agent S (principal-owned identity)
  ↓ session-a embodies (model-a)
substrate X = deterministic-calculator (IEEE-754 binary64)
  ↓
Scroll SCR-001:v1  mean3(a, b, c) = ((a + b) + c) / n,  symbol n = 3,  steps unpinned
  ↓ alias "mean3" → SCR-001:v1
6 executions on X (input battery below)
  ↓
checkpoint 1 → session-a releases; capability revoked
  ↓ session-b embodies (model-b), reads and verifies checkpoint 1
substrate Y = exact-rational-calculator
  ↓
same identity → same alias → same Scroll version → same 6 inputs on Y
```

The Scroll's steps are **not pinned** to a substrate, so the same content
executes on whichever substrate is current. (A pinned step would ignore the
switch. That is a design choice for Scroll authors, and it is recorded in the
Scroll's `dependencies`.)

Input battery (chosen to include cases where binary64 rounding is and is not
visible):

```
{1,2,3}  {0.1,0.2,0.3}  {1,1,1}  {10,0,0}  {1e16,1,-1e16}  {0.5,0.25,0.125}
```

## What is recorded

**Expected to be preserved** (each is an assertion): `agent_id`, the Scroll's
id/version/content hash, the alias binding, the X-era execution records
(unchanged), principal and ownership.

**Expected to change** (asserted as the design's intent): session, declared
model, current substrate.

**Measured, not assumed:** for each input, the output on X, the output on Y,
the nearest binary64 value of Y's exact result, whether they are numerically
equal, whether the representation changed, and the observation labels on the
substrate change.

Two assertions guard against assuming either outcome: at least one input
must disagree and at least one must agree. If the substrates agreed on
every input, or on none, the scenario would fail, and this document would
have to be revised rather than the result reinterpreted.

## Limits

Both substrates are deterministic calculators written for this program.
Only the representation of numbers differs between them. A move between
qualitatively different substrates (a model-backed session, a symbolic
system) is future work: Program 002 and 003.

Results: [PROGRAM-001-RESULTS.md](PROGRAM-001-RESULTS.md).
