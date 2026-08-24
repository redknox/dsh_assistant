# M6C conversation soak record

Status: **unresolved**. Issue #76 stays open until a secret-safe human soak records READY-state **Rollback system state** after a live `text.slugify` activation. The conversation-operable Workbench slice, WUI activation, uninstall, and rollback projection paths are **Implemented** only; they are not Verified.

This implementation environment has no configured `DEEPSEEK_API_KEY` / `deepseek-official` soak route. Packed `tars-ng doctor` / `start --once` remain covered by `test/packaging.test.ts`. Do not treat that as a live-model soak.

## Deterministic CI

`test/conversation-self-dev.test.ts` is the mandatory scripted-model E2E. It is not a live-model soak.

## Real-model soak

| Field | Value |
| --- | --- |
| Date | 2026-08-23 |
| Environment | not run in this slice |
| Model / provider | — |
| Secrets recorded | none |
| Outcome | **unresolved** |

A live conversation was not available in the implementation environment. Do not treat WUI rollback (#76) as **Verified** until a secret-safe human soak records: activate `text.slugify` through WUI → model uses the tool → READY-state Rollback Card confirm → later session and restart keep the plugin unmounted → candidate/audit history remains inspectable.

Do not paste credentials, tokens, home paths, or candidate source dumps into this file.
