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

## Surfaces

| Region | Product concept | Not |
| --- | --- | --- |
| Context | Today, calendar/tasks, memory, knowledge, user-facing capabilities | DSH internal service browser |
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

Self-Extension is a capability/permission/effect diff bound to digest/fingerprint. Effect diffs include secret-access metadata (name/scope/type only); secret values are never rendered. It is not self-authorization. UI approve still goes through the existing policy/governance roots.

## Memory and context

Personal memory (durable, editable, forgettable) is separate from knowledge/files. Session chat is not durable memory. This issue reserves the IA and projects current records; it does not replace the memory product.

## Required scenarios

`test/workspace.test.ts` covers morning context, skeptical partner copy, calendar read, calendar-create approval, denied approval, provider degradation, Self-Extension diff, Safe Mode, personality tuning, and blocked/serious context without chain-of-thought.
