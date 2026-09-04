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

## Strategic entry point: trusted enterprise knowledge

TARS-NG should first become a trusted enterprise knowledge entry point, then progressively earn bounded authority to act. A read-only assistant is the preferred initial enterprise form because it can reduce knowledge-access cost, improve answer consistency, and establish the data, permission, audit, and governance foundation needed by later Agents without immediately changing authoritative systems.

This is a sequencing decision, not a claim that read-only means safe. The central risk question is not only whether the assistant can write, but:

> What can it read, who may receive the answer, and how will that answer be treated?

Before a read-only enterprise assistant is considered trustworthy, TARS-NG must address three primary controls:

1. **Data confidentiality** — retrieval, model routing, retention, citations, and logs must not expose material beyond the approved boundary.
2. **Permission fidelity** — the assistant must preserve source-system identity and authorization boundaries; a read-only UI does not make an over-broad reader acceptable.
3. **Prompt-injection resistance** — retrieved content remains untrusted data and cannot redefine authority, request secrets, or turn reading into an execution path.

Accuracy, compliance, supply-chain control, internal misuse, and operational accountability remain necessary controls as the product matures. The strategic promise is therefore not “safe because read-only,” but:

> Deliver useful knowledge work with low and reversible system-change risk, while building the governance foundation required for future action.

This produces the intended capability progression:

```text
Trusted knowledge access
        ↓
Governed analysis and recommendation
        ↓
Human-approved bounded mutations
        ↓
Durable workflows and professional applications
```

Each transition must be earned through typed capabilities, observable evidence, exact approval, and recovery. Action authority is not an automatic upgrade from successful knowledge retrieval.

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

### Harness first

The Harness, not a product Workflow, decides the next useful step toward the user's goal. TARS-NG is the governance exoskeleton around that decision: it provides scoped context and governed Capabilities, records evidence, pauses at authority boundaries, and controls whether a reviewed result can become Live.

This makes Capability reuse a product requirement. Tools, Skills, Connectors, Extensions, and Workflows are implementation forms behind user-visible Capabilities; they are not separate competing control planes. A stable reimbursement procedure may become a Workflow, but its travel lookup, policy retrieval, invoice checks, and report generation remain independently usable by the Harness for other requests.

Goal, Plan, Todo, and Capability Delivery Session state make the Harness's work observable and resumable. They do not prescribe a fixed global sequence. Likewise, starting a dedicated Session for a requested Capability concentrates its conversation and decisions without moving lifecycle or approval authority into chat history.

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

Legacy concise resolution calls remain temporarily supported for compatibility, but the governed construction path is Specification → Resolution Plan → Candidate.

The next slice is also implemented: an Acceptance Example may carry an Evaluation Fixture with JSON input and exact expected output. The host compiles those fixtures into immutable Candidate assets, executes the declared tool inside the existing OS-isolated validation runner, persists case-level expected/actual evidence in the Candidate Validation Report, and projects the result in the Capability Specifications workspace. Candidate code cannot rewrite the fixture suite or runner through Workbench tools. This first contract deliberately covers one pure, single-tool capability; Broker-backed and multi-tool evaluations remain future domain-driven extensions rather than a generic execution escape hatch.

### 3. Host-rendered domain UI

Professional work cannot remain entirely in a conversation stream. A governed capability should be able to declare a bounded UI schema for host-rendered forms, tables, comparisons, timelines, risk summaries, evidence requests, and approval cards.

Generated UI does not receive independent authority. It renders authoritative runtime projections and invokes named capabilities through the same policy and approval paths as conversation or operator actions. The browser must not invent lifecycle, permission, execution, or recovery state.

The product outcome is not merely that TARS-NG installs a plugin. It is that the system can grow a small, understandable professional application around that capability.

The first bounded slice is implemented for `finance.expense-risk.review`. The host renders a structured claim form and a fixed evidence contract covering the decision, triggered rules, missing evidence, and recommended next action. The page resolves exactly one active Registry owner and invokes its mounted governed tool; it refuses registry conflicts, missing mounts, execution failures, and malformed results. It has no expense approval, posting, or payment authority. Real finance-system adapters and durable claim history remain future work.

### 4. Capability composition and dynamic Agent orchestration

DSH is most valuable where the task path cannot be completely fixed in advance. TARS-NG should let the Agent dynamically choose and order governed capabilities, ask for missing evidence, react to partial results, and re-plan while remaining inside fixed authority boundaries.

A reimbursement review, for example, may require a different sequence for every claim: load the request, match travel records, inspect invoices, retrieve the applicable policy, request missing material, evaluate anomalies, and propose an approval route. The Agent may plan this sequence dynamically; authoritative posting, payment, identity, accounting, retention, and mandatory approvals remain in enterprise systems and host policy.

When repeated evidence shows that part of this sequence is stable, the Harness may select a host-registered Workflow that packages it as one governed Capability. Workflow adoption is an optimization for repeatability and operability, not a transfer of planning authority away from the Harness.

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
5. Broader generation of fixtures, dry runs, and failure examples for Broker-backed and multi-tool capabilities; the pure single-tool Evaluation Fixture path is implemented.
6. UI or interaction generation from authoritative runtime projections, not frontend-invented state.
7. Publication, versioning, monitoring, and rollback appropriate to the domain risk.

A suggested first proof is one low-risk finance capability, such as invoice anomaly detection or reimbursement draft validation. It should exercise the full conversation-to-capability path while keeping posting, payment, and mandatory approval in authoritative enterprise systems.

## Product discipline

- Daily use comes before broad capability expansion after v0.4.0.
- Establish TARS-NG as a trusted enterprise knowledge entry point before broadening its mutation authority.
- Treat “read-only” as reduced system-change risk, never as a substitute for confidentiality, permission fidelity, or prompt-injection defenses.
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
