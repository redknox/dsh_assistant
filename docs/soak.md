# Feature freeze and real-world soak

Status: **Implemented** as the v0.3.0 Product Soak policy. Duration is operational, not a release metric.

```text
v0.3.0 = Governance + Mission-Control product baseline
v0.4.0 target = Self-Developing Product Baseline
```

`v0.3.0` remains an immutable historical seal. v0.4.0 work may proceed on `main` after this re-opening. Self-development is allowed; self-authorization is not. Do not expose model-facing candidate write/build tools until generated activation is isolated.

For any remaining v0.3.x soak-line fixes:

- do not add unrelated user-facing capabilities;
- do not add providers merely because they are interesting;
- do not expand Self-Extension authority beyond the isolated generated runtime;
- accept bug fixes, reliability/security/packaging/diagnostics/usability fixes, and documentation.

The question to answer is: **can I depend on this product every day?**

Allowed v0.3.x work: security, authority/governance, data-loss, reliability/recovery, packaging/install/upgrade, secret/configuration, performance/resource leaks found during soak, usability that makes the existing product operable, documentation corrections.

Normally deferred: new integrations, new tool categories, new providers for optionality, new Self-Extension authority, additional product features unrelated to a real soak defect.

## Window

Recommended: **2–4 weeks of daily use** after `v0.3.0` is tagged. Adjust for usage density, not calendar vanity.

## Classification

| Class | Meaning |
| --- | --- |
| P0 | security / authority / data-loss |
| P1 | reliability / incorrect side effect / recovery |
| P2 | usability / workflow friction |
| P3 | polish / documentation |
| Feature request | deferred until soak review |

## Observe

Runtime: startup/restart, persistence, session continuity, candidate/review/approval lineage, Safe Mode, provider outages and Calendar token expiry, cancellation/timeout, long-running stability, CPU/memory/log growth, exclusive Home lease, authenticated stop/restart, loopback Web UI reconnect. Confirm a second `tars-ng start` on the same Home fails with `home-busy` and that `tars-ng stop` does not signal an unrelated PID.

LLM: `deepseek-official` / `deepseek-v4-flash` stability; response/tool-use quality; provider failures surfaced clearly; missing/invalid credential behavior remains understandable.

Integrations: Calendar token expiry and manual replacement; uncertain side effects remain reconciled rather than blindly retried; no fixture/live confusion. Search credentials may be present; Search is not a shipped TARS-NG capability.

Usability: install, first-run config, approval noise, Mission-Control usefulness (including the local Web UI), whether errors say what to do next, whether daily work feels like a product.

Trust: no silent authority escalation; no secret leakage; no fixture/live confusion; no hidden retry of uncertain side effects; no review/approval bypass after restart; generated capability remains observable and reversible.

`review-complete` remains distinct from approval and activation.

Soak configuration shape: [v0.3.0-seal.md](./v0.3.0-seal.md).
