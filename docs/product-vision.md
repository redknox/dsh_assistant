# TARS-NG product vision

Status: **Designed** product direction. This document does not claim that domain-professional authoring or complete professional application composition is implemented.

## Thesis

TARS-NG is a governed AI-native product foundation on DeepSeek Harness (DSH). Its current personal assistant is the reference product and daily-use proving ground, not the final boundary of the platform.

The long-term goal is:

> A domain professional can describe a bounded business capability in their own language, inspect what the system proposes, verify it with meaningful examples, approve the exact effects and permissions, and operate or roll it back without understanding DSH or writing application infrastructure by hand.

Examples include a finance professional defining an invoice anomaly check, an HR professional defining an onboarding evidence check, or a legal professional defining a contract-expiry review. TARS-NG should help construct those capabilities; it must not let generated code authorize or certify itself.

## Why DSH

DSH owns the generic Harness concerns: Agent Loop, sessions, model and tool execution, events, providers, jobs, lifecycle, and plugin composition. Its dynamic Agent Loop is useful when the path cannot be fully written as a fixed workflow: the system may need to discover available information, choose tools, ask for missing input, react to tool results, and re-plan.

TARS-NG builds above those public seams. It adds the product and governance concerns needed to turn dynamic generation into an operable system:

- capability discovery and reuse before generation
- bounded candidate workspaces and isolated execution
- deterministic validation and meaningful acceptance evidence
- independent review distinct from authoring
- digest/diff-bound human approval
- activation distinct from approval
- observable activity without exposing chain of thought
- rollback, last-known-good state, Safe Mode, and trusted recovery

## Who it is for

The intended creator is a **domain professional**, not necessarily a software developer. Domain professionals should work with their own vocabulary, examples, rules, data mappings, and risk boundaries. They should not need to manipulate Cordis providers, DSH events, package manifests, or raw TypeScript plugins.

The intended operator may be the same person for a personal or small system. In an enterprise deployment, author, reviewer, approver, and runtime operator may be different people.

## Product stack

```text
Domain professional
        ↓
Domain construction experience
intent / clarification / rules / examples / data mapping / UI preview
        ↓
TARS-NG capability construction
resolve / plan / author / validate / review
        ↓
TARS-NG governance control
permission diff / exact approval / activate / observe / rollback / recovery
        ↓
DSH Agent Runtime
agent loop / sessions / tools / events / providers / lifecycle
        ↓
Domain systems and data
ERP / HRIS / OA / documents / APIs / databases
```

## Freedom and authority

AI-native does not mean that every path is predetermined. The Agent may dynamically:

- interpret the user's goal
- choose and order available read or analysis tools
- request missing evidence
- react to partial results or tool failures
- propose a plan, draft, or domain action
- decide that human review is required

The Agent may not dynamically:

- expand its own permissions
- approve or activate its own generated capability
- bypass domain policy or mandatory approval
- redefine authoritative payment, identity, accounting, or retention rules
- hide effects from the approval diff or activity record
- replace trusted recovery authority

The design principle is:

> Dynamic planning inside fixed authority boundaries.

## Current baseline

Through v0.4.0, TARS-NG is validating the lower half of the stack: a usable reference assistant plus governed self-development. The central proof is that a missing capability can move through resolution, candidate authoring, validation, independent review, exact approval, isolated activation, discovery, use, restart, and recovery without self-authorization.

This baseline is necessary but not sufficient for domain-professional vibe coding.

## What remains for domain-professional construction

Later work should be driven by one bounded real domain slice rather than speculative generic platform features. A complete slice needs:

1. Natural-language intent capture and clarification.
2. An explicit specification separating goals, rules, permissions, and acceptance examples.
3. Domain primitives and adapters that are safer than arbitrary code generation.
4. Reuse/evolve/new-capability resolution visible to the user.
5. Generated tests, fixtures, dry runs, and failure examples understandable to the domain professional.
6. UI or interaction generation from authoritative runtime projections, not frontend-invented state.
7. Publication, versioning, monitoring, and rollback appropriate to the domain risk.

A suggested first proof is one low-risk finance capability, such as invoice anomaly detection or reimbursement draft validation. It should exercise the full conversation-to-capability path while keeping posting, payment, and mandatory approval in authoritative enterprise systems.

## Product discipline

- Daily use comes before broad capability expansion after v0.4.0.
- Real failures are classified as defects, usability gaps, or genuinely missing capabilities.
- TARS-NG should prefer reuse, configuration, or evolution before creating another plugin.
- Domain logic belongs in domain services and policies, not in the Agent prompt or UI.
- Generated code uses the same public seams and stricter governance as human-written extensions; it receives no privileged runtime path.
- Evidence language remains exact: Designed, Implemented, Verified, Experimental, Unknown, or Unsupported.

## Success criteria for the vision

The vision is not proven merely because TARS-NG can generate a plugin. It is proven only when a domain professional who does not know TypeScript or DSH can:

1. describe a real bounded need in domain language;
2. understand the proposed behavior, data access, permissions, and effects;
3. validate it with representative business examples;
4. approve and activate the exact reviewed candidate;
5. use it successfully through the product UI;
6. diagnose, disable, or roll it back without developer intervention; and
7. compose it with other governed capabilities without weakening the authority boundary.
