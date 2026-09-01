# TARS-NG assistant Profile

Shipped host Profile for this product. `dsh.profile.bundles` lists `@deepseek-ai/dsh-base` then `dsh-assistant`. `cordis.patch.yml` disables DSH base rows the product does not mount.

Production `tars-ng start` resolves this directory through official `loadProfile` / `composeEntries` and mounts the **active** composition. Safe Mode applies `profiles/assistant-safe` as a recovery overlay. See [docs/packaging.md](../../docs/packaging.md) and [docs/runtime-context.md](../../docs/runtime-context.md).

The Profile enables the DSH `workflow-worker-thread` composition slot, while `tool-workflow` remains disabled. The production adapter fulfills that WorkflowEngine seam with TARS-NG's `IsolatedWorkflowEngine`: each run executes in a separate OS- and Node-permission-confined process, while every child routes through the shared `tars-governed` Subagent Provider. TARS-NG exposes only catalog-registered scripts; the model cannot submit inline JavaScript.
