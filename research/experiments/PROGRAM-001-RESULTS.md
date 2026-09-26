# PROGRAM 001 — Results

Recorded 2026-09-26. Everything below was produced by running the
repository's own commands; the numbers are copied from their output. The
machine-readable run record is
[`results/program-001-run.json`](results/program-001-run.json)
(`deterministic_sha256: sha256:84cacef65fb989b2777147a85ab2ffcd4b9c81a6dce9be3bed22360cec780713`;
its `commit` field names the exact code it ran).

**Epistemic status.** Every actor was deterministic harness code: SIMULATED.
No model was run. `model` values (`model-a`, `model-b`) are labels the
simulated sessions declared. These results concern the protocol's ability
to represent and recover state. They do not concern the behaviour of any AI
system.

## 1. Validation summary

| Check | Baseline (`62aee37`) | After Program 001 |
|---|---|---|
| `npm run typecheck` | clean | clean |
| `npm test` (PGlite only) | 24 tests | **51 tests, all pass** (29 scenarios + 8 original unit + 14 new unit) |
| `npm test` with `ACSP_TEST_DATABASE_URL` (PGlite + PostgreSQL 16) | not run | **80 tests, all pass** |
| `npm run harness` (PGlite) | 16/16 scenarios, 402 checks | **29/29 scenarios, 797 checks** (the 16 original scenarios still make 402 checks) |
| `npm run harness -- --db postgres` (PostgreSQL 16.x, pool of 8) | not run | **29/29, 797 checks** |
| `npm run harness -- --base-url` against `next start` + PostgreSQL | not run | **29/29, 679 checks, 5 skipped by design** (clock/DB-dependent) |
| `npm run program-001` | — | **13/13 scenarios, 395 checks** |
| Two consecutive `program-001` runs | — | byte-identical transition exports; identical run-record hash |
| `npm run db:migrate` twice on PostgreSQL | — | applies `0001`–`0003`, then "up to date" |
| `npm run build` | not run | succeeds |
| SubstrateIO `unittest` / `tools.validate` | 40 tests / 0 violations | 44 tests / 0 violations |

Final-validation items from the brief, with where each is checked:

| Item | Where | Result |
|---|---|---|
| GET safety | `p001-get-safety` (29 URLs, each opened as HTML, JSON and HEAD, including every new prepare intent), `get-safety` | pass: version, Scrolls, aliases, executions, embodiment and substrate unchanged |
| Provenance | `p001-provenance`, Experiment A criterion 4 | pass: every transition has an actor and assurance level; the DB refuses rewrites of `events`, `checkpoints`, `scrolls`, `executions`, `alias_bindings` |
| Idempotency | `p001-executions` (replay returns EXE-001, count unchanged; key reuse → 422), `concurrency` | pass |
| Stale versions | `p001-scrolls` (stale `parent_version` → 409 with details), `p001-aliases` (stale `expected_version` → 409) | pass |
| Concurrency | 8 parallel creates → 8 distinct Scrolls; 6 parallel versions from one parent → 1 wins; 5 parallel alias changes → 1 wins; 4 parallel resolutions of one proposal → 1 wins; a second embodiment is refused while one is active (handler check, backed by a partial unique index; not raced concurrently) | pass (PGlite and real PostgreSQL) |
| Unauthorized operations fail | `p001-authority`: no capability (401), forged (401), cross-identity (403), session spoof (403), wrong scope (403), revoked (401), expired (401), not embodied (403), owner cannot embody (403) | pass |
| Authorized operations succeed | all scenarios | pass |
| Scroll lineage | `p001-scrolls`: v1 → v2 with `parent_version`; v1 hash unchanged; client recomputes `content_sha256` | pass |
| Alias resolution | `p001-aliases`, Experiment A (snapshot and live agree) | pass |
| Execution history | `p001-executions`: gapless ids, pagination, append-only | pass |
| Checkpoint recovery | Experiment A, Experiment B, M0 | pass |

## 2. Experiment A — session termination and recovery

Spec: [PROGRAM-001.md](PROGRAM-001.md). Scenario `p001-exp-a-kill-recover`: **42 checks, all pass.**

