CONSTITUTION-ORIENTED PROGRAMMING

Governing Development Preamble for Relay × PURL × SubstrateIO

Before proceeding with the architectural handoff below, establish a new governing engineering concept for this entire research program:

Constitution-Oriented Programming (COP)

Treat Constitution-Oriented Programming as a proposed engineering paradigm to be researched, defined, implemented, tested, challenged, and refined through this project.

Do NOT assume that our initial definition is correct merely because we wrote it here.

First research the existing landscape of:

- agent constitutions
- constitutional AI-agent development practices
- Spec-Driven Development constitutions
- policy-as-code
- governance-as-code
- executable specifications
- invariant-driven development
- protocol specifications
- formal methods
- type-level constraints
- property-based testing
- executable documentation
- compiler/language governance
- self-hosting and bootstrapping systems

Identify what already exists, what is genuinely novel in our proposed formulation, what terminology conflicts exist, and what should be renamed or separated.

Then return a research-backed recommendation for the exact definition and architecture of Constitution-Oriented Programming.

Do not silently adopt an existing project's terminology or implementation as ours.

---

1. PROPOSED DEFINITION

Use the following only as a starting hypothesis:

«Constitution-Oriented Programming is a software-development paradigm in which the constitution of a computational system is treated as an executable, versioned, testable source of governing constraints and invariants, and every artifact produced by the system—including code, protocols, languages, libraries, documentation, operations, programs, and computational values—is required to remain constitutionally traceable.»

This definition is provisional.

Claude must challenge it.

The goal is not to make "constitution" another fashionable documentation label.

The goal is to determine whether we can build a system in which constitutional principles actually propagate through the computational substrate.

---

2. CONSTITUTION IS NOT DOCUMENTATION

Establish and test this distinction:

Documentation

- describes what exists
- explains usage
- explains architecture
- records decisions
- provides examples

Constitution

- establishes governing invariants
- establishes authority
- establishes boundaries
- establishes permitted and prohibited transitions
- establishes required properties
- establishes what must remain true as the system evolves
- establishes how amendments occur
- establishes what evidence is required to claim compliance

A Markdown constitution that nobody can test is not sufficient.

The constitution must progressively become represented through:

- schemas
- types
- interfaces
- validators
- parsers
- protocol constraints
- execution guards
- property tests
- differential tests
- invariant tests
- CI checks
- runtime checks where appropriate
- provenance
- versioning
- executable verification
- observable traces

Do not force every principle into code where that would be inappropriate.

Instead, establish an explicit mapping:

"constitutional clause"
→ "affected artifact"
→ "enforcement mechanism"
→ "verification"
→ "evidence"
→ "current status"

---

3. CONSTITUTIONALITY MUST APPLY TO THE ENTIRE STACK

The constitution is not merely for Claude Code.

It applies recursively to everything we build.

At minimum:

Human-facing artifacts

- architecture
- documentation
- specifications
- research records
- nomenclature
- examples
- tutorials

Machine artifacts

- TypeScript
- Python
- Rust or future languages
- schemas
- APIs
- libraries
- modules
- adapters
- database structures
- storage formats
- test harnesses
- compiler components
- runtime components

Computational artifacts

- PURL expressions
- URLs
- operations
- programs
- Scrolls
- aliases
- values
- derivations
- execution records
- transitions
- compiled forms
- intermediate representations
- artifacts produced by execution

Agent-facing artifacts

- prompts
- agent instructions
- operation descriptions
- SDK documentation
- machine-readable manifests
- language constructs
- tool schemas
- capability descriptions
- error semantics
- recovery protocols

Future computational language

If we create a language specifically intended for LLMs or agents to construct and manipulate computational expressions, that language itself must have:

- a constitution
- grammar
- semantics
- typing rules
- authority model
- evaluation rules
- error model
- versioning
- compatibility rules
- provenance
- tests
- executable examples
- conformance tests

The language must not become an undocumented implicit behavior of the model.

---

4. CONSTITUTIONAL RECURSION

The most important research question is whether constitutional development can recurse.

For example:

"Constitution"
→ governs PURL
→ PURL expresses a language
→ language expresses programs
→ programs create operations
→ operations create artifacts
→ artifacts can describe or extend computational behavior
→ those extensions remain constitutionally constrained

