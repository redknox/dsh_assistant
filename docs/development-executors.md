# External Development Executors

Status: **AVAILABLE / EXPERIMENTAL**. TARS-NG Native remains the default authoring path.

Codex and Claude Code are replaceable implementation workers inside TARS-NG's existing Capability governance. They do not become governance authorities. A user-accepted Resolution Plan and a mutable Candidate are required before delegation, and the one-shot delegation itself still enters the shared approval surface.

## Development Run

Every external invocation creates a durable `DevelopmentRun` before the child process starts. The record includes:

- run, Candidate and executor identity;
- `preparing`, `running`, `cancelling`, `completed`, `failed`, `cancelled`, `timed-out`, or `interrupted` state;
- start/update/finish timestamps, child PID, output byte progress and bounded terminal output;
- changed files and whether the Candidate snapshot was restored.

Metadata and pre-run Candidate snapshots live below the TARS-NG Home development-runs directory with owner-only permissions and atomic metadata replacement. A successful run discards its rollback snapshot. Failure, cancellation and timeout restore it before returning control to host validation.

Mission Control shows recent runs and provides `CANCEL RUN` for active runs. The model has read-only `inspect_development_runs` and an explicit `cancel_development_run` operation. Cancellation terminates the child process group rather than only its immediate parent.

## Restart recovery

At boot, TARS-NG scans non-terminal runs. It verifies an old PID against both expected executable and approximate process start time before sending a termination signal. If termination is verified, the pre-run Candidate snapshot is restored and the run becomes `interrupted` with `rolledBack: true`.

If the PID cannot be verified or the snapshot cannot be restored, the run becomes `interrupted` with `rolledBack: false`. That Candidate is frozen: TARS-NG refuses another external run until an operator restores the snapshot. A corrupt snapshot is fully decoded and bounded before the current Candidate directory is replaced.

## Authentication truthfulness

Executable discovery, provider-account login and execution-route availability are separate facts. Codex uses `codex login status`. Claude Code may instead use a custom model route declared in its settings with a model, `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`; that route does not require an Anthropic account login. TARS-NG recognizes the configuration without exposing its values and passes the explicit settings file because restricted/safe execution otherwise ignores user settings.

A configured custom route is shown as `CUSTOM ROUTE · VERIFY ON RUN`, not as authenticated or fully verified. A completed real Development Run promotes the evidence to `EXECUTION VERIFIED · EXPERIMENTAL`. A failed real run containing an authentication failure overrides optimistic configuration and is retained in the durable run store, so restart does not silently return the executor to green.

Authentication is still provider-owned. TARS-NG does not store provider credentials and cannot renew or repair a Codex or Claude account session.

## Security boundary

External executors receive only the Candidate Workspace as their working root and a bounded prompt. They cannot edit the Candidate manifest, specification, generated contract or `.dsh` authority artifacts. TARS-NG snapshots and compares the workspace, refreshes the Candidate only after a clean exit, and retains validation, Independent Review, approval and activation as separate host-owned steps.

This boundary does **not** authorize Codex or Claude Code to modify the TARS-NG host repository. Host-product development remains an operator/developer workflow outside Self-Extension governance.

## Verification

Deterministic coverage:

```sh
npx tsx --test test/development-executor.test.ts test/web-ui.test.ts
```

Opt-in live acceptance (uses the logged-in provider accounts and temporary Candidate directories):

```sh
npm run verify:development-executors:live
```

Evidence recorded on 2026-09-08:

- Codex `codex-cli 0.150.1`: **PASS** after one bounded source-file authoring run; the manifest remained unchanged.
- Claude Code `2.1.260`: its custom model route is now correctly detected independently from Anthropic login. A new live Candidate run still requires explicit authorization to send the existing route token to the configured `ANTHROPIC_BASE_URL`; until that acceptance is run, its status remains configured rather than execution-verified.

Do not promote either adapter beyond `EXPERIMENTAL` merely because one acceptance run succeeds.
