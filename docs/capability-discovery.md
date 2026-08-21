# Capability Discovery

Status: **Verified** by `test/discovery.test.ts`. This is the M2 answer to **What existing capability implementation may be available?**

It does **not** answer **What is currently owned/active?** (Capability Registry) or **May I change it?** (Extension Governance).

```text
Capability Registry     → What do I have that is owned/active?
Capability Discovery    → What existing implementation may be available?
Capability Resolution   → What should change, given both?
```

Discovery != installation. Recommendation != approval.

## Why Discovery exists

Self-Extension can write plugins. That must not become the default.

```text
Need
→ current Registry
→ DSH-native / official public seams
→ trusted plugin catalog
→ smallest acquisition path
→ new-plugin only when those paths are exhausted
```

## Provenance

| Class | Meaning |
| --- | --- |
| `dsh-core` | Built into DSH public contracts |
| `dsh-official` | Official DSH-maintained plugin/package |
| `third-party` | External plugin implementing a DSH public seam |
| `managed` | TARS-NG product-managed capability |
| `generated` | TARS-NG Self-Extension candidate |

Provenance is not trust. Eligibility is not approval. Approval is not activation.

Trust is stamped by the **discovery provider**, never by candidate metadata:

- host-owned typed catalogs (DSH-native) may carry `sourceTrust: trusted` and a `dsh-core` / `dsh-official` / `managed` class;
- raw or third-party catalog records are always `sourceTrust: untrusted` and `provenance: third-party`, even if metadata claims `dsh-official`.

A forged `provenance: dsh-official` field is stored as `claimedProvenance` only. It cannot skip compatibility checks or become eligible on that claim.

## Provider seam

```text
CapabilityDiscovery
  search({ capability, need }) → DiscoveryReport
  inspect(identity) → DiscoveredCapability | undefined
```

The default wiring is a **local catalog**:

- DSH-native public families (`dsh/schedule`, `dsh/llm`, `dsh/jobs`, `dsh/tools`)
- an optional trusted third-party catalog (incomplete until a caller supplies one)

There is no npm/GitHub crawler. Providers never `import()`, install, or run discovered packages.

Unknown fields (`scripts`, `install`, `entry`, or any extra key) stay inspectable data and make a third-party record **rejected**.

## Eligibility vs later states

| State | Owner |
| --- | --- |
| MATCH / COMPATIBLE / ELIGIBLE | Discovery + Resolution |
| APPROVED | Human / Recovery Root |
| ACTIVE | Committed Registry + activation |

Missing `dshCompatibility` is `unknown`, and unknown is not compatible.

## Resolution integration

`ctx.capabilityResolution.review()` queries discovery automatically. A `new-plugin` result with incomplete or unavailable discovery is invalid; the result is `insufficient-information`.

Discovery-derived providers do **not** override reuse of a sufficient active owner. They participate only after reuse/configure are rejected, so a Google Calendar adapter in the catalog cannot evict `managed/integrations` calendar.read.

## Worked examples

### DSH Schedule

```text
Need: durable reminders
Checked:
✓ Registry has no schedule.reminders.create owner
✓ dsh/schedule is a DSH-core public seam
Recommendation: ADOPT dsh/schedule
Why not new-plugin: a new scheduler would duplicate DSH durable timing/replay.
```

### Eligible third-party plugin

```text
Need: weather.forecast.read
Checked:
✓ no Registry owner
✓ trusted catalog has community/weather-kit
✓ DSH 0.1.0-rc.8 compatible, declared seam weather.forecast
Recommendation: ADOPT EXISTING community/weather-kit
Not done: install, import, approve, or mount.
```