Investigate whether this produces a useful form of:

constitutional recursion

or whether that concept collapses into ordinary configuration, policy-as-code, or programming-language semantics.

Do not assume the answer.

Measure it.

---

5. CONSTITUTIONAL AMENDMENT

The constitution itself must be:

- versioned
- addressable
- content-identifiable
- provenance-bearing
- testable
- diffable
- reviewable
- recoverable
- associated with the implementation state it governed

An agent may:

- discover a conflict
- identify an inadequate clause
- propose an amendment
- provide evidence
- construct a candidate amendment
- test the candidate
- compare the old and proposed constitution
- explain consequences

An agent must NOT silently rewrite governing authority merely because doing so makes implementation easier.

Any change to governing authority must have an explicit authority path.

Model this as a computational transition, not an invisible file edit:

"constitution_vN"
→ "amendment_proposal"
→ "evidence"
→ "human/authorized decision"
→ "constitution_vN+1"
→ "verification"
→ "adoption"

Research whether portions of this can eventually be automated without collapsing authority boundaries.

---

6. CONSTITUTIONAL DEVELOPMENT LOOP

Claude Code must operate using a visible loop approximately like:

"READ CONSTITUTION"
→ "READ CURRENT STATE"
→ "READ ACTIVE PROTOCOLS"
→ "IDENTIFY TASK"
→ "MAP TASK TO CONSTITUTION"
→ "FORMULATE CHANGE"
→ "IMPLEMENT"
→ "TEST"
→ "VISIT COMPUTATIONAL URL"
→ "OBSERVE RESULT"
→ "VERIFY CONSTITUTIONAL INVARIANTS"
→ "RECORD EVIDENCE"
→ "UPDATE STATE"
→ "CHECKPOINT"
→ "CONTINUE"

The important point:

Every meaningful task completion must cause the system to reorient itself against the current constitution and current computational state.

Do not merely read the constitution once at session startup.

We are investigating continuous constitutional orientation.

---

7. THE COMPUTATIONAL URL IS THE TESTING SURFACE

The new PURL environment should become the primary visible laboratory.

When Claude creates or changes a construct:

1. construct it
2. address it
3. visit its computational URL
4. execute/resolve it in the appropriate regime
5. observe the returned state
6. record the result
7. compare it against expected constitutional behavior
8. retain the evidence
9. expose the result through the environment

The URL is therefore simultaneously becoming:

- runtime
- compiler surface
- IDE
- documentation surface
- operation registry
- testing environment
- observation surface
- research instrument interface

Do not create a fake dashboard that merely reports progress.

The underlying computational URL must actually represent the state being observed.

---

8. THE NEW SLATE / IDE-SCROLL ENVIRONMENT

Prepare the current ACSP/Relay state as a migration artifact into a new development phase.

The first Relay/ACSP implementation should become a historical and operational artifact that establishes:

- what existed
- what was learned
- what state was persisted
- what authority existed
- what operations existed
- what contracts were tested
- what remains unresolved
- what should be carried forward

Do NOT destroy or overwrite the prior state.

Create a clearly versioned migration/handoff artifact.

Then establish the new development slate as an:

IDE + Scroll Computational Environment

It should allow us and the active coding agent to visibly observe:

- current constitution
- constitution version
- current architecture
- current implementation state
- active task
- active Scroll
- current program
- current operations
- current tests
- tests currently running
- test results
- generated artifacts
- computational URLs
- execution records
- constitutional checks
- discovered operations
- proposed constructs
- completed constructs
- unresolved questions
- proposed constitutional amendments
- current build/checkpoint
- provenance

The environment must show actual computational growth rather than merely displaying a progress bar.

---

9. VISIBLE SELF-DEVELOPMENT

Claude Code should continuously develop the system through this environment.

The intended loop is:

"DISCOVER"
→ "FORMULATE"
→ "CONSTRUCT"
→ "ADDRESS"
→ "TEST"
→ "OBSERVE"
→ "VERIFY"
→ "REVISE"
→ "CHECKPOINT"
→ "DISCOVER NEXT CONSTRUCT"

When appropriate, Claude should use the computational URL itself as part of its testing methodology.

