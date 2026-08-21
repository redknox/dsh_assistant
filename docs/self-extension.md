# Self-Extension architecture and governance

Status: governance contract is **Designed** and remains normative. The Capability Registry, Resolution Review, candidate workspace/validation, governed activation/recovery, and the first Obsidian Vault generated-plugin slice are **Verified**. See [docs/capability-registry.md](./capability-registry.md), [docs/capability-resolution.md](./capability-resolution.md), [docs/candidate-workspace.md](./candidate-workspace.md), [docs/extension-governance.md](./extension-governance.md), and [docs/obsidian-self-extension.md](./obsidian-self-extension.md).

Companion documents: [ARCHITECTURE.md](../ARCHITECTURE.md) (layers and public seams), [ENGINEERING.md](../ENGINEERING.md) (normative contributor rules), [README.md](../README.md) (product boundary).

## Invariants

Two principles are normative. A later implementation that violates them is out of contract, not a small product tweak.

1. **Self-extension without self-authorization.** The assistant may discover gaps, design, write, build, and test candidate plugins. It must **never authorize its own capability changes**. Writing code is not permission to mount, install, upgrade, remove, or switch that code.
2. **Prefer reuse and evolution over capability proliferation.** A new plugin is the last option, not the default. If an owner already covers the domain, evolve that owner.

Self-Extension is extension through **public DSH** plugin, service, provider, tool, event, profile, and bundle seams. It is not unrestricted self-modification of the running product, and it must not patch or depend on DSH package-internal Agent Loop / `src/*` internals.

Assistant-generated code has **no privileged runtime path**. It uses the same public DSH plugin contract as human-authored code.

The Assistant Core MVP in this repository remains the stable product/runtime baseline. Self-Extension sits beside that baseline; it does not replace it.

## Three separate questions

These concerns must stay separate. Do not collapse them into one “the assistant decided to upgrade itself” step.

| Question | Concern | Owner of the answer |
| --- | --- | --- |
| **What do I have?** | Capability and ownership visibility | Capability Registry (`ctx.capabilityRegistry`) |
| **What should change?** | Capability Resolution Review | `ctx.capabilityResolution.review` ([docs/capability-resolution.md](./capability-resolution.md)) |
| **May I change it?** | User approval / governance | Recovery Root `recordApproval` + transactional activate ([docs/extension-governance.md](./extension-governance.md)) |

Visibility is not a change proposal. A change proposal is not authorization. Authorization is not a license to expand capabilities or permissions later without a new review.

## Provenance model

All plugins — human-maintained and assistant-generated — share one DSH plugin/runtime model: Cordis load/unload, public inject/provide, profile/bundle rows. Provenance is **metadata and management state**, not a second loader or a privileged fiber.

Logical prefixes (management paths, not a required filesystem layout in this issue):

| Prefix | Meaning |
| --- | --- |
| `managed/*` | Human-maintained, or a generated candidate that a human promoted to stable |
| `generated/*` | Assistant-generated candidates or not-yet-promoted plugins |

Required provenance fields for every managed or generated plugin record:

| Field | Role |
| --- | --- |
| `origin` | Where the artifact came from (`human`, `assistant`, imported package, …) |
| `owner` | Stable ownership id (`managed/google-calendar`, `generated/matter-home`, …) |
| `version` | Candidate or active version identity. A number alone is never safety evidence. |
| `status` | `candidate` \| `active` \| `disabled` \| `retired` (and later extensions of this set) |
| `evidence` | Evidence-language level for the claim (`Designed` / `Implemented` / `Verified` / …) |
| `requestedCapabilities` | Capabilities this version asks to expose |
| `requestedPermissions` | Permissions and secrets this version asks to use |
| `approval` | Governance state (`unreviewed` \| `rejected` \| `approved-for-this-diff`) |

