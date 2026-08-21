# Release notes

Personal-assistant product layer on DeepSeek Harness **0.1.0-rc.8**. Current package version: **0.2.0**. Not a production security certification. Not published to a public registry.

## Version baseline

| Version | Meaning |
| --- | --- |
| **v0.1.0** | Assistant Core MVP baseline |
| **v0.2.0** | Governed Self-Extension baseline |

The repository package version is `0.2.0`. Creating and pushing the annotated `v0.2.0` git tag remains a separate explicit release action after review.

DSH dependency versions stay at **0.1.0-rc.8**. They are not changed by this product version bump.

## v0.2.0 Verified (Governed Self-Extension)

This is the current release. It adds a governed Self-Extension loop on top of the v0.1.0 Core MVP, without weakening those invariants:

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
- M5 product-readiness: installable `tars-ng` artifact, product home, external secrets, doctor/status, fixture vs live Calendar, soak/freeze (`docs/operator.md`, `docs/soak.md`)

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

- `FakeReplyAdapter` and `PlanMyDayAdapter` — scripted local LLM adapters
- `FakeIntegrationSuite` — in-process calendar/mail/tasks/files/contacts

## Unsupported

- Live LLM accounts and vendor OAuth
- Pixel-perfect or mobile UI
- Vector DB, crawler, hosted production persistence
- Durable user-level reminders (prefer a future official DSH Schedule seam)
- Public npm publish from this repository
- Autonomous plugin generation and automatic install/upgrade/remove
