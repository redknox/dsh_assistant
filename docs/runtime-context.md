# Runtime Context

Status: **Implemented**. This is the v0.4.0 host-owned Profile / Workspace / Session contract. Multi-session topic chat, third-party install, and Skill lifecycle are **not** Implemented here.

```text
Install Harness
→ select Profile
→ boot base plugins
→ bind Workspace
→ persist current Session
→ use governed extensions
→ observe and recover
```

A running product instance has one authoritative identity:

```text
TARS-NG Home
+ DSH Profile
+ Workspace
+ Session Root
+ Current Session ID
+ Sandbox / permission policy
= Runtime Context
```

CLI, official DSH profile composition (or the equivalent product adapter), Agent/Session creation, Mission-Control, doctor/status, Safe Mode, and restart all consume this value. They must not re-resolve paths independently.

## Concepts

| Concept | Meaning | Not |
| --- | --- | --- |
| Home | Durable product/governance root and single-writer boundary | Process cwd |
| Profile | Installed host composition (`assistant` in this slice) | Human approval or Safe Mode |
| Workspace | Operator working context | Sandbox Root or write authority |
| Session Root | Durable DSH session storage | Candidate Workbench |
| Session ID | Current conversation identity (`main` by default) | A filesystem path |

Safe Mode keeps the same Home/Profile/Workspace/Session identity while excluding optional/generated execution.

## Precedence

```text
CLI (--profile, --workspace, --session-root, --session-id)
→ environment (TARS_NG_PROFILE, TARS_NG_WORKSPACE, TARS_NG_SESSION_ROOT, TARS_NG_SESSION_ID)
→ $TARS_NG_HOME/config/product.json `runtime`
→ defaults: assistant / $HOME/workspace / $HOME/sessions / main
```

A Home is stamped on first successful **start** after the Home lease is held. `doctor` and `status` inspect only. Rebinding Profile, Workspace, or Session Root fails closed. Changing Session ID on the same binding is allowed (one selected session at runtime).

Session files are stored under `$SESSION_ROOT/.tars-ng-sessions/<home+profile+workspace identity>/`. The Session Root itself carries an exclusive owner stamp, so a different Home cannot mount or read it. The partition writer lock is published atomically: identity is written and fsynced in a token-named staging directory, then renamed to `.writer.lock`. A visible official lock always has a complete identity. Automatic sweep only removes unpublished `.writer.lock.<token>.staging` leftovers. A published lock with missing, malformed, or unverifiable identity is `ambiguous` and is never deleted by claim. The lock uses a run token, classifies live/stale/ambiguous like the Home lease, and only a proven-stale lock can be reclaimed. `start` claims that Session Root before it permanently writes the Home binding.

## Persistence

Production boot mounts `@deepseek-ai/dsh-session-persistence-jsonl` under the resolved Session Root and creates the current Session with Workspace as DSH session `cwd` (context only; no `chdir`). Conversation history for the current Session ID is restored after stop/start. Prior Homes without this binding did not persist conversation; migration does not invent recovered chat history.

A Home lease remains the single-writer gate for Session Root. Concurrent writers to the same Home/session identity are rejected by that lease before a second persistence backend can attach. Shutdown disposes the live Agent/Session so DSH persistence can flush before the lease is released.

Production `start` parses the shipped `assistant` Profile (`profiles/assistant`) with official DSH patch composition (`loadOverlayPatches` / `composeEntries`). The Profile patch disables DSH base rows this product does not mount. The **active** composed ids are mapped to live `ctx.registry` names plus product-only seams; a lone `dsh-assistant` is not equivalent. Safe Mode applies `profiles/assistant-safe` as a recovery overlay. Official `dsh-app-boot` `loadProfile` / `renderConfigDump` / `boot` remains available as the packaging smoke path and is not a silent third-party installer.

## Surfaces

`tars-ng doctor` and `status` print Profile, Workspace label, Session ID, and configuration source. Mission-Control renders the same host-derived summary. React does not invent identity or paths.
