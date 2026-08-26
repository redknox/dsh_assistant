# DSH-native Skill lifecycle

Status: **in progress**. The host lifecycle is Implemented in this repository; packaged human soak and issue #94 close-out are not complete.

A Skill is declarative instruction plus bounded resources. It cannot create a tool, grant permission, execute code, or replace policy. Missing executable capability still goes through Capability Resolution and the governed extension lifecycle.

Approval of a Skill means: allow this exact instruction bundle into the active catalog. It does not approve any future tool call that Skill may ask the Agent to use.

## Authority

| Actor | May |
| --- | --- |
| Assistant | plan, create, edit, validate, seal, submit Independent Review, request approval |
| Human / Recovery Root | exact approval, activation, disable, reactivate, uninstall, rollback |
| Operator CLI | local import plus the Recovery Root actions above |
| DSH `ctx.skills` | discover and load the active materialized catalog |

There is no model-facing or browser path picker. Marketplace, URL, npm, and GitHub install are out of scope.

## Runtime

The production `assistant` Profile mounts official DSH packages:

- `@deepseek-ai/dsh-skill` (`ctx.skills`)
- `@deepseek-ai/dsh-skill-filesystem` with `includeDefaultRoots: false` and `watchFollowSymlinks: false`
- `@deepseek-ai/dsh-tool-skill` (`skill` tool + session catalog)

The filesystem provider reads only `$TARS_NG_HOME/self-extension/skills/<profile>/active`. Ambient `~/.dsh`, `~/.agents`, and Workspace skill folders are not auto-trusted. Safe Mode mounts the Skill registry for inspection but withholds the user/third-party filesystem provider and `tool-skill`.

## Operator

```sh
tars-ng skill import-local <directory>
tars-ng skill approve <id> <fingerprint>
tars-ng skill activate <id>
```

Import publishes an inactive `third-party/import` candidate. Validate → seal → host-bound Independent Review → exact Recovery Root approval → separate activation remain distinct. Model tools cannot approve or activate. Callers cannot supply a reviewer or review report.

Hard Skill dependencies come only from host-owned `tars-ng.skill.json` `dependsOn: [{ name, version }]` (or `declareDependencies`). Prose mentions in `SKILL.md` are not a dependency graph.

Revision diffs report instruction change plus character counts, invocation, resources, and `dependsOn`. They do not include the instruction body.

Backtick tool mentions are compared to the bound runtime tool inventory. Missing names become a Capability Resolution handoff; they do not invent Skill authority. If the inventory is not bound, mentions are not treated as missing.

`tars-ng` status, `self-extension status`, and `tars-ng doctor` report the Profile Skill catalog, including `ok | empty | degraded` and failed names. Catalog invalidation is part of activate/disable/uninstall/rollback commit: a provider sync failure restores the previous directory and index, or persists `degraded` / recovery-required if restore or resync also fails. Home backup/restore copies `$TARS_NG_HOME/self-extension/skills/<profile>` and fail closed on a tampered active digest. Restore replaces the Self-Extension tree, so a backup without Skills would wipe them.

Activity records append-only Skill lifecycle events (draft/import/validate/review/approval/activate/update/rollback/disable/uninstall/recovery). It does not store instruction bodies, CoT, paths, or secrets. `health().failed` lists candidate validation/review/activation failures; catalog `degraded` is separate provider health.

The Web UI Skills Center (Extensions pane) shows catalog metadata, resources, validation/review state, and a bounded revision diff. React does not parse `SKILL.md`. Trusted actions use `POST /api/skill` through Recovery Root and require `confirm: true` plus exact id/name/version/digest/generation binding. Approve is not Activate. Reject is available on the exact approval card. System Skills hide uninstall/disable. Uninstall binds one revision; hard dependents return `dependents-required` until the same set is acknowledged. User-invocable active Skills appear as composer chips. Session history may still show earlier instruction text; disable does not rewrite candidate bytes.

Local import remains operator-only (`tars-ng skill import-local`) and is not on `ctx.skillLifecycle`. Home backup copies only sealed/approved/active/disabled Skill authority, not drafts or staging.

## Scope

v0.4.0 Skills are Profile-scoped (`assistant`) inside one bound Home. Workspace-specific and cross-Profile scopes are future work.
