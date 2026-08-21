# Engineering contract

This document is **normative**. Humans and AI contributors must follow it. If a change conflicts with this file, change the design (and this file) first, or do not make the change.

Companion documents: [README.md](./README.md) (product boundary), [ARCHITECTURE.md](./ARCHITECTURE.md) (layers and seams), [docs/self-extension.md](./docs/self-extension.md) (Self-Extension governance).

## 1. Purpose

Keep the repository a personal-assistant **product layer** on DeepSeek Harness (DSH). DSH is the Harness runtime. This project must not become a second runtime, a DSH fork, or a dumping ground for unowned business logic.

## 2. Extension rules

1. Extend DSH only through **public** plugin, service, provider, event, job, and session APIs (the published seams). Prefer reversible plugin composition over modifying Harness core.
2. **Forbidden:** importing, wrapping, or modifying DSH package-internal Agent Loop classes, or any other DSH `src/*` internals. Application features must not depend on those internals.
3. Do not implement a custom Agent Loop. Do not patch DSH to “make the product work.”
4. Tools are **adapters** into domain or integration services. Domain rules, policy, memory, and knowledge live in personal services—not inside tool handlers.
5. Domain logic must remain usable without a specific model and without a specific UI.
6. External DTOs and provider-specific payloads stay behind adapters. Product types do not leak vendor shapes into the rest of the system.
7. Prefer the smallest useful release. Do not add speculative abstractions, extra agent frameworks, or unused configuration surfaces.

## 3. Security and trust

1. **Read**, **propose**, and **execute** are different trust levels. Do not collapse them. A lookup is not an action; a draft is not a side effect.
2. Model-visible state must have an auditable source and lifecycle (who wrote it, when, and whether it may be sent to a model).
3. Do not commit external service credentials, API keys, tokens, or real personal data.
4. Default to least privilege: personal tools that can change the user's world require explicit policy, not “the model asked.”
5. Treat LLM output as untrusted input to the rest of the system. Policy and execution gates are runtime, not prompt-only.

## 4. Evidence language

Claims about capabilities, compatibility, or completeness must use this vocabulary. Do not call a capability **Verified** without reproducible evidence.

| Term | Allowed use |
| --- | --- |
| **Designed** | Specified in docs or types; not shipped as behavior. |
| **Implemented** | Code or config exists in this repository. |
| **Verified** | Reproducible test, check, or recorded procedure passed; cite how to rerun it. |
| **Experimental** | Shipped or sketched with known instability; must be labeled. |
| **Unknown** | Not evaluated; must not be implied as working. |
| **Unsupported** | Explicitly out of scope or not offered. |

“Works with DSH” without a public seam and evidence is **Unknown**, not **Verified**.

## 5. Testing

1. Behavior that can affect the user's world needs an automated or scripted check before it is called **Verified**.
2. Prefer tests at personal-service and adapter boundaries. Do not require a live LLM to assert domain or policy rules.
3. Do not add large test harnesses or mock universes for code that does not exist yet.
4. Security-sensitive paths (execute vs propose, data leaving the device, credential handling) need explicit cases when those paths are Implemented.

## 6. Minimal-diff and scope

1. Change only what the issue or request requires. No drive-by refactors, formatting sweeps, or unrelated files.
2. Do not add UI, production persistence, or integrations unless a later issue asks for it.
3. No custom Agent Loop, no speculative multi-agent framework.
4. If a task needs a new abstraction, show a current caller. If there is no caller, do not add the abstraction.

## 7. Documentation and claims

1. Product “what / what not” lives in README. Architecture ownership lives in ARCHITECTURE.md. Contributor must-follow rules live here.
2. When implementation lands, update status with evidence language. Do not leave README claiming Verified behavior that is only Designed.

## 8. Self-Extension

Normative. Details: [docs/self-extension.md](./docs/self-extension.md).

1. **Self-extension without self-authorization.** The assistant may research, design, write, build, and test candidates. It must never authorize install, upgrade, remove, switch, or capability/permission expansion.
2. **Prefer reuse and evolution over capability proliferation.** A new plugin is the last option. Complete a Capability Resolution Review (reuse → configure → evolve → adopt → provider → new plugin) before proposing a new plugin.
3. Generated and managed plugins share the same public DSH plugin/runtime model. Provenance is metadata, not a privileged loader.
4. Active plugin code is immutable. Modifications produce a new candidate version.
5. Writing code is not authorization to execute or mount that code.
6. The Capability Registry is descriptive only. Resolution is advisory. Validation is evidence. Approval is a trusted-control record for an exact digest/diff. Activation is transactional. The assistant must not approve itself or rewrite the recovery root.
7. TARS-NG personality is expression and initiative, never authorization. Personality configuration must not grant capability, change permissions, mint approval, activate extensions, or alter Recovery/Bootstrap authority.

## 9. Non-goals (engineering)

These are **Unsupported** unless a later issue explicitly promotes them:

- Forking or vendoring DSH to edit internals
- Depending on DSH package-internal Agent Loop / `src/*`
- Custom Agent Loop
- Speculative multi-agent framework
- Committing secrets or real personal data
- Forcing a database choice ahead of a storage issue
- Self-authorizing capability changes
- Privileged runtime paths for assistant-generated plugins
