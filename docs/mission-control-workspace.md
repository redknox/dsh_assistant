# Mission-Control Workspace

Status: **Verified** by `test/workspace.test.ts`.

Chat is how a person talks to TARS-NG. The workspace is how they understand and control it. The header renders host-derived Runtime Context (Profile, Workspace label, Session ID, persistence state). Conversations lists the host Session Catalog; React does not invent identity or paths.

Desktop-first layout (conceptual, not a pixel mandate):

```text
TARS-NG     Objective / Mission                         SYSTEM STATE
Context     Conversation / work objects                 Activity
            Approval / failure / recovery cards
Pending approval / objective / jobs / degradation
```

Visual language: industrial / instrument-grade. Restrained type, semantic status, no copyrighted TARS likeness, no fake scanlines, no “AI is thinking” theater.

The packed product serves a React Mission-Control Web UI from `tars-ng start` on loopback. The framework-independent HTML/text renderer remains a contract/test surface; the browser does not infer agent, approval, Safe Mode, or recovery state.

Approvals in the Web UI call `AssistantControlSurface.approve` / `deny` (and Recovery Root for Self-Extension using **candidate id + exact fingerprint**, not the approval record id). Exact-diff approval does **not** activate. After approval, Mission-Control projects a separate Activation Card; `POST /api/activate` requires the same session cookie, Origin check, and an explicit `confirm: true` bound to card id + candidate id + digest + fingerprint. Conversation yes cannot activate. Active generated/user plugins in the READY-state capability list expose a trusted **Uninstall plugin** trash action; `POST /api/uninstall` requires the same session, Origin, explicit `confirm: true`, and current owner/version/registry generation. Managed/system plugins have no uninstall action. Uninstall is not Recovery Root rollback and does not erase candidate or audit history. Mission-Control keeps a primary **Extensions** pane (nav `#extensions`, selected state, main content area) for generated/user revisions, including disabled/reactivatable rows. Each lifecycle exposes the existing trusted action from that record. Reactivate reuses `POST /api/activate` with the same session, Origin, `confirm: true`, and card bind; it does not create a new version. Registry `disabled` is not projected as superseded unless a newer authoritative revision, explicit superseded approval, or retired record says so. Recovery Root still projects a bound rollback DTO when a meaningful previous LKG differs from the current snapshot, and `POST /api/rollback` keeps its exact-card confirmation contract, but READY-state conversation does not render that rollback as a persistent card after every activation. Safe Mode and recovery-required states expose rollback through the dedicated Recovery panel. Activity shows operational facts only — never hidden reasoning. Recovery labels match trusted operations (`Diagnostics`, `Rollback`, `Exit Safe Mode`); Exit Safe Mode does not clear an unresolved integrity failure. After a verified rollback, historical failure diagnostics remain, and Exit Safe Mode can complete the recovery loop.

## Surfaces

| Region | Product concept | Not |
| --- | --- | --- |
| Context | Today, calendar/tasks, memory, knowledge | DSH internal service browser |
| Capabilities | Independently requested, installed, governed, and activated user additions. Tool, Workflow, Extension, Skill, and Connector describe how each addition is implemented; dependency-aware Unplug is reversible | Built-in product surfaces, provider health, a new runtime object, marketplace, or duplicate source of truth |
| Build Queue | One current delivery item per requested capability, projected across Define → Resolve → Build → Validate → Review → Approve → Activate → Live; decisions needing the user are first-class and prior revisions/live work move to History | A flat Candidate list, developer file editor, or a second lifecycle authority |
| System Info | Product-declared built-ins, action policy, connection availability, and runtime context | User-installed capability inventory or lifecycle control |
| Extensions | Primary pane for generated and **Third-party** revisions: approved, active, disabled, blocked, superseded, with inspect/approve/activate/uninstall/reactivate/history from the record | Marketplace, browser path picker, ops-panel-only list, or invented React plugin state |
| Work | Conversation plus plans, proposals, approvals, failures | Identical chat bubbles for every object |
| Activity | Operational facts from session tools, jobs, policy, recovery | Hidden chain-of-thought |
| Control strip | Pending approval, jobs, objective, degradation, mode | Noisy decorative HUD |
| Recovery | Safe Mode / recovery why, disabled generated owners, trusted actions | Ordinary “everything is fine” chrome |

Development Control Plane (Git/GitHub, sealing, Recovery Core, bootstrap) stays out of this workspace. `developmentControlPlaneSeparated` is always true on the view.

## System state

Projected from authoritative runtime/governance/policy/integration state, never a decorative frontend flag.

