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
Is this sealed revision independently reviewed?
  Independent Review        [implemented]
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
2. `reliability.gate` — risk class + Risk Model. R0 may use a synthesized low-risk model; R1+ fail closed without mandatory reliability evidence. See [docs/engineering-reliability.md](./engineering-reliability.md).
3. `package.inspect` — dependencies are inspectable. Install/postinstall scripts are **not** executed and make the stage `blocked`.
4. `runtime.contract` — host stamp `generated-extension-api.json` must be `generated-extension-api/v1` when present. Unsupported versions fail closed.
5. `source.boundary` — no DSH package-internal `src/` imports
6. `typecheck` — offline TypeScript check when `.ts` sources exist
7. `tests` — Node-native candidate test files (`.js` / `.mjs` / `.cjs`) run only inside an OS/process sandbox that denies network at the system layer (macOS `sandbox-exec` / Linux `unshare --user --map-root-user --net`), plus `node --permission` for workspace-only filesystem and no child-process flag. The runner probes that a sandboxed process can start before treating the sandbox as available; EPERM / policy-disabled startup is `unresolved`, never host execution. The runner does not inherit host `process.env`. Candidate runtime permissions are not validation-time permissions. TypeScript-only test files stay `unresolved`. If that OS sandbox is unavailable, the stage stays `unresolved` rather than executing candidate code on the host. A failing or denied suite is `failed`. Network denial is not implemented by patching Node APIs. GitHub Actions Ubuntu runners enable unprivileged user namespaces before tests so this sandbox can start.
8. `bundle.inspect`
9. `digest` — SHA-256 of candidate source files

Independent Review is a separate host-managed stage after validation. It binds to that digest and cannot approve or activate. See [docs/independent-review.md](./independent-review.md).

Only repository-owned allowlisted task names may be requested. `shell.exec`, raw argv, and `npm.script` / `postinstall` requests are **blocked**, never `exec`'d.

A candidate becomes `validated` only when every required stage is `passed` or explicitly `not-applicable`. `failed`, `blocked`, and `unresolved` all prevent `report.passed`. Unresolved-only reports become `validation-incomplete`, not green.

## Public seams

```text
ctx.candidateWorkspace.create / writeFile / diff / seal / discard
ctx.candidateValidation.validate
ctx.independentReview.review / reviewCandidate / status
ctx.candidateWorkbench.plan / create / scaffold / inspectValidation / list / writeFile / validate / seal / review / repair
```

Model-facing Workbench tools (`plan_capability_change`, `create_candidate`, `scaffold_candidate`, `inspect_authoring_contract`, `inspect_validation_diagnostics`, `list_workbench`, `write_candidate_file`, `validate_candidate`, `seal_candidate`, `review_candidate`, `repair_candidate`) author only the selected managed candidate workspace. They do not install, approve, activate, or use the operator sandbox as a build area. Owner, version, and provenance come from a host-owned plan, never from caller-supplied review facts. See [docs/extension-governance.md](./extension-governance.md).

## Relationship to Registry

Validation may **read** Registry facts to compute diffs. It must not register the candidate as active, replace the owner, or treat a passing report as installed capability.
