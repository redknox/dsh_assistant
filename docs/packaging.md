# Package and profile

How to install, boot, remove, and remount `dsh-assistant` as a DSH-native product. Targeted DSH version: **0.1.0-rc.8**. This package stays `private`; do not publish to a public registry from this issue.

## Composition

| Piece | Location | Role |
| --- | --- | --- |
| Product bundle | `package.json` → `dsh.bundle.patch` = `cordis.patch.yml` | Inserts plugin id `dsh-assistant` |
| Bundle entry | `src/product/bundle.ts` (`name`, `inject`, `apply`) | Loads memory, knowledge, integrations, policy, jobs, persona |
| Example profile | `profiles/assistant/` | `dsh.profile.bundles`: `@deepseek-ai/dsh-base` then `dsh-assistant` |
| Headless boot | `npm run boot` | Public DSH plugins + product bundle, one agent, dispose |

The profile overlay `profiles/assistant/cordis.patch.yml` is empty so composition stays in bundle patches.

## Fresh environment

Required:

- Node `>=22`
- npm
- This repository (or a packed `dsh-assistant-0.1.0.tgz` plus the same DSH 0.1.0-rc.8 dependencies)

```sh
npm install
npm run typecheck
npm test
npm run build
npm run boot
```

`npm run boot` does not call a live LLM. Optional replays: `npm run ui`, `npm run slice`.

Inspect the ship list without publishing:

```sh
npm run pack:inspect
```

Intended pack contents: `package.json`, `README.md`, `cordis.patch.yml`, and `dist/**`. Not shipped: `src/`, `test/`, `fixtures/`, `docs/`, `profiles/`, `.env*`, credentials.

## Configuration (no secrets in git)

| Variable | Required | Purpose |
| --- | --- | --- |
| `DSH_ASSISTANT_MEMORY` | no | `json-file` to persist memory locally; default is in-memory |
| `DSH_ASSISTANT_MEMORY_PATH` | no | Local JSON path when memory is `json-file` (default `.dsh-assistant/memory.json`, gitignored) |
| `DSH_ASSISTANT_KNOWLEDGE_FIXTURES` | no | Comma-separated **explicit** file paths to ingest; never a home-directory scan |

Live model API keys and vendor OAuth tokens are **not** product env vars. They belong to a DSH LLM adapter plugin or a replaceable integration provider you load yourself. Do not commit `.env`, tokens, or real personal ids.

Optional capability providers (replaceable, not required to boot):

| Provider | Default in this repo | Status |
| --- | --- | --- |
| LLM adapter | none on `npm run boot`; scripted fakes on `ui` / `slice` | Fake adapters **Implemented**; live DeepSeek/other accounts **Unsupported** |
| Calendar / mail / tasks / files / contacts | `FakeIntegrationSuite` | Fake suite **Verified** for read/propose/error; vendor accounts **Unsupported** |
| Memory persistence | in-memory; optional local JSON | JSON adapter **Verified**; hosted DB **Unsupported** |
| Knowledge ingest | none, or explicit fixture paths | Local lexical index **Verified**; crawler/vector DB **Unsupported** |

## Lifecycle

Product plugins register tools/services through Cordis effects. Disposing the product fiber (or the whole context) must drop `personalMemory`, `personalKnowledge`, `actionPolicy`, `assistantJobs`, and the product tools. Loading the bundle again on the same DSH stack must restore one copy of each name, not duplicates.

`npm test` covers unload + remount of the product fiber on `bootAssistantRuntime()`, and a separate official DSH profile/bundle smoke in the same file.

## Official DSH profile/bundle smoke (0.1.0-rc.8)

Issue #11 requires the example profile to be loaded by DSH itself, not only by this repository's `bootAssistantRuntime()`.

Exact APIs (same composition `dsh --profile assistant --dump-config` / `dsh --profile assistant` use):

| Step | `@deepseek-ai/dsh-app-boot` API | CLI equivalent |
| --- | --- | --- |
| Create `$DSH_HOME/profiles/assistant` | `initProfile` + `resolveProfileDir` | `dsh plugin --profile assistant add <this package>` |
| Resolve `dsh.profile.bundles` and each bundle patch | `loadProfile` | profile boot / dump |
| Print layered tree | `renderConfigDump` | `dsh --profile assistant --dump-config` |
| Compose rows | `composeEntries` | same algorithm dump/boot share |
| Mount the tree | `boot` | `dsh --profile assistant` |
| Unload / remount | dispose the root fiber, then `boot` again | SIGINT/SIGTERM dispose, then start again |

Observed in `test/packaging.test.ts` (isolated `$DSH_HOME`, DSH 0.1.0-rc.8):

- `loadProfile` resolves `@deepseek-ai/dsh-base` then `dsh-assistant`.
- `renderConfigDump` includes `# == @deepseek-ai/dsh-base`, `# == dsh-assistant`, and `id: dsh-assistant`.
- `composeEntries` contains exactly one `dsh-assistant` row, plus base rows `agent` and `system-prompt`.
- `boot` mounts `remember_memory` and `personalMemory`.
- Dispose drops those registrations; a second `boot` restores one copy of each (three unique assistant jobs).

The smoke overlay disables the base `hmr` row (Loader internals are not exposed under `tsx --test`) and sets `jobs.autoTickMs: null`. That overlay is test-only; the shipped example `profiles/assistant/cordis.patch.yml` stays `[]`.
