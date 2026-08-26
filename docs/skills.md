# DSH-native Skill lifecycle

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

## Scope

v0.4.0 Skills are Profile-scoped (`assistant`) inside one bound Home. Workspace-specific and cross-Profile scopes are future work.
