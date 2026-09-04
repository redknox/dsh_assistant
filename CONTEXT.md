# TARS-NG

TARS-NG is a governed product layer for constructing and operating AI capabilities without transferring human authority to generated code.

## Language

**Harness**:
The DSH Agent runtime that interprets the user's current goal and dynamically decides the next step from available context, capabilities, and results.
_Avoid_: Workflow engine, TARS-NG scheduler, fixed business process

**Capability**:
A reusable, governed ability that the Harness may select for more than one goal or scenario, independent of whether it is implemented by a Tool, Skill, Workflow, Extension, or Connector.
_Avoid_: Plugin card, one-off step, built-in status

**Workflow**:
A named, governed composition for a stable and repeatable sequence that the Harness may invoke as one Capability; it does not decide the user's overall next step or grant authority to its children.
_Avoid_: Agent Loop, product controller, mandatory path

**Governance Envelope**:
The TARS-NG-owned constraints and evidence around Harness activity: available capabilities, context scope, permissions, approval, activation, observation, cancellation, and recovery.
_Avoid_: Orchestrator, Agent brain, prompt policy

**Capability Delivery Session**:
A dedicated Session that contains the conversation and decisions for taking one requested Capability from proposal to Live or Stopped; it is a work context, not a second lifecycle authority.
_Avoid_: Build job, workflow run, approval store

**Capability Specification**:
A host-owned, user-readable statement of a capability's intended outcome, boundaries, evidence needs, permissions, effects, and acceptance examples before implementation.
_Avoid_: Requirements blob, plugin prompt, implementation plan

**Capability Specification Revision**:
An immutable successor to one Capability Specification; it preserves the prior revision and receives its own identity and digest.
_Avoid_: Edit, overwrite, latest spec

**Capability Delivery Stop**:
A host-owned user decision that ends further development of one current Capability Specification without deleting its Specification, Resolution Plan, Candidate, approval, or audit evidence. Stopped delivery belongs in History; an already-live capability must be Unplugged instead.
_Avoid_: Delete, cancel button navigation, rollback, uninstall

**Resolution Plan**:
A host-owned decision to reuse, configure, evolve, adopt, provide, or create a capability from one exact Capability Specification.
_Avoid_: Plan, coding plan

**Candidate**:
An inactive, governed revision proposed to satisfy a Resolution Plan; it has no installation or activation authority.
_Avoid_: Plugin, installed extension

**Acceptance Example**:
A concrete situation, action, and expected outcome that makes the business meaning of a Capability Specification reviewable.
_Avoid_: Unit test, validation result

**Evaluation Fixture**:
The machine-readable input and expected output attached to an Acceptance Example so its business claim can be executed exactly.
_Avoid_: Test file, mock, prompt example

**Capability Evaluation**:
A host-run, digest-bound execution of a Candidate against the Evaluation Fixtures in one exact Capability Specification.
_Avoid_: Unit test, Independent Review, approval

**Runtime Permission**:
An exact named host operation requested by a Capability Specification and bound into Candidate review and approval.
_Avoid_: Access, capability, blanket permission

**Independent Review**:
A digest-bound assessment of a sealed Candidate that is separate from governance approval.
_Avoid_: Approval, acceptance

**Governance Approval**:
Human authority granted to one exact reviewed Candidate digest and diff.
_Avoid_: Review, confirmation