`status` and `approval` are different. A candidate may be built and **Verified** in a workspace and still be `approval: unreviewed`. An `active` plugin that later requests more permissions is not still approved; it returns to unreviewed for that diff.

Conceptual ownership mapping the registry must be able to represent:

```text
capability: calendar.read
owner: managed/google-calendar
provider: google
runtime seam: integrations.calendar
permissions:
  - google.calendar.read
status: active
```

## Capability Resolution Review

The executable review lives at `ctx.capabilityResolution.review`. Details: [docs/capability-resolution.md](./capability-resolution.md). It is advisory only.

Before proposing a **new** plugin, the assistant must produce a Capability Resolution Review. The review is mandatory evidence, not optional commentary.

Check these options **in order**. Stop at the first option that satisfies the need.

1. Reuse an existing capability, tool, or service.
2. Change configuration or permissions on what already exists.
3. Evolve the existing owning plugin (new candidate version of that owner).
4. Reuse or install another **existing** plugin or provider.
5. Implement an adapter/provider against an existing DSH or application seam.
6. Create a genuinely new plugin/capability.

A new-plugin proposal must include **capability-resolution evidence** explaining why options 1–5 do not satisfy the requirement.

The review must answer:

- What capability or problem is being requested?
- What existing capabilities were checked?
- Who currently owns the relevant capability or domain?
- Is this a configuration issue, provider issue, domain-contract issue, adapter issue, or a genuinely new capability?
- Why is the recommended change the smallest reasonable architectural change?

If an existing owner already owns the capability or domain, the default is to **evolve that owner**. Do not create `better-*`, `*-v2`, or helper plugins that overlap the same seam.

## Architecture ownership

Ownership exists so Self-Extension cannot mint parallel plugins for the same domain.

| Situation | Default action |
| --- | --- |
| A named owner already covers the capability/domain | Evolve that owner (new candidate version) |
| The need is a missing config or permission | Change config/permission; no new plugin |
| An existing DSH or product seam can host a new provider | Add/replace a provider; keep the consumer |
| No owner, no seam, and the domain is new | New plugin may be proposed, still as a candidate |

Ownership records are how the system answers **What do I have?**. They are not authorization.

## Candidate lifecycle

Installed or active plugin code is **immutable**. Do not patch a live version in place. Every modification is a new candidate version or workspace artifact.

```text
Need / Problem
  ↓
Capability Resolution Review
  ↓
Change Proposal
  ↓
Candidate version/workspace
  ↓
Build / Test / Validation
  ↓
Capability + Permission Diff
  ↓
User Approval
  ↓
Install / Upgrade / Switch
  ↓
Observe
  ↓
Keep or Rollback
```

Development (research, design, write, build, test) may proceed without approval. **Install / upgrade / remove / switch** may not. Capability expansion and permission expansion each require a **new** approval, even when the plugin identity is unchanged.

## Authorization boundary

Development permission and runtime authorization are separate.

Default operating mode for this project:

- The assistant may research, design, write, build, and test candidate code.
- Runtime **install / upgrade / remove / switch** requires explicit user approval.
- Capability expansion requires renewed approval.
- Permission expansion requires renewed approval even when plugin identity is unchanged.
- Writing code is not authorization to execute or mount that code.

Self-Extension approval is a **distinct governance concern** from the existing L0–L4 action-trust model.

| Model | Governs | Does not govern |
| --- | --- | --- |
| **L0–L4** (policy) | Whether a mounted capability may read, propose, or execute a user-world action | Whether a new plugin may be installed |
| **Self-Extension approval** | Whether a candidate may become active, and whether its capability/permission set may grow | Each later L2–L4 confirmation for a user-world action |

Compatibility: once a plugin is active, its tools still pass through L0–L4. Approving an install that exposes `files.delete` does not auto-execute deletes; L4 still applies per action. Conversely, an L0 calendar read being allowed does not authorize installing a new calendar owner.

## Capability and permission diff

