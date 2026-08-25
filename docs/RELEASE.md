# Release notes

Personal-assistant product layer on DeepSeek Harness **0.1.0-rc.8**. Current package version: **0.3.0**. Not a production security certification. Not published to a public registry.

## Version baseline

| Version | Meaning |
| --- | --- |
| **v0.1.0** | Assistant Core MVP baseline |
| **v0.2.0** | Governed Self-Extension baseline |
| **v0.3.0** | Governance + Mission-Control product baseline (historical soak seal) |
| **v0.4.0 target** | Runtime Foundation + Governed Extension Baseline |

The repository package version is `0.3.0`. The annotated `v0.3.0` git tag is created only on the exact `main` commit after this seal is merged. Do not move or recreate that tag; later soak fixes are `v0.3.1`, `v0.3.2`, etc.

DSH dependency versions stay at **0.1.0-rc.8**. They are not changed by this product version bump.

`npm run verify:v0.2` remains the regression contract for the historical Governed Self-Extension baseline. v0.3.0 must continue to pass it.

Seal evidence and soak configuration: [docs/v0.3.0-seal.md](./v0.3.0-seal.md). Feature freeze: [docs/soak.md](./soak.md).

## v0.3.0 Product Soak baseline

This is the current release. It seals the product that already exists:

```text
M1 Governed Self-Extension
M2 capability reuse / discovery
M3 reliability gates
M4 independent review / self-correction
M5 personality / Mission-Control Workspace + local Web UI
Product Readiness (installable tars-ng, home, secrets, default DeepSeek route)
```

Default soak LLM:

```text
provider: deepseek-official
model: deepseek-v4-flash
credential: DEEPSEEK_API_KEY
```

Daily soak surface: loopback Mission-Control Web UI from `tars-ng start` (`http://127.0.0.1:8787`).

`v0.3.0` remains the immutable historical Governance + Mission-Control baseline. Do not retag it. Development toward **v0.4.0 — Runtime Foundation + Governed Extension Baseline** starts with a host-owned Profile / Workspace / Session Runtime Context, then topic conversations in one bound context (Session Catalog), then the already-shipped generated-extension lifecycle. Self-development is allowed; self-authorization is not. Third-party install and Skill lifecycle are not claimed by this baseline.

## Direction after v0.4.0

v0.4.0 is the governed construction/control substrate, not the completion of a no-code professional-system builder. After it is sealed, real daily use should drive defects and usability fixes before broad platform expansion.

The directional milestones are:

| Milestone | Product question |
| --- | --- |
| **v0.4.0 — Runtime Foundation + Governed Extension Baseline** | Can TARS-NG bind one Home to a Profile, Workspace, and durable current Session, then construct, validate, review, approve, activate, observe, and recover a generated capability without self-authorization? |
| **Typed Capability Broker** | Can a generated capability safely compose narrowly scoped host operations without receiving arbitrary runtime, filesystem, network, process, or secret access? |
| **Domain Construction Slice** | Can a professional who does not know TypeScript or DSH describe one bounded domain need and obtain an explicit, testable, governed capability? |
| **Host-Rendered Domain UI** | Can that governed capability produce a useful professional work surface without creating frontend-owned authority or state? |
| **Professional Application Composition** | Can several governed capabilities, domain adapters, policies, and UI components be composed into a coherent professional AI system? |

These later names are directional, not release commitments. The longer hypothesis also includes durable domain workspaces, governed triggers, professional capability packs, and domain-professional vibe coding. Finance, HR, Legal, and Operations kits remain future product layers. They must reuse the same governance invariants rather than introducing a privileged generation or activation path. See [product-vision.md](./product-vision.md).

## v0.2.0 Verified (Governed Self-Extension)

Historical Governed Self-Extension baseline. These remain true and are not rewritten as the current product version:

```text
Capability Resolution
Candidate Workspace + restricted validation
Exact human approval
Transactional activation
First real generated capability E2E
Rollback / LKG
Durable restart reconstruction
Safe Mode recovery
Trusted operator control
```

- Capability Registry / ownership visibility (`ctx.capabilityRegistry`, conservative Core MVP bootstrap)
- Capability Resolution Review (`ctx.capabilityResolution.review`): advisory reuse → configure → evolve → adopt → provider → new-plugin; unknown is not a new plugin
- Candidate workspace + restricted validation (`ctx.candidateWorkspace`, `ctx.candidateValidation`): inactive artifacts, digest-bound evidence; `validated` is not approval
- Exact human approval of the candidate/diff; model/tools cannot mint `TrustedAuthorityCredential`
- Transactional activation: Registry switch + runtime mount only after health; crash before the durable authority commit leaves prior LKG authoritative
- First generated capability E2E: Obsidian Vault (`test/obsidian-e2e.test.ts`)
- Rollback / LKG: `current` is not automatically LKG; LKG advances only after health + durable commit
- Durable restart reconstruction (`$TARS_NG_HOME/self-extension`, alias `$DSH_ASSISTANT_HOME`): one atomic `authority.json` snapshot; remount only generated owners in the committed activation snapshot after a full artifact/digest preflight
- Safe Mode recovery: excludes generated/optional extensions; missing/mutated/corrupt state fails closed
- Trusted operator control: `npm run self-extension` (`docs/self-extension-operations.md`); recovery authority stays outside generated and model-facing seams
- v0.2.x stabilization: product-level regression/recovery drills, durable-state backup/restore, `npm run verify:v0.2` (`docs/v0.2-stabilization.md`)

Preserved invariants: Self-extension without self-authorization; Validation ≠ Approval; Approval ≠ Activation; exact candidate/diff binding; fail-closed artifact integrity.

## v0.1.0 Verified

Historical Assistant Core MVP baseline. These remain true and are not rewritten as the current product version:

- DSH-native boot on public plugins (no custom Agent Loop)
- Personal memory (CRUD, conflicts, JSON persistence, malformed snapshot rejection)
- Personal knowledge (local lexical retrieve, citations, memory boundary)
- Fake integration seams (read vs propose, structured errors)
- Trust/policy L0–L4 (confirm, deny, cancel, replay, single execution)
- Process-local jobs / morning-brief scheduler (not durable across restart)
- UI projection + control surface (`followup` wakes the agent)
- Plan My Day vertical slice through the real loop, recorded in `docs/vertical-slice.md`
- Package/profile metadata, remount without duplicate tools, `npm pack` ship list
- Official DSH 0.1.0-rc.8 profile/bundle load (`loadProfile` / `renderConfigDump` / `boot`): assistant patch applied, `remember_memory` mounted, dispose + remount keeps one copy

## Implemented only (not live providers)

- `FakeReplyAdapter` and `PlanMyDayAdapter` — scripted local LLM adapters for tests/`ui`/`slice`
- `FakeIntegrationSuite` — in-process calendar/mail/tasks/files/contacts (explicit fixtures only)

## Unsupported

- Multi-model routing and extra providers for optionality
- Pixel-perfect or mobile UI
- Vector DB, crawler, hosted production persistence
- Durable user-level reminders (prefer a future official DSH Schedule seam)
- Public npm publish from this repository
- Automatic install/upgrade/remove or self-authorization
- OAuth refresh for Google Calendar (replace the expiring access token manually)
- New Google Search product wiring (credentials are diagnosed by name only)
