# Capability Resolution Review

Status: **Verified** by `test/resolution.test.ts`. This is the Self-Extension answer to **What should change?**

It consumes the Capability Registry. It does **not** answer **What do I have?** or **May I change it?**

```text
Capability Registry        → What do I have?       [implemented]
Capability Resolution      → What should change?   [this document]
Candidate Workspace        → Can I build it?       [implemented]
Extension Governance       → May I change it?      [later]
```

## Responsibilities

- Recommend the smallest reasonable architectural change for a requested capability or need.
- Record inspectable evidence for each step of the ordered decision path.
- Distinguish `unknown`, `absent`, and `unsupported`.
- Stay advisory: a review is a proposal, not an approved change.

## Non-responsibilities

- User approval / governance / `approved-for-this-diff`.
- Registering, installing, upgrading, switching, or mounting plugins.
- Generating code, searching a marketplace, or downloading packages.
- Mutating Registry lifecycle or manufacturing approval.
- Picking a winner when active owners conflict.

## Ordered algorithm

Evaluate in this order. Stop at the first option that satisfies the need. Record why earlier options were accepted or rejected.

1. **reuse** — an active owner already exposes the requested capability/behavior.
2. **configure** — a supplied permission or configuration option on that owner would satisfy the need.
3. **evolve-owner** — an active owner already covers the domain; produce a new candidate version instead of a helper/v2 plugin.
4. **adopt-existing** — an inactive candidate or a caller-supplied existing plugin already describes the capability.
5. **implement-provider** — implement an adapter/provider behind an existing application/DSH seam.
6. **new-plugin** — only when a caller-supplied **complete** inventory shows no owner, seam, or adoptable provider/plugin.

A `new-plugin` result must include rejected evidence for options 1–5. The resolver must not jump from “capability not active” to “create plugin.”

If Registry facts conflict, the result is **conflict**. Resolution does not choose a winner and must not recommend install or modify.

If the capability is unknown and the architecture inventory is incomplete, the result is **insufficient-information**, not `new-plugin`. `unknown` is not proof of absence.

## Ownership-aware defaults

If a domain already has an active owner, the default is reuse, configure, or evolve that owner.

Examples:

- richer calendar filtering while `managed/integrations` owns `calendar.read` → `evolve-owner`
- a known permission on that owner would unlock the behavior → `configure`
- replace the fake calendar provider with Google while keeping `integrations.calendar` → `implement-provider`, not a new calendar domain
- Matter home control with a complete inventory and no owner/seam/provider → `new-plugin`

`evolve-owner` names the owner and version that would change.

## Provider and seam reasoning

A provider integration problem is not a new domain. If the product already exposes a public seam, prefer an adapter behind that seam over a competing capability model or a duplicate model-facing tool.

A known provider option must bind the requested need with explicit `capabilities` and/or `domains`. A Google Calendar provider for `integrations.calendar` is not evidence for `matter.light.set`. A provider option with only `provider + seam` is ignored.

Externally discovered plugins/providers/config options are **review inputs** supplied by the caller or tests. This resolver does not search the web or a package registry.

## Public seam

`ctx.capabilityResolution.review(request)` is the application/DSH service.

The optional model-facing tool `review_capability_resolution` is a thin **read/advisory-only** adapter. It does not register approval, write files, install packages, mutate profile/bundle config, mount plugins, or change Registry lifecycle.

The tool does **not** accept `inventoryComplete` or any other model argument that could claim the architecture inventory is complete. Model/tool arguments are untrusted. A complete inventory is a trusted application/orchestrator fact on `ctx.capabilityResolution.review({ inventory: { complete: true, … } })`. Without that trusted fact, unknown capabilities stay `insufficient-information`.

The plugin supplies a default inventory of Core MVP seams with `complete: false`. Only a trusted caller may pass `inventory.complete: true`.
