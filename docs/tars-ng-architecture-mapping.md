# TARS-NG architecture mapping (M5)

Status: **Implemented** as a mapping contract. Personality and workspace projection are **Verified** by `test/personality.test.ts` and `test/workspace.test.ts`.

M5 maps product surfaces onto existing public DSH/Assistant seams. It does not add a second Agent Loop, a second session truth, or frontend-only authority.

| Product need | Existing public seam | Notes |
| --- | --- | --- |
| Personality Core / Policy / Expression | `ctx.systemPrompt.section` / `.context` | Compiled from `PersonalityService`; not a private loop patch |
| User-adjustable humor/directness/initiative/verbosity | `ctx.tarsPersonality` | Cannot mint approval or change Recovery |
| Conversation history | `SessionEvent` via `ctx.agents` | Reasoning blocks are stripped in the workspace projector |
| Activity | `tool/call`, `tool/result`, jobs, policy tickets, recovery inspect | Operational labels only |
| Calendar read / create | integrations hub + `actionPolicy` | Create stays L4 confirmation |
| Self-Extension approval | `extensionGovernance.inspectSummary` | Exact digest/diff; trusted mint stays on Recovery Root |
| Registry / capability UX | `ctx.capabilityRegistry` | User semantics first; owner/version/provenance secondary |
| Memory / knowledge | `personalMemory`, `personalKnowledge` | Absent in Safe Mode; IA still reserved |
| Safe Mode / recovery | `bootSafeModeRuntime`, `extensionRecovery.inspect()` | Personality remains; generated plugins do not |
| Objective | product-layer `AssistantControlSurface.setObjective` | Not a parallel orchestration runtime |
| Existing UI shell | `AssistantControlSurface.snapshot()` | Preserved; `workspace()` is the Mission-Control projection |

## Explicitly not added

- Private Agent Loop / DSH `src/*` imports
- Chain-of-thought viewer
- Frontend-only approval that bypasses `actionPolicy` or Recovery Root
- Personality-granted capability or permission
- GitHub/developer console inside the user workspace
- Package version/tag for this design issue

## Missing seams (do not invent yet)

- Durable cross-restart personal Schedule (already **Unsupported**)
- Live vendor OAuth accounts (already **Unsupported**)
- Pixel/mobile application (out of M5)

If a later issue needs those, add them as new public product seams. Do not encode them only in HTML.
