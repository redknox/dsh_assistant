# Feature freeze and real-world soak

Status: **Implemented** as policy. The current package is **v0.5.0 stabilization candidate**. Duration is operational, not a release metric. Do not treat this file as acceptance, a tag, or a production security certification.

```text
v0.3.0 = Governance + Mission-Control product baseline (historical)
v0.4.0 = prepared Runtime Foundation evidence record (historical, never tagged)
v0.5.0 = Governed Personal Harness stabilization baseline (current)
```

`v0.3.0` remains the latest immutable historical tagged seal. v0.4.0 was prepared but never tagged; its evidence remains intact. v0.5.0 now enters stabilization against [v0.5.0-baseline.md](./v0.5.0-baseline.md). Self-development is allowed; self-authorization is not.

For v0.5.0 stabilization fixes:

- do not add unrelated user-facing capabilities;
- do not add providers merely because they are interesting;
- do not expand Self-Extension authority beyond the isolated generated runtime;
- accept bug fixes, reliability/security/packaging/diagnostics/usability fixes, and documentation.

The question to answer is: **can I depend on this product every day?**

Allowed work: security, authority/governance, data-loss, truthful readiness, reliability/recovery, packaging/install/upgrade, secret/configuration, isolated-runtime E2E closure, performance/resource leaks found during soak, usability that makes the existing product operable, and documentation corrections.

Normally deferred: new integrations, new tool categories, new providers for optionality, new Self-Extension authority, marketplace, additional product features unrelated to a real soak defect.

## Window

Recommended: **at least seven active daily-use days** plus every exit criterion in [v0.5.0-baseline.md](./v0.5.0-baseline.md). Extend the window when defects or sparse usage make the evidence weak.

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

LLM: `deepseek-official` / `deepseek-v4-flash-vision-exp` stability; text, image, and tool-use quality; provider failures surfaced clearly; missing/invalid credential behavior remains understandable.

Integrations: Calendar token expiry and manual replacement; uncertain side effects remain reconciled rather than blindly retried; no fixture/live confusion. Search credentials may be present; Search is not a shipped TARS-NG capability.

Usability: install, first-run config, approval noise, Mission-Control usefulness (including the local Web UI), whether errors say what to do next, whether daily work feels like a product.

Trust: no silent authority escalation; no secret leakage; no fixture/live confusion; no hidden retry of uncertain side effects; no review/approval bypass after restart; generated capability remains observable and reversible.

`review-complete` remains distinct from approval and activation.

Current claim and stabilization criteria: [v0.5.0-baseline.md](./v0.5.0-baseline.md). Historical prepared v0.4.0 evidence: [v0.4.0-seal.md](./v0.4.0-seal.md). Historical tagged v0.3.0 seal: [v0.3.0-seal.md](./v0.3.0-seal.md).
