# TARS-NG product vision

Status: **Designed** product direction. This document does not claim that domain-professional authoring or complete professional application composition is implemented.

## Thesis

TARS-NG is a governed AI-native product foundation on DeepSeek Harness (DSH). Its current personal assistant is the reference product and daily-use proving ground, not the final boundary of the platform.

The long-term goal is:

> A domain professional can describe a bounded business capability in their own language, inspect what the system proposes, verify it with meaningful examples, approve the exact effects and permissions, and operate or roll it back without understanding DSH or writing application infrastructure by hand.

Examples include a finance professional defining an invoice anomaly check, an HR professional defining an onboarding evidence check, or a legal professional defining a contract-expiry review. TARS-NG should help construct those capabilities; it must not let generated code authorize or certify itself.

## Why DSH

DSH owns the generic Harness concerns: Agent Loop, sessions, model and tool execution, events, providers, jobs, lifecycle, and plugin composition. Its dynamic Agent Loop is useful when the path cannot be fully written as a fixed workflow: the system may need to discover available information, choose tools, ask for missing input, react to tool results, and re-plan.

The complementary path is a host-registered DSH Workflow: once an orchestration pattern is stable, TARS-NG may run its fixed script through governed child agents while retaining the same Runtime Context, tool policy, approval, cancellation, and delegation limits. In the current runtime, these workflows are foreground and non-resumable. Arbitrary model-authored Workflow JavaScript is not an authority boundary and is not exposed.

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
TARS-NG Runtime Context
Home / Profile / Workspace / current Session
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

Through v0.4.0, TARS-NG is validating the lower half of the stack: a usable reference assistant with one host-owned Runtime Context, plus governed self-development. The central proof is that a Home can bind Profile / Workspace / current Session, then move a missing capability through resolution, candidate authoring, validation, independent review, exact approval, isolated activation, discovery, use, restart, and recovery without self-authorization.

This baseline is necessary but not sufficient for domain-professional vibe coding.

## Long-term roadmap

The roadmap after v0.4.0 is a product hypothesis, not a sequence of committed releases. Each stage should be justified by daily use and one bounded domain proof before TARS-NG expands into a broader platform.

### 1. Typed Capability Broker

The generated-extension contract first proved low-risk R0 capabilities without host I/O. TARS-NG now has the first narrow, exactly approved read-only operation, `host.knowledge.retrieve`, in addition to the context-free contract probe. This establishes the Typed Capability Broker seam; it does not complete the broader domain capability set.

For example, a candidate may declare that it needs `files.read`, `files.write`, or `knowledge.retrieve`, while still receiving no arbitrary `fs`, network, process, secret, or live Cordis access. Broker dependencies, permissions, effects, and failure semantics must be visible in the candidate diff and bound to the exact approval.

This is the bridge from pure transformations such as slug generation to useful local and domain capabilities. Further operations should be added only when required by a bounded domain proof, with typed arguments, result bounds, cancellation, exact permission review, and an active-call binding. It must not become a generic escape hatch around the generated-runtime sandbox.

### 2. Domain Construction Workbench

A domain professional should not need to ask for a TypeScript plugin. They should describe a need in their own language, after which TARS-NG helps separate:

- goal and non-goals;
- domain rules and authoritative data sources;
- required inputs and expected outputs;
- permissions and external effects;
- representative examples, edge cases, and failure cases;
- human review and mandatory approval points.

The first slice is now implemented: `define_capability_specification` creates an immutable, host-owned specification with goal, boundaries, inputs, business rules, exact permissions/effects, acceptance examples, and unresolved questions. A specification with unresolved questions cannot enter Capability Resolution. The resulting Resolution Plan references its exact digest, and a created Candidate contains a read-only `capability-specification.json` snapshot that is included in validation, review, and approval digest evidence.

Specifications are immutable. `revise_capability_specification` creates a successor revision without changing prior Resolution Plans or Candidate bindings, while `compare_capability_specifications` exposes a structured business-level diff before the new revision is selected for Resolution.

Legacy concise resolution calls remain temporarily supported for compatibility, but the governed construction path is Specification → Resolution Plan → Candidate. The remaining product work is a domain-facing editor and executable evaluation fixtures derived from acceptance examples.

