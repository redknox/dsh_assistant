# Extension Governance, Activation, and Recovery

Status: **Verified** by `test/governance.test.ts`. This is the Self-Extension answer to **May this exact validated candidate become active, and can the system recover if activation fails?**

**AI may evolve capabilities, but it may not control the authority that approves or recovers those capability changes.**

```text
Capability Registry        → What do I have?       [implemented]
Capability Resolution      → What should change?   [implemented]
Candidate Workspace        → Can I build it?       [implemented]
Candidate Validation       → Is this artifact valid? [implemented]
Governance + Activation    → May it become active? [this document]
Recovery Core              → Can I recover?        [this document]
```

## Validation vs approval vs activation

| Step | Meaning | Not |
| --- | --- | --- |
| `validated` | Evidence for one sealed digest | Permission to install |
| `approved-for-exact-diff` | A human/trusted control recorded a decision for that fingerprint | Runtime change |
| `active` | Transactional switch committed after health checks | Self-approval |

```text
Assistant can propose/write/validate
        ↓
Human/trusted authority approves exact diff
        ↓
Activation layer switches version transactionally
        ↓
Recovery root can revert independently of Assistant
```

There is no `approve(candidateId)` that accepts model input. Trusted approval requires a credential issued only by the Recovery Root.

## Approval fingerprint

Approval is bound to a SHA-256 fingerprint of:

- candidate id, owner, version, artifact digest
- base version
- capability / permission / runtime-surface diffs
- operational effects

If source, digest, diff, or the assumed base version changes, the prior approval is stale. A permission expansion needs a new approval. Model/tool arguments cannot set `approved=true` or forge authority.

The inspectable summary includes added/removed capabilities and permissions, runtime surface, effects, versions, digest, and validation status.

## Eligibility

Activation is denied with explicit reasons unless all of these hold:

- candidate exists, is sealed, and `validated`
- validation digest matches the sealed artifact
- trusted approval exists for the current fingerprint
- approval is not rejected/superseded/stale
- assumed base version still matches the active owner
- no Registry ownership conflict
- Safe Mode is not excluding a generated candidate

Approval alone does not mutate Registry or runtime.

## Activation transaction

```text
validated + approved
        ↓
activation-pending → activating
     ↙                ↘
active            activation-failed → restore LKG (or Safe Mode)
```

Phases: verify eligibility → capture Last Known Good → prepare/mount → health → commit Registry/runtime.

Registry commit happens only after health verification. A failed prepare/health leaves the previous owner active. There is never a final state with two active owners for the same capability.

Prepare / health / commit / restore use a production `CordisActivationRuntime` that resolves the sealed candidate's plugin entry from workspace / `entryPoints` / `package.json` and mounts that artifact through `ctx.plugin`. Health only credits tools/services/providers the candidate **produced**; surfaces that were already present on the previous composition do not count. Rollback disposes the candidate fiber. `InMemoryActivationRuntime` remains a unit-test fake only.

This issue still does not implement a first autonomous generated-plugin vertical slice.

## Last Known Good

`current` and `lastKnownGood` are distinct fields. LKG is captured before switch and overwritten only after a successful commit. `rollbackTarget` keeps the previous good snapshot so a later trusted rollback can restore it.

## Recovery Core and Safe Mode

The Recovery Core is not a second Assistant and does not need an LLM. It can inspect current/LKG/failure state, disable a version, revert to LKG, and enter Safe Mode.

Safe Mode keeps DSH/runtime, governance/recovery, Registry diagnostics, and managed bootstrap owners. It disables `generated/*` and refuses to activate new generated candidates.

`bootSafeModeRuntime()` and `profiles/assistant-safe` exclude optional integrations, jobs, and generated extensions **before they load**. Recovery inspect/request stay available. Safe Mode does not depend on the failed extension loading.

Self-Extension has no public path to rewrite the approval/recovery root, overwrite LKG authority, or change Safe Mode policy.

## Public seams

```text
ctx.extensionGovernance   request/inspect/eligibility (no trusted approve)
ctx.extensionActivation   status only
ctx.extensionRecovery     inspect only
RecoveryRoot (boot return) issueAuthority, recordApproval, activate, rollback, Safe Mode, disable
```

`issueAuthority` is not on `ctx`. Ordinary plugins share Cordis context and have no supported public path to mint a trusted credential. `bootAssistantControl()` / `bootSafeModeRuntime()` return the Recovery Root to the bootstrap/UI caller only.

Model-facing tools `inspect_extension_governance` and `request_extension_approval` are read/request only.
