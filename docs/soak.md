# Feature freeze and real-world soak

Status: **Implemented** as the M5 product-readiness policy. Duration is operational, not a release metric.

After [Issue #51](https://github.com/redknox/dsh_assistant/issues/51) is accepted:

- do not add new user-facing capabilities during the initial soak;
- do not add providers merely because they are interesting;
- do not expand Self-Extension authority;
- do not add new tool categories without a reliability-driven reason;
- accept bug fixes, reliability/security/packaging/diagnostics/usability fixes, and documentation;
- treat new-functionality requests as backlog, not immediate work.

The question to answer is: **can I depend on this product every day?**

## Window

Recommended: **2–4 weeks of daily use** after Product Readiness is accepted. Adjust for usage density, not calendar vanity.

## Classification

| Class | Meaning |
| --- | --- |
| P0 | security / authority / data-loss |
| P1 | reliability / incorrect side effect / recovery |
| P2 | usability / workflow friction |
| P3 | polish / documentation |
| Feature request | deferred until soak review |

## Observe

Runtime: startup/restart, persistence, session continuity, candidate/review/approval lineage, Safe Mode, provider outages and Calendar token expiry, cancellation/timeout, long-running stability.

Usability: install, first-run config, approval noise, Mission-Control usefulness, whether errors say what to do next, whether daily work feels like a product.

Trust: no silent authority escalation; no secret leakage; no fixture/live confusion; no hidden retry of uncertain side effects; no review/approval bypass after restart; generated capability remains observable and reversible.

`review-complete` remains distinct from approval and activation.
