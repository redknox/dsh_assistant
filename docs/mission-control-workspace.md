# Mission-Control Workspace

Status: **Verified** by `test/workspace.test.ts`.

Chat is how a person talks to TARS-NG. The workspace is how they understand and control it.

Desktop-first layout (conceptual, not a pixel mandate):

```text
TARS-NG     Objective / Mission                         SYSTEM STATE
Context     Conversation / work objects                 Activity
            Approval / failure / recovery cards
Pending approval / objective / jobs / degradation
```

Visual language: industrial / instrument-grade. Restrained type, semantic status, no copyrighted TARS likeness, no fake scanlines, no “AI is thinking” theater.

The packed product serves a React Mission-Control Web UI from `tars-ng start` on loopback. The framework-independent HTML/text renderer remains a contract/test surface; the browser does not infer agent, approval, Safe Mode, or recovery state.

Approvals in the Web UI call `AssistantControlSurface.approve` / `deny` (and Recovery Root for Self-Extension using **candidate id + exact fingerprint**, not the approval record id). Exact-diff approval does **not** activate. After approval, Mission-Control projects a separate Activation Card; `POST /api/activate` requires the same session cookie, Origin check, and an explicit `confirm: true` bound to card id + candidate id + digest + fingerprint. Conversation yes cannot activate. Active generated/user plugins in the READY-state capability list expose a trusted **Uninstall plugin** trash action; `POST /api/uninstall` requires the same session, Origin, explicit `confirm: true`, and current owner/version/registry generation. Managed/system plugins have no uninstall action. Uninstall is not Recovery Root rollback and does not erase candidate or audit history. Mission-Control keeps a persistent **Extensions** view for generated/user revisions, including disabled/reactivatable rows. Reactivate reuses `POST /api/activate` with the same session, Origin, `confirm: true`, and card bind; it does not create a new version. Registry `disabled` is not projected as superseded unless a newer authoritative revision, explicit superseded approval, or retired record says so. When Recovery Root has a meaningful previous LKG that differs from the current snapshot, READY-state Mission-Control projects a **Rollback system state** card. `POST /api/rollback` requires the same session, Origin, explicit `confirm: true`, and the exact card id / fingerprint / current and target generations. The browser does not choose the target snapshot. Safe Mode and recovery-required states keep using the existing Recovery panel instead of that card. Activity shows operational facts only — never hidden reasoning. Recovery labels match trusted operations (`Diagnostics`, `Rollback`, `Exit Safe Mode`); Exit Safe Mode does not clear an unresolved integrity failure. After a verified rollback, historical failure diagnostics remain, and Exit Safe Mode can complete the recovery loop.

## Surfaces

| Region | Product concept | Not |
| --- | --- | --- |
| Context | Today, calendar/tasks, memory, knowledge, user-facing capabilities | DSH internal service browser |
| Extensions | Persistent generated/user revisions: approved, active, disabled, blocked, superseded | Marketplace or invented React plugin state |
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

## Approvals

Calendar create is an ordinary external side-effect card: target, when, attendees, external side effect, no authority change.

Self-Extension is a capability/permission/effect diff bound to digest/fingerprint. Effect diffs include secret-access metadata (name/scope/type only); secret values are never rendered. It is not self-authorization. UI approve still goes through the existing policy/governance roots and leaves the candidate `APPROVED_NOT_ACTIVE` until a distinct trusted activation.

Workbench/Mission-Control DTOs split `reviewState`, `governanceApproval`, and `activationState`. Independent Review may still say it is not a human approval; public Workbench inspect no longer prints `NOT APPROVED` next to an already-approved candidate.

## Memory and context

Personal memory (durable, editable, forgettable) is separate from knowledge/files. Session chat is not durable memory. This issue reserves the IA and projects current records; it does not replace the memory product.

## Required scenarios

`test/workspace.test.ts` covers morning context, skeptical partner copy, calendar read, calendar-create approval, denied approval, provider degradation, Self-Extension diff, Safe Mode, personality tuning, and blocked/serious context without chain-of-thought.
