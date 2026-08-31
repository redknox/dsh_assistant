# generated-extension-api/v1

Status: **Implemented**. This is the host-owned authoring contract for assistant-generated R0 candidates. A candidate may consume it. It cannot redefine it.

Inspect it at runtime with `inspect_authoring_contract`. The version is host authority on the candidate manifest, Workbench binding, digest, approval fingerprint, and generated activation. Workspace `generated-extension-api.json` is a read-only mirror. Model writes cannot change it. Unsupported or missing versions fail validation and activation.

The governed construction path also writes `capability-specification.json`. It is a host-owned, read-only snapshot of the exact Capability Specification used by the Resolution Plan. Its digest, requested Broker permissions, and operational effects must match host state and the Candidate manifest; mismatch fails before candidate validation.

## Entry

- Module: `src/plugin.js`
- Export: `apply(ctx)`
- The host isolated runner loads this entry and never imports generated code into the TARS-NG process.

## Allowed `ctx`

- `ctx.tools.register` / `ctx.tools.get`
- `ctx.effect(setup)` runs a zero-argument setup callback and registers the cleanup function it returns. It is not an I/O, process, filesystem, or network API.
- `ctx.broker.request(capability, args)` may call only operations listed by the runtime `brokerOps` contract. Every operation used by candidate source must also be declared in `candidate.manifest.json` as a `permissions` entry so it is included in the exact-diff review and human approval.
- `host.text.echo` is the context-free R0 contract probe.
- `host.knowledge.retrieve` is a read-only, call-bound retrieval operation: `{ query, limit? }`, with a 2 KiB query, 1–5 hits, bounded citations, cancellation, and JSON result limits. It is available only during an active generated proxy-tool call and only when Personal Knowledge is mounted.
- SSH, process, arbitrary filesystem, arbitrary network, secrets, and write operations are not available.

Broker requests are bound to the active proxy-tool invocation. Candidate startup, cleanup, health checks, and detached asynchronous work cannot use a permission merely because it appears in the approved manifest.

## Forbidden host APIs

`ctx.get`, `ctx.plugin`, live Cordis context, `process` / `child_process`, `fs`, `net` / `http` / `https`, `worker_threads`, host secrets, and the operator sandbox.

## Package and entry rules

`package.json` is `{ name, type: "module", main }`. Scripts, dependencies, and install lifecycle hooks are forbidden. Identity, version, provenance, lineage, and the contract version are host-stamped.

## Validation

Host-owned stages only. Node-native tests (`.js` / `.mjs` / `.cjs`) run in the restricted runner. Candidate argv/script/shell is rejected. `runtime.contract` fails closed on an unsupported stamp.

## Size and lifecycle

File/workspace/count bounds are the Workbench bounds. Lifecycle is scaffold → edit → validate → seal → Independent Review → approval request → human approve → human activate → isolated run.

See [docs/candidate-workspace.md](./candidate-workspace.md) and [docs/self-extension.md](./self-extension.md).