We should be able to watch the system grow.

We should see:

- new constructs appear
- tests appear
- tests execute
- results appear
- failures remain visible
- fixes produce new executions
- Scrolls evolve
- programs become reusable
- aliases emerge
- operations become addressable
- constitutional checks run
- evidence accumulates
- unresolved questions remain explicitly unresolved

Do not hide intermediate development merely to produce a polished final artifact.

The observable development process is itself part of the research artifact.

---

10. CONTINUOUS TESTING IS NON-NEGOTIABLE

Do not implement a large architecture first and test it at the end.

Test continuously.

For each meaningful construct:

"construct → test → observe → verify → record"

Use the strongest appropriate test available:

- unit tests
- integration tests
- schema validation
- protocol conformance
- property-based tests
- invariant tests
- differential tests
- replay tests
- deterministic fixtures
- compiler/parser tests
- negative tests
- malformed-input tests
- authorization tests
- idempotency tests
- concurrency tests
- regression tests
- constitutional conformance tests

Where an important property can be tested independently of the implementation, prefer an independent verifier.

Do not let the implementation define its own correctness oracle when a stronger independent check is feasible.

---

11. CONSTITUTIONAL TEST ARTIFACT

Create an explicit artifact representing constitutional conformance.

It should answer:

- Which constitutional clauses exist?
- Which artifacts do they govern?
- Which tests verify them?
- Which clauses are mechanically enforced?
- Which are observational?
- Which remain human-reviewed?
- Which are currently unverified?
- Which have conflicting interpretations?
- Which have failed?
- Which have been amended?
- What evidence supports each status?

Do not use a single numerical "constitution score."

Use categorical evidence and explicit statuses.

For example:

"DECLARED"
"IMPLEMENTED"
"TESTED"
"OBSERVED"
"VERIFIED"
"FAILED"
"CONFLICTING"
"UNRESOLVED"
"PROPOSED"

Research whether these statuses are sufficient and revise them if necessary.

---

12. FULL BUILD PLAN BEFORE / DURING IMPLEMENTATION

Before making broad architectural changes, inspect the current repository and produce a complete build plan covering as much of the system as can be justified from the actual code.

The plan must include:

Architecture

- current architecture
- target architecture
- migration boundaries
- dependencies
- authority boundaries

Constitution

- constitution structure
- constitutional clauses
- enforcement mechanisms
- amendment mechanism
- constitutional test strategy

Relay / ACSP

- current state
- migration artifact
- continuity model
- authority model
- handoff model
- provenance
- checkpoints

PURL

- address model
- operation model
- parser/compiler path
- typed terms
- evaluation
- programs
- Scrolls
- aliases
- SDK
- computational URLs
- continuous compile/runtime environment

SubstrateIO

- transition representation
- experimental interfaces
- observation records
- provenance
- measurement boundaries
- projection boundaries

IDE / Scroll environment

- visible state
- execution traces
- test surfaces
- artifacts
- current program
- current Scroll
- history
- checkpointing

Agent interface

- how a fresh agent discovers the environment
- how it discovers operations
- how it constructs programs
- how it tests
- how it records observations
- how it requests capabilities
- how it proposes extensions

Testing

- unit
- integration
- protocol
- compiler
- property
- invariant
- differential
- replay
- security
- constitutional conformance

Research

- hypotheses
- unresolved questions
- experiments
- measurements
- evidence
- falsification opportunities

For every major component identify:

"EXISTS"
"PARTIAL"
"MISSING"
"CONFLICTING"
"UNRESOLVED"

Do not invent implementation that the repository does not contain.

---

13. RESEARCH-BACKED DESIGN, NOT BLIND COMPLIANCE

The handoff below contains a substantial architectural vision.

Treat it as authoritative context for the research direction, but NOT as proof that every design decision is already correct.

Claude must:

1. inspect the actual repository
2. inspect current implementations
3. inspect current tests
4. inspect current protocol behavior
5. research relevant prior art
6. identify contradictions
7. identify missing primitives
8. identify unnecessary complexity
9. identify terminology problems
10. propose corrections
11. distinguish established facts from design hypotheses
12. obtain the strongest locally testable evidence available
13. then implement

Where Claude believes a part of the architecture should change, do not silently change it.

