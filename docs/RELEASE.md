# Release notes — 0.1.0

Personal-assistant product layer on DeepSeek Harness **0.1.0-rc.8**. Not a production security certification. Not published to a public registry.

## Verified

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

## Designed only

- Self-Extension architecture and governance ([docs/self-extension.md](./self-extension.md)): public DSH seams only; no self-authorization; reuse before new plugins. Registry visibility is **Verified**; resolution and install remain later work.

## Implemented only (not live providers)

- `FakeReplyAdapter` and `PlanMyDayAdapter` — scripted local LLM adapters
- `FakeIntegrationSuite` — in-process calendar/mail/tasks/files/contacts

## Unsupported

- Live LLM accounts and vendor OAuth
- Pixel-perfect or mobile UI
- Vector DB, crawler, hosted production persistence
- Durable user-level reminders (prefer a future official DSH Schedule seam)
- Public npm publish from this repository
- Capability Registry, autonomous plugin generation, and automatic install/upgrade/remove
