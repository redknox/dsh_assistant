# Package and product artifact

How to install and operate TARS-NG (`tars-ng`) as a DSH-native product. Targeted DSH version: **0.1.0-rc.8**. This package stays `private`; do not publish to a public registry from this issue.

Operator-facing install/start/secrets: [operator.md](./operator.md). Soak/freeze: [soak.md](./soak.md).

## Composition

| Piece | Location | Role |
| --- | --- | --- |
| Product command | `bin.tars-ng` → `dist/product/bin.js` | `start` / `status` / `doctor` / `stop` / `self-extension` |
| Product bundle | `package.json` → `dsh.bundle.patch` = `cordis.patch.yml` | Inserts plugin id `dsh-assistant` |
| Bundle entry | `src/product/bundle.ts` (`name`, `inject`, `apply`) | Loads registry, candidate, review, personality, governance, then optional memory/knowledge/integrations/policy/jobs |
| Example profile | `profiles/assistant/` | `dsh.profile.bundles`: `@deepseek-ai/dsh-base` then `dsh-assistant` |
| Runtime Context | `$TARS_NG_HOME/config/product.json` + `state/runtime-context.json` | Profile / Workspace / Session binding; [runtime-context.md](./runtime-context.md) |
| Headless product start | `tars-ng start --once` | Compiled `dist/` entry; no `tsx` |

The profile overlay `profiles/assistant/cordis.patch.yml` is empty so composition stays in bundle patches.

## Fresh environment

Required:

- Node `>=22`
- npm
- A packed `dsh-assistant-0.3.0.tgz` (or this repository for contributors)

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack
tars-ng start --once
```

Inspect the ship list without publishing:

```sh
npm run pack:inspect
```

Intended pack contents: `package.json`, `README.md`, `cordis.patch.yml`, and `dist/**` (including `dist/product/bin.js` and `dist/web/` UI assets). Not shipped: `src/`, `web/` source, `test/`, `fixtures/`, `docs/`, `profiles/`, `.env*`, credentials, user home state.

`test/packaging.test.ts` installs that tarball into a clean directory and runs `tars-ng doctor` / `start --once` with an isolated product home. Missing `DEEPSEEK_API_KEY` must make `start` exit non-zero without a pid; an injected test key plus a resolvable default route must make `start --once` succeed. A subsequent `tars-ng start` must serve the packed Web UI from `dist/web` without Vite, `tsx`, or `src/`.

## Configuration (no secrets in git)

Precedence: CLI flag → environment → env file → `product.json` → default. See [operator.md](./operator.md).

| Variable | Required | Purpose |
| --- | --- | --- |
| `TARS_NG_HOME` | no | Product home (default `~/.local/share/tars-ng`) |
| `DSH_ASSISTANT_HOME` | no | Compatibility alias for the same home |
| `TARS_NG_UI_PORT` | no | Loopback Web UI port (default `8787`; `0` selects an ephemeral port) |
| `TARS_NG_UI_HOST` | no | Must be loopback (`127.0.0.1` / `localhost` / `::1`) |
| `DEEPSEEK_API_KEY` | yes (for AI) | Secret. Official DeepSeek adapter; never commit |
| `DSH_ASSISTANT_GOOGLE_CALENDAR_MODE` | no | `live` selects the host-bounded Google Calendar transport |
| `DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN` | no | Secret. OAuth access token; expires; never commit |
| `DSH_ASSISTANT_SANDBOX_ROOT` | no | Existing directory for confined files/tasks (`~` allowed; not a symlink) |
| `GOOGLE_SEARCH_API_KEY` | no | Secret. Diagnosed by name; Search is not shipped |
| `GOOGLE_SEARCH_ENGINE_ID` | no | Non-secret config. Diagnosed by name; Search is not shipped |
| `DSH_ASSISTANT_MEMORY` | no | Contributor boot: `json-file` (product CLI already persists under home) |
| `DSH_ASSISTANT_KNOWLEDGE_FIXTURES` | no | Comma-separated **explicit** file paths; never a home-directory scan |

Live `DEEPSEEK_API_KEY` belongs in the env file, not git. Do not commit `.env`, tokens, or real personal ids.

Optional capability providers (replaceable, not required to boot):

| Provider | Default in product CLI | Status |
| --- | --- | --- |
| LLM adapter | `deepseek-official` / `deepseek-v4-flash` via `@deepseek-ai/dsh-llm-deepseek` | **Implemented** in the product runtime; live calls need `DEEPSEEK_API_KEY`. Fake adapters remain for tests/`ui`/`slice` |
| Calendar | **unavailable** unless live token+mode or explicit fixtures | Fake suite **Verified** for tests; product default does not return fixture events as live data |
| Memory persistence | `$TARS_NG_HOME/data/memory.json` | JSON adapter **Verified**; hosted DB **Unsupported** |
| Knowledge ingest | none, or explicit fixture paths | Local lexical index **Verified** |

## Lifecycle

Product plugins register tools/services through Cordis effects. Disposing the product fiber (or the whole context) must drop `personalMemory`, `personalKnowledge`, `actionPolicy`, `assistantJobs`, and the product tools. Loading the bundle again on the same DSH stack must restore one copy of each name, not duplicates.

`tars-ng start` acquires `$TARS_NG_HOME/state/runtime.lock/`, writes `$TARS_NG_HOME/state/tars-ng.pid` as liveness metadata, serves packed Web UI assets from `dist/web` on loopback, and records the URL in last-status. `tars-ng stop` authenticates that lease with a loopback run-token challenge and does not signal a PID. A TARS-NG Home has at most one verified writer. Uninstalling the npm package does not delete `$TARS_NG_HOME`. Production runtime does not depend on Vite or `tsx`.

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
- `profiles/assistant-safe` sets `safeMode: true` so optional integrations/jobs never load; recovery/governance inspect tools remain.

The smoke overlay disables the base `hmr` row (Loader internals are not exposed under `tsx --test`) and sets `jobs.autoTickMs: null`. That overlay is test-only; the shipped example `profiles/assistant/cordis.patch.yml` stays `[]`.
