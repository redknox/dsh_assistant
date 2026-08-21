# Capability Registry

Status: **Verified** by `test/registry.test.ts`. This is the Self-Extension answer to **What do I have?**

It does **not** answer **What should change?** ([Capability Resolution Review](./capability-resolution.md)) or **May I change it?** (install/approval governance). See [docs/self-extension.md](./self-extension.md).

## Responsibilities

- Store inspectable records of plugin/version identity, provenance, lifecycle, evidence, approval, capabilities, permissions, runtime seams, and associated tools/services/providers.
- Resolve the current **active** owner for a capability, or report `unknown` / `inactive` / `conflict`.
- Keep candidate versions beside an immutable active version of the same owner.

## Non-responsibilities

- Capability Resolution Review (reuse / configure / evolve / adopt / provider / new-plugin). See [docs/capability-resolution.md](./capability-resolution.md).
- User approval of install, upgrade, remove, or switch.
- Mounting, unmounting, or generating plugins.
- Inferring approval from a previous version or a larger permission set.
- Manufacturing `approved-for-this-diff`. `register()` always records `unreviewed`. Stored snapshots may carry prior approval evidence; the registry does not create it.

A `status: active` registry row is metadata. It does not cause DSH to load that plugin.

```text
Capability Registry        → What do I have?
Capability Resolution      → What should change?   [implemented]
Extension Governance       → May I change it?      (later issue)
```

## Capability identity

Stable ids are lowercase dotted names with at least two segments:

```text
calendar.read
calendar.write
mail.read
tasks.create
matter.light.set
```

Malformed identities (`Calendar.Read`, `calendar`, empty string) are rejected. `unknown` is not `false`: a capability with no records is `unknown`; records that are only candidate/disabled/retired are `inactive`.

## Ownership and conflicts

One capability may have many historical or candidate records. At most one **active** owner is allowed. A second active claim is rejected as an inspectable `OwnershipConflictError`; the registry never picks a winner.

Disabled or retired owners are not resolved as active.

## Provenance

`managed/*` and `generated/*` share the same DSH plugin model. Provenance is metadata (`kind` + `origin`), not a privileged loader.

## Lifecycle vs approval

| Field | Meaning |
| --- | --- |
| `status` | `candidate` / `active` / `disabled` / `retired` — registry lifecycle only |
| `approval` | `unreviewed` / `rejected` / `approved-for-this-diff` — governance evidence |

`register()` always writes `unreviewed`. There is no public `transitionApproval`. Approval of version N does not apply to version N+1. A later Governance issue may record an external approval decision; this registry only decodes stored evidence.

Persistence stores `RegistryRecordSnapshot` DTOs, not domain records. Load decodes and validates each snapshot. Malformed rows and conflicting active owners in storage are rejected; they never become silent domain state.

## Bootstrap inventory

`CORE_BOOTSTRAP_INVENTORY` lists the current Assistant Core MVP as explicit records: memory, knowledge, fake integrations, trust/policy, jobs, and the UI control surface. Integration ownership uses `provider: fake`. Live vendor accounts (Google and others) are not claimed. Bootstrap `status: active` is inventory of what the product already ships, not Self-Extension approval (`approval` stays `unreviewed`).

## Public seam

`ctx.capabilityRegistry` is the application/DSH service. Optional model-facing tools `list_capabilities` and `lookup_capability` are **read-only** adapters. There are no register / approve / install tools.

Capability Resolution Review queries `resolveActiveOwner` and `list` here, then produces a recommendation. See [docs/capability-resolution.md](./capability-resolution.md).
