# M6C conversation soak record

Status: **unresolved**. Issues #70 and #72 stay open. The conversation-operable Workbench slice, WUI activation path, and READY-state user-plugin uninstall path are **Implemented** only; they are not Verified and do not satisfy those issues' Definition of done. Targeted uninstall is not the remaining global LKG rollback discoverability item.

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

A live conversation was not available in the implementation environment. Do not treat Workbench conversation self-development or WUI activation (#72) as **Verified** until a secret-safe human soak records a real `text.slugify` loop: resolve → scaffold → bounded edit → diagnostics/repair if needed → seal + Independent Review → approval request → WUI approve (still inactive) → WUI activate → later session uses the isolated tool → restart reconstructs → human rollback to LKG.

Do not paste credentials, tokens, home paths, or candidate source dumps into this file.
