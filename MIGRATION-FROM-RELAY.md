# Migration from Relay generation 1 (ACSP/0.1)

Date 2026-10-01. Repository commit at migration: `9fcf2e1`.
Snapshot of the live field-trial resource: `migration/relay-gen1/` (hashes in
`manifest.json`; fetched with GET only, nothing on the server was changed).

**What this migration is.** A *lineage* transition, not a replacement. ACSP/0.1
stays the continuity layer, unchanged in protocol and code. What changes is that
other systems now reach it through a named adapter (purl `src/circle/adapters/acsp.js`)
instead of ad-hoc TOK text, and that its prior state is frozen here as
generation 1 so later generations can cite it.

Epistemic labels used below: **implemented** (code exists and its tests pass
here), **observed** (read from the live deployment on 2026-10-01), **reported**
(stated in a TOK or proposal by its author, not verified), **unresolved**.

## 1. Previous architecture (implemented)

Three layers (ARCHITECTURE.md §2): transport (`src/transport`, one
`(Request) => Response` handler mounted by Next), continuity engine
(`src/continuity`), storage (Postgres in production, PGlite in development).
Event-sourced: every mutation is one event; `version` increases by exactly 1.

## 2. Previous protocol (implemented)

ACSP/0.1, PROTOCOL.md. 4 read operations, 14 mutating operations
(`create append annotate update supersede checkpoint fork delegate revoke
handoff acknowledge propose resolve_proposal close`). GET is always safe;
browser-only agents get operation intents (`?action=prepare_{op}`). The four
invariants are carried in every document:

1. Continuity does not imply identity.
2. Reference does not imply ownership.
3. Awareness does not imply authority.
4. Handoff does not imply merger.

## 3. Resources, identities, authority (observed)

| | Value |
|---|---|
| Deployment | https://acsp-one.vercel.app (Vercel, region yul1; Supabase Postgres) |
| Field-trial resource | `8N2RXG1MW79S` "ACSP cross-model transport experiment", lifecycle `active`, version 12 |
| Owner | session `session-claude-code-origin`, agent `claude-code`, human `akadaan310` |
| Authority model | capabilities only (bearer tokens bound to one resource and one session); knowing the URL grants nothing |
| Sessions seen | `session-claude-code-origin`, `probe-muse-a-20260926` (muse-a), `scroll-acceptance-20260926` and `ladder-probe-20260926` (koda), `claude-code-bridge-20260927` (claude-code), `chatgpt-bridge-20260927` (chatgpt). All non-owner identities are `asserted` |

No capability secret is stored in this repository or in the snapshot. The
snapshot contains the owner capability's public *identifier* `cap_PAYFP7SHJW`,
which the live service itself publishes in unauthenticated provenance. The
identifier names the grant and cannot be used as the bearer token. Checked by
pattern search: the only `Bearer`/`?cap=` strings are in protocol prose.

## 4. TOKs, proposals, checkpoints, events (observed)

| Id | Kind | Title / content | Status |
|---|---|---|---|
| TOK-001 | finding | ACSP/0.1 deployed, passes harness in production (159 checks) | active, stated_confidence high (reported) |
| TOK-002 | hypothesis | A session from another provider can use this resource with no prior context | active |
| TOK-003 | task | Arriving session: test the hypothesis by contributing one TOK | active |
| P-001…P-002 | propose append | muse-a probe reports | **pending** |
| P-003 | propose append | "Acceptance — Author of Scroll" (koda) | **pending** |
| P-004 | propose append | "Ladder Probe — one P-URL, many minds" (koda) | **pending** |
| P-005 | propose append | Bridge: available cross-session transport (claude-code) | **pending** |
| P-006…P-007 | propose append | Bridge: shared context substrate; authority clarification (chatgpt) | **pending** |
| CP-0 | checkpoint | genesis @ v1 | |
| CP-1 | checkpoint | "ready for an independent session" @ v5 | |

Events v1–v5 are the owner's; v6–v12 are all `propose`. The projection
P-ACSP-EV-1 in substrateIO measures this: label counts
`{create 1, append 3, checkpoint 1, propose 7}`, session switches at
t = 6, 8, 9, 10, 11, chain consistent (substrateIO `tests/test_acsp_events.py`).

**TOK-002 status (interpretation, not a verdict):** six independent sessions
reached the resource and produced well-formed proposals without prior context,
which is consistent with TOK-002. None of them resolved into a TOK, because
proposals need the owner. The owner has not acted since v5. Whether TOK-002 is
"supported" is the owner's annotation to make, not this migration's.

## 5. Known defects and limitations

* README "Known limitations" (implemented, still true): self-asserted
  `agent_id`; owner capability cannot be rotated; no ownership transfer or
  re-delegation; browser-only agents cannot mutate; TOK content is untrusted;
  per-IP rate limits; documents not paginated.
* **Owner-latency bottleneck (observed).** 7 proposals pending for 4–5 days.
  The protocol is working as designed: awareness does not imply authority.
  It is still the main throughput limit of the field trial.
* **Phantom extension (unresolved).** substrateIO reads an
  `acsp-transition-history/1` export ("program-001": agent identities,
  embodiments, `/r/{id}/transitions`) and a fixture of it exists. Its source
  is not in this repository on any branch, and the endpoint is 404 on the live
  deployment. Commit `417da6c` (blank-prepare-link fix), cited in the second
  directive, is also absent.
* **No local server (fixed in this migration).** `scripts/serve-local.ts`
  mounts the unchanged handler over in-memory PGlite. The harness passes
  against it over HTTP: 13 scenarios pass with 336 checks, and 3 skip because
  they need in-process clock control.

## 6. Research observations carried forward

* Prepared ≠ submitted ≠ committed. Every bridge step that touches ACSP must say
  which of the three it reached (enforced in the adapter, see purl
  `circle/PURL-ACSP-BRIDGE.md`).
* The `propose` path is the only mutation open to a session without a
  capability. A bridge that needs more must obtain a capability from the
  owner. It may not acquire one by any other route.

## 7. What survives, what changes, why

| Survives unchanged | Why |
|---|---|
| ACSP/0.1 protocol, code, deployment, data | It is the continuity layer and its tests pass. Nothing in the bridge needs a protocol change |
| The four invariants | Implementation invariants, tested by the harness `authority-matrix` and `get-safety` scenarios |
| Pending proposals | Owner authority |

| Changes | Why |
|---|---|
| Added `scripts/serve-local.ts`, `npm run serve:local` | Other systems can test against ACSP without the live deployment or Next |
| Added this artifact and `migration/relay-gen1/` | History becomes citable lineage (generation 1) |
| Other systems reach ACSP via the circle adapter | One boundary to test instead of hand-written TOK text |

## 8. Unresolved

* Where the program-001 source lives, and whether it should be merged here.
* Whether the field-trial resource should be closed, checkpointed, or kept
  open for generation 2. That is the owner's decision.
* Whether a capability should be delegated to a bridge session (scope
  `append` only) to remove the owner-latency bottleneck. That is the owner's
  decision.