| State | Source of truth |
| --- | --- |
| SAFE_MODE | `extensionRecovery.inspect().safeMode` |
| RECOVERY | recovery required / last failure |
| BLOCKED | explicit refused authority action |
| NEEDS_APPROVAL | pending `actionPolicy` confirmation |
| DEGRADED | integration unavailable |
| WORKING | agent `running` |
| WAITING | job running/pending |
| READY | otherwise |

Capability rows describe availability, not queued decisions. `ACTIVE` means the current policy may execute the action without a human confirmation; `CONFIRM` means the capability is available but an exact-action confirmation will be required when execution is attempted. Only the approval counter and approval cards represent decisions currently waiting for a human.
Optional providers that were never configured render as `NOT LINKED` and do not make the system `DEGRADED`. `INOP`/`DEGRADED` is reserved for a configured provider whose authorization, executable, or upstream service has failed.

## Approvals

Every approval source projects the same decision interface: requested outcome, why the user is being asked, what approval will do, reviewable facts, and the exact one-time scope. Calendar and Obsidian cards describe the concrete write; DSH tool approval makes clear that the paused call resumes once without re-execution; Self-Extension approval states that the exact revision only becomes eligible for a separate activation decision. Fingerprints, digests, raw detail, and authority diagnostics remain available under Technical Details instead of competing with the decision.

Activation uses the same hierarchy but remains a distinct release-control interface: why activation is separate, which capability surfaces will become live, the exact isolated and reversible release scope, and any human-readable blocker. Approval evidence, contract version, digest, fingerprint, and raw eligibility diagnostics stay in Technical Details.

A control-plane decision is not a human conversation message. Approve, Reject, and Cancel resolve through the trusted host and appear in Actions history and Activity. They do not append a synthetic `Confirmation ...` user message or start an extra model turn. A successful decision may return a one-shot acknowledgement on the POST response for a dismissible toast; `/api/view` and SSE snapshots do not re-project that toast into Conversation.

Self-Extension is a capability/permission/effect diff bound to digest/fingerprint. Effect diffs include secret-access metadata (name/scope/type only); secret values are never rendered. It is not self-authorization. UI approve still goes through the existing policy/governance roots and leaves the candidate `APPROVED_NOT_ACTIVE` until a distinct trusted activation.

Workbench/Mission-Control DTOs split `reviewState`, `governanceApproval`, and `activationState`. Independent Review may still say it is not a human approval; public Workbench inspect no longer prints `NOT APPROVED` next to an already-approved candidate.

Capability requests begin in Conversation: user-facing “add/describe/define” entry points return to Today with a scoped draft instead of opening a developer specification editor. The Build Queue is a user-facing projection over immutable Capability Specifications, Resolution Plans, Candidates, and the existing Skill lifecycle. It does not merge those domain records or invent a new runtime object. The latest explicit specification revision is the current delivery item; compatibility-era specifications remain current only while they have an in-flight Candidate. Superseded revisions and live/retired capabilities are available under History. Non-system Skills use the same delivery vocabulary and decision priority without being converted into Extensions or Tools. Detailed business rules, permissions, effects, acceptance evidence, digests, and revision controls remain inspectable under **Specification & Evidence**, but do not dominate the default view.

Every non-terminal Build Queue item exposes one stage-appropriate continuation. Agent-owned work returns to the originating Session with a scoped prompt; the host stamps that Session identity when the Specification is created, and older records without an origin fall back explicitly to the current Session. Pending approval and activation return to Today where the existing trusted cards retain authority. The Queue never directly approves, activates, or invokes Workbench authoring tools. Host activation-compatibility denials are projected as **TARS-NG Update Required**, not as a usable Activate action. Resolution paths fulfilled by an existing capability move to History without inventing a Candidate.

**Stop Development** is a separate, confirmed host action; navigation back to Conversation never implies cancellation. Stopping persists a delivery disposition outside the immutable Specification digest, rejects further revision/planning/Candidate mutations, and moves the item to History while preserving all governance evidence. Pending approval or eligible activation must be resolved through its authoritative card first, and a live capability uses dependency-aware Unplug instead of Stop Development.

## Memory and context

Personal memory (durable, editable, forgettable) is separate from knowledge/files. Session chat is not durable memory. This issue reserves the IA and projects current records; it does not replace the memory product.

## Required scenarios

`test/workspace.test.ts` covers morning context, skeptical partner copy, calendar read, calendar-create approval, denied approval, provider degradation, Self-Extension diff, Safe Mode, personality tuning, and blocked/serious context without chain-of-thought.