Record:

"current proposal"
→ "problem"
→ "evidence"
→ "proposed revision"
→ "impact"
→ "implementation status"

---

14. THE SYSTEM SHOULD DEVELOP ITS OWN COMPUTATIONAL VOCABULARY

Do not prematurely freeze all terminology.

The research itself should drive nomenclature.

If recurring computational structures appear, Claude may propose:

- a term
- a symbol
- an operation
- a type
- a grammar construct
- a Scroll
- an alias
- a protocol primitive

But each should have provenance.

Potential lifecycle:

"observed recurrence"
→ "candidate concept"
→ "formal description"
→ "candidate nomenclature"
→ "implementation"
→ "test"
→ "reuse"
→ "published nomenclature"

The nomenclature itself should be addressable.

---

15. CODE IS A FIRST-CLASS COMPUTATIONAL VALUE

Code must not be treated merely as text generated during a conversation.

A program should be representable as a first-class computational artifact with:

- identity
- content/value
- provenance
- version
- dependencies
- derivation
- environment requirements
- execution semantics
- tests
- constitutional relationship
- address
- reusable representation

The same principle applies to:

- schemas
- programs
- expressions
- Scrolls
- language constructs
- compiler outputs
- operation definitions

---

16. NO ARTIFICIAL PRIVATE UNIQUENESS

Preserve the shared computational-universe principle from the handoff.

Do not create unnecessary copies merely because different agents encounter the same canonical value.

Distinguish:

value identity
from
record identity
from
execution identity
from
session/view identity
from
authority

If two agents independently produce the same canonical value, investigate whether the system should recognize that as the same computational value rather than manufacturing two unrelated objects.

At the same time, preserve provenance for the observations/executions that produced it.

---

17. SELF-EXPLORATION WITHOUT AGENT HIERARCHIES

Do not turn this into an "agent of agents" architecture.

The objective is not to create an organization of autonomous agents managing other agents.

Instead investigate:

self-exploration through addressable computational structure.

An agent should be able to:

- discover
- inspect
- construct
- compose
- test
- observe
- name
- persist
- reuse
- extend

through the computational environment itself.

That is different from an agent hierarchy.

---

18. EVERY IMPORTANT CONSTRUCT SHOULD HAVE A URL

Where technically justified, make constructs addressable:

- values
- operations
- programs
- Scrolls
- aliases
- types
- language constructs
- tests
- experiments
- nomenclature
- artifacts
- execution records
- constitutional clauses
- verification evidence

This is central to the PURL research direction.

The URL is not merely a pointer.

It is the address surface through which the computational object can be inspected, resolved, executed, composed, or further programmed according to its declared semantics and authority.

---

19. THE SDK SHOULD BE DISCOVERABLE

A fresh agent entering a computational URL should be able to discover:

- what environment this is
- what operations are available
- what programs exist
- what Scrolls exist
- what language constructs exist
- what capabilities are available
- what the current constitution is
- how to inspect it
- how to construct a program
- how to test it
- how to persist it
- how to create reusable artifacts
- how to propose a new operation
- how to report an unavailable capability

The environment should progressively teach itself through machine-readable protocol surfaces rather than requiring an enormous prompt.

---

20. "DISCOVER NEW OPERATION" REMAINS A RECURSIVE CAPABILITY

Eventually the system should support:

"inspect available primitives"
→ "identify missing capability"
→ "compose existing primitives"
→ "construct candidate operation"
→ "test"
→ "compare"
→ "name"
→ "persist"
→ "address"
→ "reuse"

But do not implement the entire recursive system prematurely.

Build the smallest constitutional foundation that makes later recursion possible.

---

21. THE FIRST ACSP ARTIFACT BECOMES A BRIDGE, NOT A GRAVEYARD

Prepare the existing ACSP/Relay implementation as a formal artifact of the previous phase.

It should preserve:

- identity
- resources
- state
- TOKs
- proposals
- checkpoints
- operations
- provenance
- known limitations
- previous research observations

Then create the new slate from that artifact.

Do not treat the old system as disposable.

It is the first historical layer of the computational lineage.

---

22. VISIBLE CHECKPOINTING

At meaningful milestones, produce a checkpoint containing at least:

