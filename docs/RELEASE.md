# Release notes

Personal-assistant product layer on DeepSeek Harness **0.1.0-rc.8**. Not a production security certification. Not published to a public registry.

## Version baseline

| Version | Meaning |
| --- | --- |
| **v0.1.0** | Assistant Core MVP baseline |
| **v0.2.0** | Governed Self-Extension baseline (resolution, restricted validation, exact approval, transactional activation, generated capability, rollback/LKG, **durable restart reconstruction**, Safe Mode recovery, operator control) |

This repository does not create or push the `v0.2.0` git tag in this change. Tagging is a separate release step.

## v0.2.0 Verified (Self-Extension durability)

- Durable `$DSH_ASSISTANT_HOME/self-extension` authority file (schema v1, atomic write) with explicit Registry / Governance / Activation / Recovery sections
- Candidate artifacts + index survive restart; directory presence is not activation
- Fresh boot remounts only committed generated actives after digest verification
- Interrupted pre-commit activation keeps prior LKG; post-commit crash remounts the new version
- Safe Mode, missing/mutated artifact, and corrupt schema fail closed with recovery control still available
- Operator CLI: `npm run self-extension` (`docs/self-extension-operations.md`)

## v0.1.0 Verified

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
- Capability Registry / ownership visibility (`ctx.capabilityRegistry`, conservative Core MVP bootstrap)
- Capability Resolution Review (`ctx.capabilityResolution.review`): advisory reuse → configure → evolve → adopt → provider → new-plugin; unknown is not a new plugin
- Candidate workspace + validation (`ctx.candidateWorkspace`, `ctx.candidateValidation`): inactive artifacts, digest-bound evidence; `validated` is not approval
- Extension governance / activation / recovery: exact-diff approval, transactional Registry switch, LKG, Safe Mode; no self-authorization
- First Self-Extension generated-plugin slice: Obsidian Vault (`test/obsidian-e2e.test.ts`)

## Designed only

- Self-Extension architecture and governance ([docs/self-extension.md](./self-extension.md)): public DSH seams only; no self-authorization. The first generated vertical slice is the Obsidian Vault path.

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
