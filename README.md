# DSH Assistant

A **personal AI-native software layer** built on [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

DSH is the generic Harness/runtime. This repository is the personal-assistant **product** that sits on top of DSH public seams.

## What this is

A personal assistant product layer: persona, memory, knowledge, personal tools, trust/policy, integrations, proactive workflows, and product/UI experience.

DSH owns agent loop, sessions, tool execution, events, LLM/provider seams, jobs, lifecycle, and plugin composition. This project **composes and extends** those capabilities; it does not reimplement them.

## What this is not

- Not a fork of DSH core, and not a custom Agent Loop.
- Not a general multi-agent framework.
- Not a dump of business logic into model-callable tools.
- Not a place to commit credentials or real personal data.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for layers and ownership. See [ENGINEERING.md](./ENGINEERING.md) for normative contributor rules.

## Product position

```text
UI / Channels
      ↓
Personal Assistant Product Layer
      ↓
Personal Services (memory / knowledge / policy / tools / integrations)
      ↓
DSH public services, providers, tools, events, jobs, session APIs
      ↓
LLMs / storage / external systems
```

Application features must depend only on **DSH public** plugin, service, provider, event, job, and session APIs. They must **not** import or modify DSH package-internal Agent Loop implementation or other `src/*` internals.

## MVP scope

The first useful release is documentation-first, then a thin product loop that can:

1. Run as a DSH plugin composition (persona + a small set of personal tools).
2. Distinguish **read / propose / execute** trust levels for actions that touch the user's world.
3. Separate **personal memory** (durable user-specific state) from **knowledge retrieval** (lookup of reference material).
4. Keep domain logic independent of any one model or UI channel.

MVP does **not** include a custom runtime, a custom Agent Loop, a speculative multi-agent framework, or a forced database choice.

## Non-goals

- Runtime implementation in issue #1 (contracts only). Later issues may add a DSH-native scaffold.
- Pixel-perfect UI or mobile apps.
- Forcing a database unless a later issue requires it.
- Custom Agent Loop or patching DSH internals.
- Speculative multi-agent framework.
- Committing external service credentials or real personal data.

## Evidence language

Do not call a capability **Verified** without reproducible evidence. Use:

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
| DSH public plugin boot + one agent | yes | **Verified** by `npm test` | No custom Agent Loop |
| Personal memory + local JSON adapter | no (in-memory default) | **Verified** by `npm test` | Hosted DB **Unsupported** |
| Personal knowledge (local lexical index) | no | **Verified** by `npm test` | Vector DB / crawler **Unsupported** |
| Integration seams | yes (fake suite) | **Verified** (fake providers) | `FakeIntegrationSuite` is **Implemented**. Live vendor accounts are **Unsupported** |
| Trust/policy L0–L4 | yes | **Verified** by `npm test` | Confirmation binds fingerprint |
| Process-local jobs / morning brief | yes | **Verified** by `npm test` | Cross-restart durability **Unsupported** |
| UI projection + control surface | no | **Verified** by `npm test` | Pixel/mobile UI **Unsupported** |
| Plan My Day vertical slice | no | **Verified** by `test/vertical-slice.test.ts` | Uses scripted `PlanMyDayAdapter` + fake calendar, not a live model |
| Scripted local LLM adapters | no | **Implemented** | `FakeReplyAdapter`, `PlanMyDayAdapter`. A live LLM account is **Unsupported** |
| DSH bundle + example profile + remount | yes (metadata) | **Verified** by `test/packaging.test.ts` | Official `loadProfile` / `boot` path, not only `bootAssistantRuntime()`. See [docs/packaging.md](./docs/packaging.md) |
| Self-Extension governance | no | **Verified** | Registry → review → candidate → exact-diff approval → activate → rollback → **restart reconstruction**. Slices: [Obsidian](./docs/obsidian-self-extension.md), [Calendar](./docs/calendar-self-extension.md). Operator runbook: [docs/self-extension-operations.md](./docs/self-extension-operations.md). Autonomous install remains **Unsupported** |
| Capability Registry / ownership | no | **Verified** by `test/registry.test.ts` | Answers **What do I have?** only. See [docs/capability-registry.md](./docs/capability-registry.md) |
| Capability Resolution Review | no | **Verified** by `test/resolution.test.ts` | Answers **What should change?** only. Advisory; no install. See [docs/capability-resolution.md](./docs/capability-resolution.md) |
| Capability Discovery | no | **Verified** by `test/discovery.test.ts` | Answers **what existing implementation may be available?** Local DSH/catalog evidence only; never installs. See [docs/capability-discovery.md](./docs/capability-discovery.md) |
| Candidate workspace + validation | no | **Verified** by `test/candidate.test.ts` | Builds/validates an inactive artifact. `validated` is not approval. See [docs/candidate-workspace.md](./docs/candidate-workspace.md) |
| Engineering reliability | no | **Verified** by `test/reliability.test.ts` | Risk class + Risk Model gate before `validated`. Fixture ≠ provider. See [docs/engineering-reliability.md](./docs/engineering-reliability.md) |
| Independent review | no | **Verified** by `test/review.test.ts` | Fresh-context review of a sealed digest. `review-complete` is not approval. See [docs/independent-review.md](./docs/independent-review.md) |
| TARS-NG personality + Mission-Control workspace | no | **Verified** by `test/personality.test.ts`, `test/workspace.test.ts` | Three-layer personality; workspace projected from public runtime/governance state. See [docs/tars-ng-personality.md](./docs/tars-ng-personality.md) |
| Extension governance / activation / recovery | no | **Verified** by `test/governance.test.ts` | Exact-diff approval + transactional activate + LKG/Safe Mode. See [docs/extension-governance.md](./docs/extension-governance.md) |
| Production persistence, public npm publish | no | **Unsupported** | Package is `private` |

Known limitations: no live provider credentials, no production security certification, no durable user-level Schedule, no mobile distribution. Release status: [docs/RELEASE.md](./docs/RELEASE.md).

## Develop

```sh
npm install
npm run typecheck
npm run test
npm run build
npm run boot
npm run ui
npm run slice
npm run verify:v0.2
npm run pack:inspect
```

`npm run boot` starts a headless Cordis composition using public DSH services (`ctx.agents`, `ctx.systemPrompt`, …), creates one assistant session, then disposes it. It does not call a live LLM.

`npm run ui` boots the same stack, sends one message through the public agent followup seam (fake local LLM adapter), and prints a text control-surface snapshot. It does not call a live LLM.

`npm run slice` replays the Plan My Day vertical slice (scripted local LLM, fake calendar/tasks). See [docs/vertical-slice.md](./docs/vertical-slice.md).

`npm run verify:v0.2` reruns the offline v0.2.x release-confidence suite (recovery drills + backup/restore). See [docs/v0.2-stabilization.md](./docs/v0.2-stabilization.md). It is not a production security certification.

Composition is replaceable: this package declares `dsh.bundle` (`cordis.patch.yml`). An example profile lives in `profiles/assistant/`. Fresh-environment install, config, and secret-injection rules: [docs/packaging.md](./docs/packaging.md).

## Documents

| File | Role |
| --- | --- |
| [README.md](./README.md) | Product vision, boundary, MVP, non-goals |
| [ENGINEERING.md](./ENGINEERING.md) | Normative rules for humans and AI contributors |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Layers, ownership, dependency direction, extension seams |
| [docs/vertical-slice.md](./docs/vertical-slice.md) | Issue #10 Plan My Day evidence (versions, commands, fakes, observed results) |
| [docs/packaging.md](./docs/packaging.md) | Bundle/profile, fresh install, config without secrets, remount |
| [docs/self-extension.md](./docs/self-extension.md) | Self-Extension contract: provenance, review, approval, rollback |
| [docs/capability-registry.md](./docs/capability-registry.md) | Registry: What do I have? ownership, conflicts, bootstrap |
| [docs/capability-resolution.md](./docs/capability-resolution.md) | Resolution: What should change? ordered review, evidence |
| [docs/candidate-workspace.md](./docs/candidate-workspace.md) | Candidate workspace + validation: Can I build it safely? |
| [docs/engineering-reliability.md](./docs/engineering-reliability.md) | Reliability gate: is the claimed behavior still correct under failure? |
| [docs/independent-review.md](./docs/independent-review.md) | Independent review: self-development without self-certification |
| [docs/tars-ng-personality.md](./docs/tars-ng-personality.md) | TARS-NG personality contract, traits, invariants, corpus |
| [docs/mission-control-workspace.md](./docs/mission-control-workspace.md) | Mission-Control IA, system state, approval/Safe Mode UX |
| [docs/tars-ng-architecture-mapping.md](./docs/tars-ng-architecture-mapping.md) | M5 mapping onto existing public DSH/Assistant seams |
| [docs/extension-governance.md](./docs/extension-governance.md) | Governance: May it become active? Recovery / Safe Mode |
| [docs/v0.2-stabilization.md](./docs/v0.2-stabilization.md) | v0.2.x regression, recovery drills, backup/restore |
| [docs/RELEASE.md](./docs/RELEASE.md) | 0.2.0 status: Verified vs Implemented vs Unsupported; v0.1.0 remains the historical Core MVP |
