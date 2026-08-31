# TARS-NG assistant Profile

Shipped host Profile for this product. `dsh.profile.bundles` lists `@deepseek-ai/dsh-base` then `dsh-assistant`. `cordis.patch.yml` disables DSH base rows the product does not mount.

Production `tars-ng start` resolves this directory through official `loadProfile` / `composeEntries` and mounts the **active** composition. Safe Mode applies `profiles/assistant-safe` as a recovery overlay. See [docs/packaging.md](../../docs/packaging.md) and [docs/runtime-context.md](../../docs/runtime-context.md).

The Profile enables `workflow-worker-thread`, while `tool-workflow` remains disabled. TARS-NG exposes only host-registered fixed scripts through its product tools and routes every Workflow child through the shared `tars-governed` Subagent Provider. The worker thread is containment for execution and cancellation, not a security sandbox for arbitrary model-authored JavaScript.