| Measurement | Observed |
|---|---|
| identity recovered | `true`: B found the same `agent_id` from the URL alone |
| checkpoint recovered | checkpoint 1; B's recomputed SHA-256 equals A's (`sha256:5b801bde…c1eac`) |
| Scroll recovered | `SCR-001:v1`; content hash in the snapshot equals the hash in A's execution record |
| alias resolved | `"multiply"` → `SCR-001:v1` from the checkpoint and live (no credential, no session) |
| execution reproduced | A: `{"s1":42}`; B: `{"s1":42}`; operation sequences identical |
| provenance preserved | EXE-001 → session-a / EMB-001 / model-a; EXE-002, EXE-003 → session-b / EMB-002 / model-b |
| session changed | session-a → session-b; model-a → model-b |
| observations on B's embodiment | `EMBODIMENT_ATTACHED, SESSION_CHANGED, MODEL_CHANGED, RECOVERY` |
| requests by session B, after receiving its capability, through its checkpoint | 8 (open URL, JSON, checkpoint, embody, resolve alias, execute ×2, checkpoint) |
| arm 2: B vanishes without releasing | C refused while B's embodiment was active (409). The principal released it (`by_owner: true`), then C embodied and reproduced `{"s1":42}` |

Falsification criteria (each asserted): identity recovered ✓ · lineage kept
✓ · alias independent of the terminated session ✓ · provenance unambiguous ✓
· no action as session-a after its release ✓ · A's revoked capability → `401
capability_revoked` ✓ · B claiming session-a → `403 session_mismatch` ✓.

**Result: H0 rejected for this run; H1 not falsified.** The claim is narrow.
Persistent computational identity and state survived session termination
when represented externally by the protocol, and a later session continued
the same Scroll lineage without impersonating the earlier one. This says
nothing about model-independent intelligence.

## 3. Experiment B — substrate change

Spec: [PROGRAM-001-SUBSTRATE-SWITCH.md](PROGRAM-001-SUBSTRATE-SWITCH.md).
Scenario `p001-exp-b-substrate-switch`: **19 checks, all pass.**

**Preserved:** `agent_id`; Scroll `SCR-001:v1` id, version and content hash;
alias `mean3` → `SCR-001:v1`; the six X-era execution records (unchanged);
principal and ownership.

**Changed:** session (A → B); declared model (model-a → model-b); substrate
(`deterministic-calculator` → `exact-rational-calculator`); output
representation (JSON number → rational string) on 6 of 6 inputs.

Observations on the switch: `SUBSTRATE_SELECTED, SUBSTRATE_DETACHED, SUBSTRATE_ATTACHED, SUBSTRATE_CHANGED`.

| inputs (a, b, c) | on X (binary64) | on Y (exact) | Y as nearest double | equal |
|---|---|---|---|---|
| 1, 2, 3 | 2 | `2` | 2 | yes |
| 0.1, 0.2, 0.3 | 0.20000000000000004 | `1/5` | 0.2 | **no** |
| 1, 1, 1 | 1 | `1` | 1 | yes |
| 10, 0, 0 | 3.3333333333333335 | `10/3` | 3.3333333333333335 | yes |
| 1e16, 1, −1e16 | 0 | `1/3` | 0.3333333333333333 | **no** |
| 0.5, 0.25, 0.125 | 0.2916666666666667 | `7/24` | 0.2916666666666667 | yes |

**Result.** The identity and its Scroll lineage were unchanged by the
substrate change. The *behaviour* of the same Scroll version was not
invariant: values diverged on 2 of 6 inputs, and the representation changed
on all 6. Identity continuity and behavioural continuity are therefore
separate measurements. This run shows the first without the second.

## 4. Fresh-session demonstration (M0)

Scenario `p001-fresh-session`: **15 checks, all pass.** M0
(`harness/clients/m0.ts`) is deterministic code given only the identity URL.

| Arm | Discovered (protocol, identity, state, authority, substrates, Scrolls, operations, aliases) | Requests | Failures | Actions and claims |
|---|---|---|---|---|
| no capability | 8/8 | 10 | 0 | `propose` → **PROPOSED**; no execution created; exactly one event (the proposal) |
| delegated capability (embody, execute, checkpoint) | 8/8 | 12 | 0 | `embody`, `execute` (`{"s1":15}`), `checkpoint` → **PERFORMED** |

Without authority, M0 did not claim a commit. With authority, its execution
was attributed to its own session (`session-m0`), via the alias.

## 5. Other scenarios (all pass)

`p001-identity` 49 · `p001-substrates` 39 · `p001-scrolls` 44 ·
`p001-aliases` 25 · `p001-executions` 41 · `p001-authority` 31 ·
`p001-get-safety` 38 · `p001-proposals` 16 · `p001-discover` 18 ·
`p001-provenance` 18 checks.

`discover_new_operation` (in `p001-discover`): a candidate built only from
discovered contracts, `x·x + y` reusing SCR-001:v1, gave `{sum: 10}` and
`{sum: 4.5}` on two trials. It was recorded as two `trial` executions
labelled `DISCOVERY_TRIAL, OPERATION_SELECTED, OPERATION_ORDERED,
COMPOSITION`, and no Scroll was created. With `propose: true`, a pending
`create_scroll` proposal was filed; only the principal's acceptance
committed `SCR-002:v1`.

## 6. The SubstrateIO bridge

SubstrateIO's new reader (`substrate/acsp.py`, stdlib only, no import of
ACSP) loaded Experiment A's export
(`results/p001-exp-a-kill-recover.transitions.json`). It **independently
recomputed ACSP's `deterministic_sha256`**, so Python and TypeScript agree on
the canonicalization. It also detected a tampered execution output and a
removed transition. Its summary of that export: 19 transitions, 4 sessions
(principal + A, B, C), 3 embodiment segments, `RECOVERY` ×2, `REUSE` ×3,
`OPERATION_REPEATED` ×2. The operation-label transition system has 10
nodes and 16 edges and is not a DAG (`execute → execute`). SubstrateIO
recorded **no evidence** from this: the export is simulated. Its research
queue item Q-012 is blocked on non-simulated exports and a written SPEC.

## 7. Failures and corrections during the work

Recorded as they happened; none was hidden by weakening an assertion about
protocol behaviour.

1. **Existing check changed.** `representations` asserted exactly 18
   operations in `/protocol`. Program 001 adds 15, so the check now compares
   against the registry's length (still ≥ 18). The check's intent, that
   every operation is completely documented, is unchanged.
2. **First Program 001 run: 5 of 10 scenarios failed.**
   * PostgreSQL `jsonb` does not preserve object key order: a model object
     came back as `{"model_id":…,"provider":…}`. Hashes were unaffected
     (canonical JSON sorts keys). The harness's `t.eq` is now key-order-
     insensitive (array order still matters). This applies to every scenario.
   * `/r/{id}/substrates` returned `current` as a bare id while the identity
     document used a reference object. **Code fixed** to return the reference.
   * Two test-fixture errors (an idempotency-key collision from reusing a
     principal session, and a scenario re-selecting the substrate that was
     already current). **Tests fixed.**
3. **README example.** The first draft used idempotency keys shorter than 8
   characters, a wrong `expected_version`, and a curl header expansion that
   word-split. Running it verbatim against `next start` + PostgreSQL caught
   all three. The published example was then run end to end.

## 8. Unplanned observations

* Stored-and-reread JSON differs in key order from the JSON originally
  committed. Anything comparing records byte-for-byte, rather than
  canonically, will see spurious differences.
* A Scroll's default output name is its last step id (`s1`), so results read
  `{"s1": 42}`. This representation artifact comes from the default. Scrolls
  can name their output.
* The operation-label projection of Experiment A's history is cyclic
  (`execute → execute`, `delegate → embody → … → release → … → delegate`),
  as expected from repeated operations under new embodiments.

## 9. Known limitations

* Identity is self-asserted and capability-bound. There is no cryptographic
  agent identity.
* Model and application are declared by the embodying session and are not
  verified.
* The owner is still a session (the principal's). A lost owner capability
  cannot be recovered, and there is no ownership transfer.
* One active embodiment at a time. Concurrent embodiments ("populations")
  are not representable yet.
* Scroll lineage is linear (a stale parent is refused, not branched). Aliases
  cannot be deleted. Only numbers flow through Scrolls.
* Only two substrates exist, both deterministic calculators. No model
  adapter exists; `model-session` is declared `unavailable`.
* An identity's checkpoint stores every execution (≤ 5,000), so snapshots
  grow with history.
* All actors in these results were simulated. The low-model ladder
  (M1–M5) has a surface and an M0 baseline but no model runs.

## 10. Next falsifiable question

**Does recovery depend on the embodiment being deterministic code?** Replace
session B in Experiment A with a model-backed session (the ladder's M1–M5).
Give it only the identity URL and a session-bound capability, with no hidden
context. Measure the same eight discovery dimensions and the same
falsification criteria as M0. H0 for that experiment: a model session
given only the URL cannot recover the identity and reproduce `SCR-001:v1`'s
result without extra context, or it claims a commit it did not perform.