Before user approval, a candidate must present a reviewable diff. A version bump is never sufficient evidence that an upgrade is safe.

The diff must cover at least:

- plugin identity, version, and provenance
- capabilities added, removed, or changed
- tools, services, and providers added, removed, or changed
- external systems accessed
- permissions and secrets required
- filesystem, network, and process side effects
- tests and evidence (with evidence-language labels)
- rollback / unload behavior

The user approves **this diff**, not an open-ended identity. A later candidate that adds a network host or a secret is a new diff.

## Rollback and reversibility

Minimum guarantees after an approved extension, where the underlying DSH lifecycle supports them (reversible Cordis fibers, profile/bundle rows):

- The previously active version remains identifiable.
- Candidate installation must be reversible (unload / switch back) when DSH load/unload can express it.
- Failure during activation must not silently leave a half-active capability. Activation is all-or-nothing, or the inspectable state is `disabled` / failed with the previous version still active.
- Disable and unmount state must be inspectable (**What do I have?** still works after failure).
- Rollback restores a previously approved capability/permission set. Rollback is **not** authorization for a different set.

If DSH cannot express a reversible switch for a given artifact, the proposal must say so in the diff and must not claim rollback is **Verified**.

## Worked decision examples

### Example A — evolve the existing owner

**Need:** “When I ask who’s free on Tuesday, search calendar attendees, not just event titles.”

Capability Resolution Review:

- Requested capability: richer `calendar.read` (attendee / free-busy filter).
- Existing capabilities checked: `integrations.calendar` list/read tools; morning-brief jobs that already consume calendar reads; no separate availability product.
- Current owner: `managed` calendar integration (runtime seam `integrations.calendar`).
- Classification: domain/adapter evolution of the existing calendar owner, not a new capability family.
- Smallest change: new **candidate version** of the calendar owner (or its provider) that exposes attendee/free-busy on the same seam. Configuration may select which calendars are visible.

**Decision:** do **not** create `generated/calendar-availability` or `managed/google-calendar-v2`. Evolve the existing owner. Install/switch of that candidate still requires user approval and a capability/permission diff (for example extra `calendar.freebusy` permission).

### Example B — a genuinely new plugin is justified

**Need:** “Turn the living-room lights off at 23:00 through Matter.”

Capability Resolution Review:

- Requested capability: home-device execute (`matter.light.set`).
- Existing capabilities checked: integrations (calendar, mail, tasks, files, contacts); jobs (morning-brief and follow-up tasks); policy L0–L4 (can gate execute, but owns no device seam); knowledge (retrieval only); memory (user facts, not actuators).
- Current owner: none. No DSH or product seam for Matter / home devices.
- Classification: genuinely new capability. Not a config flag, not a new provider behind `integrations.calendar`, not an evolution of morning-brief.
- Smallest change: a new candidate plugin `generated/matter-home` that provides a device facade and a thin tool adapter, still injects only public DSH services (`tools`, policy, jobs).

**Decision:** a new plugin is justified. It remains `generated/*` + `status: candidate` until the user approves the capability/permission diff (local network, pairing secrets, `matter.light.set` execute). Approval to install is not standing approval to power devices; L4 (or the declared execute level) still applies per action. Do not add a privileged loader for this candidate.

## Non-goals (still later)

**Verified** by the Obsidian Vault slice (`test/obsidian-e2e.test.ts`, [docs/obsidian-self-extension.md](./obsidian-self-extension.md)). Still **Unsupported**:

- Autonomous plugin-writing engine
- Runtime loader / version manager
- Automatic install, upgrade, or remove
- Sandbox or container execution framework
- Any change to DSH Agent Loop internals

Registry, Resolution, candidate validation, governed activation/recovery, the first Obsidian Vault generated-plugin slice, and durable restart reconstruction / operator control (`docs/self-extension-durability.md`, `docs/self-extension-operations.md`) are **Verified**.
