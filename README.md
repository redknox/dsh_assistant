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

- Runtime implementation in this issue (contracts only).
- UI implementation in this issue.
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

Current status of this repository: product/engineering/architecture contracts are **Implemented** as documents; runtime and UI remain **Designed** / not started.

## Documents

| File | Role |
| --- | --- |
| [README.md](./README.md) | Product vision, boundary, MVP, non-goals |
| [ENGINEERING.md](./ENGINEERING.md) | Normative rules for humans and AI contributors |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Layers, ownership, dependency direction, extension seams |
