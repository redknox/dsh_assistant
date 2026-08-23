# TARS-NG Mission-Control visual reference v1

This directory is the deterministic visual and semantic reference for the v0.3.x WUI redesign. It translates the approved aerospace-instrument concept into plain HTML and CSS so a non-multimodal implementation model can inspect exact hierarchy, tokens, spacing, states, and component boundaries.

## Preview

Open `index.html` directly in a browser. The prototype has no build step, no JavaScript, no network dependency, and no runtime authority. Its content is representative mock data only.

`reference.png` is a visual target, not a pixel-perfect or copyrighted movie reproduction. The implementation should preserve the restrained functional language: warm painted panels, dark instrument zones, amber attention, green health, red recovery/failure, clear mechanical grouping, and a comfortable central reading surface.

## Source-of-truth boundary

The prototype defines presentation only. Production continues to use:

```text
Authoritative runtime events
→ Mission-Control Projection
→ MissionControlView DTO
→ existing local HTTP / SSE envelope
→ React rendering
```

The browser must not infer agent progress, manufacture approvals, own Safe Mode, or create a second state model.

## Mapping to the current WUI

| Prototype region | Production source / behavior |
| --- | --- |
| Header identity | `view.identity` |
| READY lamp and label | `view.systemState` |
| Conversation | `view.conversation` |
| Approval card | `view.approvals` and the existing approve/deny endpoints |
| Activity timeline | `view.activity`; operational facts only, never hidden reasoning |
| Capability status | `view.capabilities` |
| Safe Mode / Recovery | `view.recovery`; existing confirmation and Recovery Root rules |
| Bottom strip | `view.controlStrip` plus the existing loopback envelope where applicable |
| Composer | existing `sendMessage` flow and connection/sending state |

The left navigation is information architecture, not permission to invent unimplemented routes. In the first implementation, unavailable destinations may remain non-interactive or reveal existing data in-place.

## Design tokens

The authoritative token names live at the top of `styles.css`:

- surface: `--panel-ivory*`, `--instrument-black`, `--instrument-raised`
- semantic signal: `--signal-amber`, `--status-green`, `--fault-red`, `--info-cyan`
- typography: `--font-instrument` for state and controls, `--font-reading` for conversation
- structure: heavy dark outer/module borders, softer internal separators

Semantic color rules:

- amber: approval required, governed, or attention
- green: healthy / active / ready
- red: destructive, unavailable, failure, Safe Mode, or Recovery
- cyan: optional informational emphasis only
- never use color as the only status cue; retain text labels and shapes

## State requirements

- `READY`: green lamp; calm neutral shell.
- `WORKING` / `WAITING`: amber label without alarm styling.
- `NEEDS_APPROVAL`: approval card and activity step receive amber emphasis.
- `DEGRADED`: explicit amber/red text with operator guidance.
- `SAFE_MODE` / `RECOVERY`: dedicated first-class panel; generated capabilities disabled; diagnostics, rollback, and Exit Safe Mode retain existing authority and confirmation behavior.
- disconnected: visible transport status and disabled mutations.

## Implementation constraints

- Refactor the existing React WUI; do not ship this static file as the application.
- Preserve the existing session cookie, origin policy, secret redaction, approval fingerprint/candidate binding, Recovery Root, SSE invalidation, and reconnect behavior.
- Do not add a UI framework, icon dependency, remote font, theme system, animation system, or new product capability for this redesign.
- Essential text must remain at least 14px on desktop; operational metadata may be 11–12px when non-essential.
- Maintain keyboard focus visibility, semantic headings/landmarks, labeled controls, status text in addition to color, reduced-motion behavior, and usable layout at 820px and below.
- The center conversation surface must remain the dominant and most comfortable region for daily use.

## Visual non-goals

- no copied Interstellar screens, logos, characters, robots, or branded assets
- no cyberpunk HUD, neon glow, starfield, fake telemetry, scanlines, or decorative graphs
- no dark conversation reading surface
- no animation that implies hidden reasoning or fabricated progress
- no new dashboard metrics

## Suggested production component split

```text
MissionControlScreen
├── SystemHeader
├── WorkspaceNavigation
├── ConversationWorkspace
│   ├── ConversationMessage
│   ├── ApprovalCard
│   └── MessageComposer
├── OperationsPanel
│   ├── ActivityTimeline
│   └── CapabilityStatus
├── RecoveryPanel
└── ControlStrip
```

Component extraction is encouraged only where it improves clarity and testability. It must not change the DTO or move authoritative state into components.
