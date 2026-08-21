# Candidate Workspace and Validation

Status: **Verified** by `test/candidate.test.ts`. This is the Self-Extension answer to **Can I produce and validate a candidate change safely?**

`validated` is evidence for one exact candidate digest. It is **not** permission to install, mount, switch, or approve that candidate.

```text
What do I have?
  Capability Registry       [implemented]
        ↓
What should change?
  Capability Resolution     [implemented]
        ↓
Can I build a candidate?
  Candidate Workspace       [this document]
        ↓
Is this exact candidate valid?
  Build/Test/Validation     [this document]
        ↓
May it become active?
  Governance / Activation   [implemented]
```

## Responsibilities

- Create a versioned candidate workspace from a Capability Resolution Review.
- Write, list, and read candidate source inside that workspace only.
- Produce a descriptive manifest and a machine-readable capability/permission diff.
- Run a bounded validation pipeline and bind the report to a content digest.
- Seal a validated (or failed) artifact so its source cannot change in place.

## Non-responsibilities

- Installing, upgrading, switching, or mounting the candidate.
- Marking Registry ownership `active` or manufacturing `approved-for-this-diff`.
- Executing arbitrary candidate-supplied shell, `postinstall`, or live vendor calls.
- Changing the active DSH profile/bundle or live tools.

Writing candidate source is not authorization to execute or mount that source.

## Lifecycle

Registry lifecycle (`candidate` / `active` / …) is **not** reused here.

```text
planned → developing → validation-pending → validated | validation-failed | validation-incomplete
```

`sealed` is an immutability flag, not a replacement for the validation outcome. A failed or incomplete artifact can be frozen for inspection; it does not become a Governance-ready `validated` candidate.

- Evolving `managed/integrations@0.1.0` creates `managed/integrations@0.2.0` in a separate workspace. The active owner is not edited in place.
- A source write after `validated` returns the record to `developing` and drops prior evidence.
- After `sealed: true`, writes are rejected. Further work needs a new candidate/revision.

## Workspace boundary

Candidate files live under a managed development area (`candidate-workspaces/<id>/` conceptually; tests use a temp root). Paths may not be absolute, contain `..`, or escape through symlinks. Symlink creation is rejected.

The pipeline never writes into the active product tree or installed plugin directories.

## Manifest and diff

`candidate.manifest.json` records owner, versions, provenance, originating resolution, capabilities, permissions, seams, tools/services/providers, secrets/config, operational effects, entry points, and requested validation tasks.

`diff()` compares that manifest to the current Registry base/active owner. Capability and permission additions are explicit lists. They are not collapsed into a source diff.

The manifest cannot authorize activation.

## Validation pipeline

Default stages, each with an explicit status (`passed` / `failed` / `blocked` / `not-applicable` / `unresolved`):

1. `manifest.validate`
2. `package.inspect` — dependencies are inspectable. Install/postinstall scripts are **not** executed and make the stage `blocked`.
3. `source.boundary` — no DSH package-internal `src/` imports
4. `typecheck` — offline TypeScript check when `.ts` sources exist
5. `tests` — Node-native candidate test files (`.js` / `.mjs` / `.cjs`) run in a restricted runner (`node --permission`, host-owned preload). The runner does not inherit host `process.env`, does not grant network or child-process authority, and allows filesystem access only inside the candidate workspace. Candidate runtime permissions are not validation-time permissions. TypeScript-only test files stay `unresolved`. If that isolation is unavailable, the stage stays `unresolved` rather than executing on the host. A failing or denied suite is `failed`.
6. `bundle.inspect`
7. `digest` — SHA-256 of candidate source files

Only repository-owned allowlisted task names may be requested. `shell.exec`, raw argv, and `npm.script` / `postinstall` requests are **blocked**, never `exec`'d.

A candidate becomes `validated` only when every required stage is `passed` or explicitly `not-applicable`. `failed`, `blocked`, and `unresolved` all prevent `report.passed`. Unresolved-only reports become `validation-incomplete`, not green.

## Public seams

```text
ctx.candidateWorkspace.create / writeFile / diff / seal / discard
ctx.candidateValidation.validate
```

There is no model-facing install, approve, or mount tool. Orchestrators may call these services after a trusted Resolution Review.

## Relationship to Registry

Validation may **read** Registry facts to compute diffs. It must not register the candidate as active, replace the owner, or treat a passing report as installed capability.
