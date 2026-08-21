# Capability Registry

Status: **Verified** by `test/registry.test.ts`. This is the Self-Extension answer to **What do I have?**

It does **not** answer **What should change?** (Capability Resolution Review) or **May I change it?** (install/approval governance). Those remain later issues. See [docs/self-extension.md](./self-extension.md).

## Responsibilities

- Store inspectable records of plugin/version identity, provenance, lifecycle, evidence, approval, capabilities, permissions, runtime seams, and associated tools/services/providers.
- Resolve the current **active** owner for a capability, or report `unknown` / `inactive` / `conflict`.
- Keep candidate versions beside an immutable active version of the same owner.

## Non-responsibilities

- Capability Resolution Review (reuse / configure / evolve / adopt / provider / new-plugin).
- User approval of install, upgrade, remove, or switch.
- Mounting, unmounting, or generating plugins.
- Inferring approval from a previous version or a larger permission set.

A `status: active` registry row is metadata. It does not cause DSH to load that plugin.

```text
Capability Registry        → What do I have?
Capability Resolution      → What should change?   (later issue)
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

Registering a successor version defaults to `unreviewed`. Approval of version N does not apply to version N+1, including when N+1 only adds permissions.

## Bootstrap inventory

`CORE_BOOTSTRAP_INVENTORY` lists the current Assistant Core MVP as explicit records: memory, knowledge, fake integrations, trust/policy, jobs, and the UI control surface. Integration ownership uses `provider: fake`. Live vendor accounts (Google and others) are not claimed.

## Public seam

`ctx.capabilityRegistry` is the application/DSH service. Optional model-facing tools `list_capabilities` and `lookup_capability` are **read-only** adapters. There are no register / approve / install tools.

Later Capability Resolution Review should query `resolveActiveOwner` and `list` here, then produce a recommendation. This package does not implement that engine.
