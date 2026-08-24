# TARS-NG

A governed AI-native product foundation on [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) public seams. Its current reference product is a personal assistant; its long-term purpose is to let domain professionals describe, construct, test, approve, and operate their own professional AI systems without granting generated code authority over itself.

Operators install and run `tars-ng`; they do not assemble DSH packages by hand or keep secrets in the repository.

Package name: `dsh-assistant` (private). Product command: **`tars-ng`**. DSH compatibility: **0.1.0-rc.8**. Node: **>=22**.

## Install

```sh
npm install
npm run build
npm pack
npm install -g ./dsh-assistant-0.3.0.tgz   # or: npm install ./dsh-assistant-0.3.0.tgz && npx tars-ng
```

The tarball install pulls Cordis/DSH runtime dependencies through npm. A public registry publish is not required. `src/` and `tsx` are not part of the runtime contract.

## Quick start

```sh
export TARS_NG_HOME="$HOME/.local/share/tars-ng"   # optional; this is the default
tars-ng doctor
tars-ng start
# Open the printed loopback URL, for example http://127.0.0.1:8787
tars-ng status
tars-ng stop
```

Daily use is the local Mission-Control **Web UI**. The CLI remains the operator path for install, doctor, status, stop, and recovery when the browser is unavailable. `tars-ng start --once` still boots and exits without waiting for a browser.

The Web UI binds **loopback only** (`127.0.0.1`, default port `8787`, override with `TARS_NG_UI_PORT`). It does not listen on public interfaces. Loading the UI sets an `HttpOnly; SameSite=Strict` process-local session cookie; conversation, approval, activation, and recovery mutations require that session. A control-plane approval decision is not a human conversation message; it belongs in Actions and Activity. Browser reconnect reloads a fresh authoritative snapshot; the browser does not own approval, activation, Safe Mode, or recovery state. Self-Extension activation is a second trusted action after exact-diff approval and requires an explicit confirmation field. An active generated/user plugin can be uninstalled from the READY-state Web UI with a trash action and a second confirmation; the model has no uninstall authority. Disabled exact revisions stay visible in the primary **Extensions** pane and can be reactivated through the same trusted activation path after a second confirmation. Disabled is not superseded. When an authoritative previous last-known-good snapshot differs from the current state, READY-state Mission-Control shows a **Rollback system state** card. That action restores the Recovery Root target and is not a single-plugin uninstall. Destructive recovery actions require an explicit second confirmation. **Exit Safe Mode** is the supported recovery operation; it is refused while an integrity failure still requires Safe Mode.

Home is `$TARS_NG_HOME`, else `$DSH_ASSISTANT_HOME`, else `~/.local/share/tars-ng`. Reinstalling package code does not delete it. A TARS-NG Home has at most one verified writer. A PID is liveness metadata, not process identity.

Required for AI (chmod 600, never git):

```sh
mkdir -p ~/.config/tars-ng && chmod 700 ~/.config/tars-ng
# DEEPSEEK_API_KEY=                            (required for a usable AI runtime)
# DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN=  (OAuth access token; expires; not an API key)
# GOOGLE_SEARCH_API_KEY=
# GOOGLE_SEARCH_ENGINE_ID=                     (non-secret config)
chmod 600 ~/.config/tars-ng/env
```

`tars-ng doctor` reports missing **names** only. Soak LLM baseline is `deepseek-official` / `deepseek-v4-flash`, shipped with the package. Missing `DEEPSEEK_API_KEY` does not block `doctor`/`status`, but `tars-ng start` exits non-zero with `LLM not configured/unavailable` and does not enter the running state. Core start does not require Google credentials. Default Calendar is **unavailable**, not a realistic fixture. Live Calendar: `DSH_ASSISTANT_GOOGLE_CALENDAR_MODE=live` plus the access token. When the token expires, replace it; TARS-NG does not refresh OAuth in this release.

Operator manual: [docs/operator.md](./docs/operator.md). Soak / feature freeze: [docs/soak.md](./docs/soak.md).

## What this is

A governed AI-native product layer and reference assistant: TARS-NG personality, Mission-Control workspace, memory, knowledge, trust/policy, integrations, governed Self-Extension, and operator lifecycle (`start` / `status` / `doctor`).

DSH owns agent loop, sessions, tool execution, events, LLM/provider seams, jobs, lifecycle, and plugin composition. This project **composes and extends** those public APIs. It does not reimplement them.

The current product validates the lower half of a future domain-professional authoring stack:

```text
Natural-language intent
        ↓
Specification / capability construction       (future domain-facing layer)
        ↓
Candidate authoring / validation / review      (current Workbench)
        ↓
Exact approval / activation / rollback         (current governance layer)
        ↓
DSH Agent Runtime                              (Harness)
```

The goal is not merely to give one assistant more tools. The goal is to make new capabilities safely constructible and composable, so future Finance, HR, Legal, or Operations kits can expose domain vocabulary, templates, policies, tests, and UI components above the same governed runtime.

Product thesis and stage boundaries: [docs/product-vision.md](./docs/product-vision.md).

## What this is not

