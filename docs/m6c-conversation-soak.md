# M6C conversation soak record

Status: **unresolved** (no live `DEEPSEEK_API_KEY` in this implementation environment; packed `tars-ng doctor` / `start --once` remain covered by `test/packaging.test.ts`)

This is the secret-safe record required before labeling Candidate Workbench conversation self-development **Verified**.

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

A live conversation was not available in the implementation environment. Do not treat Workbench conversation self-development as **Verified** until a secret-safe human soak records a real `text.slugify` loop: resolve → scaffold → bounded edit → diagnostics/repair if needed → seal + Independent Review → approval request → human approve+activate → later session uses the isolated tool → restart reconstructs → human rollback to LKG.

Do not paste credentials, tokens, home paths, or candidate source dumps into this file.
