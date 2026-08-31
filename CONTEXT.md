# TARS-NG

TARS-NG is a governed product layer for constructing and operating AI capabilities without transferring human authority to generated code.

## Language

**Capability Specification**:
A host-owned, user-readable statement of a capability's intended outcome, boundaries, evidence needs, permissions, effects, and acceptance examples before implementation.
_Avoid_: Requirements blob, plugin prompt, implementation plan

**Capability Specification Revision**:
An immutable successor to one Capability Specification; it preserves the prior revision and receives its own identity and digest.
_Avoid_: Edit, overwrite, latest spec

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