### 3. Host-rendered domain UI

Professional work cannot remain entirely in a conversation stream. A governed capability should be able to declare a bounded UI schema for host-rendered forms, tables, comparisons, timelines, risk summaries, evidence requests, and approval cards.

Generated UI does not receive independent authority. It renders authoritative runtime projections and invokes named capabilities through the same policy and approval paths as conversation or operator actions. The browser must not invent lifecycle, permission, execution, or recovery state.

The product outcome is not merely that TARS-NG installs a plugin. It is that the system can grow a small, understandable professional application around that capability.

### 4. Capability composition and dynamic Agent orchestration

DSH is most valuable where the task path cannot be completely fixed in advance. TARS-NG should let the Agent dynamically choose and order governed capabilities, ask for missing evidence, react to partial results, and re-plan while remaining inside fixed authority boundaries.

A reimbursement review, for example, may require a different sequence for every claim: load the request, match travel records, inspect invoices, retrieve the applicable policy, request missing material, evaluate anomalies, and propose an approval route. The Agent may plan this sequence dynamically; authoritative posting, payment, identity, accounting, retention, and mandatory approvals remain in enterprise systems and host policy.

### 5. Durable professional workspaces

The personal assistant should evolve from one current conversation into durable workspaces such as Personal, Finance, Travel, HR, Contract, or Research. A workspace may own an explicit set of:

- conversations, objectives, and action history;
- domain knowledge and bounded data roots;
- enabled capabilities and permission policy;
- generated pages and domain vocabulary;
- evaluation fixtures, results, and operational evidence.

Workspace state must be durable and auditable. It must not create a second frontend-owned source of truth or blur authority between unrelated domains.

### 6. Governed triggers and continuous work

TARS-NG may later start bounded jobs from schedules, new files, enterprise events, or webhooks. A trigger starts an observable Agent job; it does not grant new authority. The resulting tool use, policy checks, approvals, cancellation, retries, and uncertain outcomes use the same runtime contracts as an interactive request.

This enables assistants that prepare work before the user opens the WUI, for example checking newly submitted expense claims and presenting exceptions without approving or posting them.

### 7. Professional capability packs

Finance, HR, Legal, Travel, and Operations packs may package domain models, capability contracts, policy templates, knowledge structures, UI schemas, tests, evaluation criteria, and adapter seams. They are not privileged marketplaces or bundles of unreviewed generated code.

An enterprise should be able to adapt a pack to its own rules while preserving provenance, versioning, permission diffs, review, exact approval, rollback, and recovery.

### 8. Domain-professional vibe coding

The long-term experience is not "everyone writes code with AI." It is:

> Domain professionals express rules, examples, data mappings, and risk boundaries; TARS-NG turns them into testable, governed software capabilities and applications.

The professional remains responsible for business meaning and acceptance examples. TARS-NG is responsible for clarification, specification, implementation, validation evidence, runtime composition, and operability. Human or enterprise authority remains responsible for approval and activation.

## Reference domain proof

The recommended first proof after the v0.4.0 soak is a low-risk finance slice: **expense risk review and approval recommendation**, without payment or automatic authoritative approval.

A finance professional should be able to describe rules such as different over-standard approval paths for different company entities. TARS-NG should:

1. clarify amount basis, organization scope, thresholds, exceptions, and authoritative sources;
2. generate a readable specification and decision examples;
3. resolve and construct the required bounded capabilities;
4. generate tests for normal, boundary, missing-evidence, and conflicting-rule cases;
5. present the capability, permission, data-access, and effect diff for review;
6. let a trusted human approve and activate the exact candidate;
7. render a useful expense-review workspace in the WUI;
8. dynamically gather the evidence needed for each claim and explain bounded findings;
9. leave posting, payment, and mandatory approval in authoritative enterprise systems; and
10. allow the operator to diagnose, disable, reactivate, or roll back the capability without developer intervention.

If a finance professional who does not know TypeScript or DSH can complete that loop on representative claims, TARS-NG has demonstrated more than plugin generation: it has demonstrated a new, governed method of producing professional AI-native software.

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