- Not a fork of DSH core, and not a custom Agent Loop.
- Not a general multi-agent framework.
- Not yet a general-purpose no-code or domain-professional authoring product.
- Not permission for generated code to approve, activate, or certify itself.
- Not a dump of business logic into model-callable tools.
- Not a place to commit credentials or real personal data.
- Not a fixture Calendar/Search presented as live user data.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for layers. See [ENGINEERING.md](./ENGINEERING.md) for contributor rules.

## Evidence language

| Strength | Meaning |
| --- | --- |
| **Designed** | Written as intent/contract; not implemented. |
| **Implemented** | Present in this repository; not necessarily proven. |
| **Verified** | Covered by reproducible tests, checks, or recorded runs. |
| **Experimental** | Present but intentionally unstable or incomplete. |
| **Unknown** | Not assessed. |
| **Unsupported** | Out of scope or explicitly not offered. |

## Capability / evidence matrix

| Capability | Required to boot? | Evidence | Notes |
| --- | --- | --- | --- |
| Product/engineering/architecture contracts | yes (docs) | **Implemented** | README, ENGINEERING, ARCHITECTURE |
| Installable `tars-ng` artifact | yes | **Verified** by `test/packaging.test.ts` | pack → install → `tars-ng doctor` / `start --once` without `src/` or `tsx` |
| DSH public plugin boot + one agent | yes | **Verified** by `npm test` | No custom Agent Loop |
| Personal memory + local JSON adapter | no (in-memory default; product CLI uses home JSON) | **Verified** by `npm test` | Hosted DB **Unsupported** |
| Personal knowledge (local lexical index) | no | **Verified** by `npm test` | Vector DB / crawler **Unsupported** |
| Integration seams | product default: unavailable | **Verified** (fake providers in tests; product CLI disables fixtures) | Live vendor OAuth refresh **Unsupported** |
| Trust/policy L0–L4 | yes | **Verified** by `npm test` | Confirmation binds fingerprint |
| Process-local jobs / morning brief | yes | **Verified** by `npm test` | Cross-restart durability **Unsupported** |
| UI projection + control surface | no | **Verified** by `npm test` | Framework-independent DTOs remain |
| Local Mission-Control Web UI | no | **Verified** by `test/web-ui.test.ts` and packaging | Loopback-only; pixel/mobile **Unsupported** |
| Plan My Day vertical slice | no | **Verified** by `test/vertical-slice.test.ts` | Scripted adapter + fake calendar |
| DSH bundle + example profile + remount | yes (metadata) | **Verified** by `test/packaging.test.ts` | See [docs/packaging.md](./docs/packaging.md) |
| Self-Extension governance | no | **Verified** | Operator: `tars-ng self-extension` / [docs/self-extension-operations.md](./docs/self-extension-operations.md) |
| Capability Registry / Resolution / Discovery | no | **Verified** | See docs/capability-*.md |
| Candidate workspace + reliability + independent review | no | **Verified** | `review-complete` is not approval |
| Runtime Context (Profile / Workspace / Session) | yes (product start) | **Implemented** | One current session; [docs/runtime-context.md](./docs/runtime-context.md). Multi-session **Unsupported** |
| Generated authoring contract `generated-extension-api/v1` | no | **Implemented** | Host-owned; [docs/generated-extension-api-v1.md](./docs/generated-extension-api-v1.md) |
| TARS-NG personality + Mission-Control workspace | no | **Verified** | [docs/tars-ng-personality.md](./docs/tars-ng-personality.md) |
| Production persistence, public npm publish | no | **Unsupported** | Package is `private` |

Known limitations: no OAuth refresh, no production security certification, no durable user-level Schedule, no mobile distribution, no public or LAN Web UI. Release status: [docs/RELEASE.md](./docs/RELEASE.md). Soak baseline: [docs/v0.3.0-seal.md](./docs/v0.3.0-seal.md).

## Develop

```sh
npm install
npm run typecheck
npm run test
npm run build
npx tars-ng start --once --home /tmp/tars-ng-dev
npm run ui
npm run slice
npm run verify:v0.2
npm run pack:inspect
```

`review-complete` is not approval. Approval is not activation.

## Documents

| File | Role |
| --- | --- |
| [README.md](./README.md) | Product install, start, secrets, evidence matrix |
| [docs/operator.md](./docs/operator.md) | Installation through uninstall, Calendar token expiry, doctor |
| [docs/soak.md](./docs/soak.md) | Feature freeze and 2–4 week soak |
| [ENGINEERING.md](./ENGINEERING.md) | Normative rules for humans and AI contributors |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Layers, ownership, dependency direction |
| [docs/packaging.md](./docs/packaging.md) | Bundle/profile plus product tarball |
| [docs/runtime-context.md](./docs/runtime-context.md) | Profile / Workspace / Session identity and precedence |
| [docs/self-extension.md](./docs/self-extension.md) | Self-Extension contract |
| [docs/tars-ng-personality.md](./docs/tars-ng-personality.md) | Personality contract |
| [docs/mission-control-workspace.md](./docs/mission-control-workspace.md) | Mission-Control IA |
| [docs/product-vision.md](./docs/product-vision.md) | Product thesis, target users, boundaries, and post-v0.4 direction |
| [docs/RELEASE.md](./docs/RELEASE.md) | 0.3.0 Product Soak status |
| [docs/v0.3.0-seal.md](./docs/v0.3.0-seal.md) | Seal drill evidence and soak config |
