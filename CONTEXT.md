# TARS-NG

TARS-NG is a governed product layer for constructing and operating AI capabilities without transferring human authority to generated code.

## Language

**Capability Specification**:
A host-owned, user-readable statement of a capability's intended outcome, boundaries, evidence needs, permissions, effects, and acceptance examples before implementation.
_Avoid_: Requirements blob, plugin prompt, implementation plan

**Resolution Plan**:
A host-owned decision to reuse, configure, evolve, adopt, provide, or create a capability from one exact Capability Specification.
_Avoid_: Plan, coding plan

**Candidate**:
An inactive, governed revision proposed to satisfy a Resolution Plan; it has no installation or activation authority.
_Avoid_: Plugin, installed extension

**Acceptance Example**:
A concrete situation, action, and expected outcome that makes the business meaning of a Capability Specification reviewable.
_Avoid_: Unit test, validation result

**Runtime Permission**:
An exact named host operation requested by a Capability Specification and bound into Candidate review and approval.
_Avoid_: Access, capability, blanket permission

**Independent Review**:
A digest-bound assessment of a sealed Candidate that is separate from governance approval.
_Avoid_: Approval, acceptance

**Governance Approval**:
Human authority granted to one exact reviewed Candidate digest and diff.
_Avoid_: Review, confirmation