- constitution version
- repository commit
- architecture state
- active Scroll
- active program
- test state
- verification state
- computational URLs
- unresolved issues
- proposed changes
- evidence
- next task

The checkpoint itself should be addressable where practical.

---

23. WHAT I EXPECT BACK FROM YOU

After inspecting the repository and researching the relevant prior art, return:

A. Constitutional Engineering Assessment

Define your recommended meaning of:

Constitution-Oriented Programming

including:

- what it is
- what it is not
- how it differs from documentation
- how it differs from protocol
- how it differs from policy-as-code
- how it differs from ordinary software architecture
- whether the term should be retained

B. Complete Build Plan

Give the full component-by-component plan based on the actual repository.

C. Current-State Artifact

Produce the migration/current-state artifact for the existing Relay/ACSP implementation.

D. New-Slate Architecture

Define the new IDE/Scroll computational environment.

E. Constitutional Architecture

Define:

- constitution format
- clause model
- versioning
- amendment
- authority
- enforcement
- evidence
- conformance

F. Test Architecture

Define how every construct will continuously test itself through the computational URL surface.

G. Implementation

Then begin implementation in the safest dependency order.

Do not wait until everything is designed before testing.

---

24. MOST IMPORTANT OPERATIONAL REQUIREMENT

While you work, keep the computational environment observable.

We should be able to see the system becoming more complete.

The process itself should expose:

"CURRENT CONSTITUTION"
"CURRENT TASK"
"CURRENT SCROLL"
"CURRENT PROGRAM"
"CURRENT CONSTRUCT"
"CURRENT TEST"
"TEST RESULT"
"CONSTITUTIONAL CHECK"
"OBSERVATION"
"ARTIFACT CREATED"
"CHECKPOINT"
"NEXT CONSTRUCT"

Do not fake these.

They must correspond to actual state and actual execution.

If a test fails, show the failure.

If an assumption is unresolved, show it.

If a construct is unavailable, show it.

If the constitution conflicts with an implementation decision, show the conflict.

If an architectural proposal changes, preserve the transition.

The objective is not to make the development look successful.

The objective is to make the development observable, reproducible, constitutional, and computationally real.

---

25. GOVERNING PRINCIPLE

The system should progressively move from:

"documentation about computation"

toward:

"addressable computation"

toward:

"programmable computation"

toward:

"self-describing computation"

toward:

"constitutionally governed computation"

while preserving:

"human authority"
"provenance"
"reproducibility"
"testability"
"explicit boundaries"
"observable transitions"

The constitution should constrain evolution without preventing discovery.

The protocol should enable communication without becoming the constitution.

The language should enable computation without becoming an undocumented model habit.

The IDE should expose the computational universe rather than simulate one.

And the agent should be able to explore and extend the environment without silently acquiring authority over the environment's governing principles.

---

26. BEGIN HERE

Do not immediately rewrite the entire repository.

First:

1. Inspect the actual current repository.
2. Inspect the existing ACSP/Relay implementation.
3. Inspect the current PURL implementation.
4. Inspect relevant SubstrateIO interfaces/artifacts.
5. Inspect tests and existing documentation.
6. Research Constitution-Oriented Programming and adjacent practices.
7. Produce the Constitutional Engineering Assessment.
8. Produce the complete build/migration plan.
9. Produce the current-state Relay/ACSP artifact.
10. Define the new IDE/Scroll slate.
11. Define the constitutional model.
12. Define the continuous testing model.
13. Implement the first smallest vertical slice.
14. Test it through the computational URL.
15. Record the result.
16. Checkpoint.
17. Continue to the next construct.

Do not finish with merely a list of things that "should" be done.

After the assessment and plan, actually begin the highest-confidence implementation slice that the current repository supports.

Every major implementation step must leave behind executable evidence.

---

FINAL RESEARCH FORMULA

Keep the architectural separation:

Relay persists → PURL computes → Substrate measures

And now add:

Constitution governs the evolution of all three.

The deeper research question is:

«What happens when a computational system is not merely documented or protocolized, but constitutionally represented such that its code, language, operations, artifacts, and evolution can all be inspected and tested against explicit governing invariants?»

Treat that as a research question.

Do not assume the answer.

Build the instrument that lets us observe it.