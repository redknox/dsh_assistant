# Architecture

Target architecture for the personal assistant product layer on DeepSeek Harness (DSH). Runtime scaffold, personal services, and the UI projection/control surface in this repository are **Implemented**.

Normative contributor rules: [ENGINEERING.md](./ENGINEERING.md). Product boundary: [README.md](./README.md).

## Ownership

| Owner | Owns | Does not own |
| --- | --- | --- |
| **DSH** | Generic Harness/runtime: agent loop, sessions, tool execution, events, LLM/provider seams, jobs, lifecycle, plugin composition | Personal persona, user memory, personal knowledge product, trust policy for this assistant, personal integrations, product UI |
| **This repository** | Personal-assistant product: persona, memory, knowledge, personal tools, trust/policy, integrations, proactive workflows, UI/product experience | Replacing DSH Agent Loop, forking DSH internals, becoming a generic multi-agent framework |

**DSH is the Harness runtime, not the business/domain layer.** Domain rules belong in this repository's personal services (or in adapters that this repository owns), not in DSH core.

## Layers and dependency direction

Dependencies point **downward only**. Upper layers may call lower layers; lower layers must not depend on UI, channels, or a specific model.

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

| Layer | Responsibility |
| --- | --- |
| **UI / Channels** | Surfaces (chat, later other channels). Presentation and channel adapters only. No home for domain rules. |
| **Personal Assistant Product Layer** | Product orchestration: persona, turn-level product behavior, which personal services participate. Independent of any one UI. |
| **Personal Services** | Durable capabilities: memory, knowledge, policy, personal tool facades, integrations. Usable without a model and without a UI. |
| **DSH public APIs** | Plugin composition, public services/providers, tools, events, jobs, session APIs. The **only** allowed coupling to Harness. |
| **LLMs / storage / external systems** | Models, stores, third-party APIs. Reached through adapters. DTOs and vendor details stay behind those adapters. |

## Extension seams

This project must extend DSH through **public** plugin / service / provider / event / job / session seams (Cordis-style composition: reversible plugin effects, service definitions vs providers vs consumers).

**Forbidden:** application features depending on DSH package-internal Agent Loop classes or other DSH `src/*` internals. Do not import them, do not subclass them, do not copy them into this repo to “fix” behavior. Do not implement a custom Agent Loop.

Prefer **reversible plugin composition** (load/unload, `cordis`/profile layering) over modifying Harness core. One role (definition, provider, or consumer) is not a full capability seam; replace providers without rewriting consumers when DSH already exposes that split.

**Self-Extension** must use these same public seams. Governance contracts remain **Designed** ([docs/self-extension.md](./docs/self-extension.md)). Registry, Resolution, candidate validation, and governed activation/recovery are **Verified** ([docs/extension-governance.md](./docs/extension-governance.md)). Invariants: **self-extension without self-authorization**, and prefer reuse/evolution over new plugins. Assistant-generated code has no privileged runtime path. Registry `active` is metadata, not a mount. Approval is not activation. Recovery authority stays outside Self-Extension.

## Capability boundaries

These are separate capabilities. Do not merge them into a single “assistant blob” or into tool handlers.

| Capability | Responsibility | Not responsible for |
| --- | --- | --- |
| **Memory** | Durable, user-specific state with lifecycle (write, recall, forget, audit). | Document/corpus search; executing side effects. |
| **Knowledge** | Retrieval of reference material (files, notes, indexed sources) as lookup. | Treating every retrieved snippet as durable personal memory. |
| **Tools** | Model-callable adapters into domain/integration services. Thin: map arguments, call a service, return a result. | Owning all business logic, policy, or memory writes “because the tool ran.” |
| **Policy / trust** | What may be read, proposed, or executed; data that may become model-visible. | Being “implemented” only as prompt text. |
| **UI / channels** | How a human sees and confirms product behavior. | Domain correctness or Harness runtime. |
| **Integrations** | External systems behind adapters (calendar, mail, etc. when added). | Leaking provider DTOs into personal services or prompts. |

**Personal memory and knowledge retrieval are separate.** Memory is about the user over time. Knowledge is about finding material. A retrieval hit is not automatically a memory write.

**Tools are adapters**, not the domain layer. If a tool grows branches of business rules, those rules belong in a personal service.

## Trust levels

| Level | Meaning |
| --- | --- |
| **Read** | Inspect state or retrieve information. No intended side effect on the user's world. |
| **Propose** | Draft a change or plan. Visible to the user or policy layer; not applied. |
| **Execute** | Perform a side effect (send, write, delete, schedule, pay, etc.). Requires policy/confirmation appropriate to the action. |

Read, propose, and execute must remain distinct in architecture and later in implementation.

## Model-visible state

Anything placed in context for a model (prompts, tool results, memory excerpts, knowledge hits) must have:

- an **auditable source** (which service or adapter produced it)
- a **lifecycle** (why it is included, when it expires or is redacted, whether the user can see the same content)

Do not inject unsigned or unowned blobs into the model context.

## MVP vs later

**MVP:** compose on DSH public seams; keep domain independent of model/UI; separate memory, knowledge, tools, and policy; distinguish read / propose / execute; smallest useful product loop. Runtime scaffold and memory contracts are **Implemented** in this repo.

**Out of scope unless a later issue says otherwise (Unsupported here):** custom Agent Loop; speculative multi-agent framework; forced production database; pixel-perfect or mobile UI; credentials or real personal data in the repo; autonomous plugin generation or install.

## Evidence

This document is **Implemented** as a contract. Runtime boot, personal services, the UI control surface, the Plan My Day slice, the DSH bundle/profile pack, the Capability Registry, Capability Resolution Review, candidate workspace/validation, and governed activation/recovery are **Verified** by `npm test`. Scripted local LLM adapters and fake integration providers are **Implemented**. Self-Extension governance contracts remain **Designed** ([docs/self-extension.md](./docs/self-extension.md)). Live LLM accounts, vendor OAuth, pixel-perfect UI, RAG, production persistence, and autonomous install are **Unsupported**. See [docs/vertical-slice.md](./docs/vertical-slice.md), [docs/packaging.md](./docs/packaging.md), [docs/capability-registry.md](./docs/capability-registry.md), [docs/capability-resolution.md](./docs/capability-resolution.md), [docs/candidate-workspace.md](./docs/candidate-workspace.md), and [docs/extension-governance.md](./docs/extension-governance.md).
