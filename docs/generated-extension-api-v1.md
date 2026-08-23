# generated-extension-api/v1

Status: **Implemented**. This is the host-owned authoring contract for assistant-generated R0 candidates. A candidate may consume it. It cannot redefine it.

Inspect it at runtime with `inspect_authoring_contract`. The version is host authority on the candidate manifest, Workbench binding, digest, approval fingerprint, and generated activation. Workspace `generated-extension-api.json` is a read-only mirror. Model writes cannot change it. Unsupported or missing versions fail validation and activation.

## Entry

- Module: `src/plugin.js`
- Export: `apply(ctx)`
- The host isolated runner loads this entry and never imports generated code into the TARS-NG process.

## Allowed `ctx`

- `ctx.tools.register` / `ctx.tools.get`
- `ctx.effect`
- `ctx.broker.request` (no broker operations are allowed in this R0 slice)

## Forbidden host APIs

`ctx.get`, `ctx.plugin`, live Cordis context, `process` / `child_process`, `fs`, `net` / `http` / `https`, `worker_threads`, host secrets, and the operator sandbox.

## Package and entry rules

`package.json` is `{ name, type: "module", main }`. Scripts, dependencies, and install lifecycle hooks are forbidden. Identity, version, provenance, lineage, and the contract version are host-stamped.

## Validation

Host-owned stages only. Node-native tests (`.js` / `.mjs` / `.cjs`) run in the restricted runner. Candidate argv/script/shell is rejected. `runtime.contract` fails closed on an unsupported stamp.

## Size and lifecycle

File/workspace/count bounds are the Workbench bounds. Lifecycle is scaffold → edit → validate → seal → Independent Review → approval request → human approve → human activate → isolated run.

See [docs/candidate-workspace.md](./candidate-workspace.md) and [docs/self-extension.md](./self-extension.md).
