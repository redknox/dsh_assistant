# Workflow follow-up memo

Date: 2026-09-01

## Decision

Governed native DSH Workflow support has passed the current end-to-end acceptance test. Do not deepen or optimize Workflow further in the current product phase. Return to the main product and UI usability track.

## Accepted evidence

- Candidate `generated--analysis-workflow-dual-perspective-review@0.1.1` completed validation, sealing, Independent Review, exact human approval, and trusted activation.
- Active Catalog execution used only the registered name `dual-perspective-review` plus JSON input; no inline script crossed the execution boundary.
- Run `02df985d-82bd-4a52-8081-2b13793bc4a0` completed with exactly three governed child Agents: two parallel Analyze workers and one Synthesize worker.
- The result contained complete `risk`, `opportunity`, and `synthesis` fields.
- The extension declared no tools, permissions, services, providers, filesystem/network/process/secret access, or remote side effects.
- The full repository suite passed: 654 tests, 0 failures.

## Deferred observation

The acceptance run occurred in a long-lived Session whose JSONL event history had grown to roughly 11 MB. The Workflow completed correctly, but took about four minutes and the host process briefly exceeded 100% CPU. Current evidence points to long-session event persistence/projection overhead rather than a Workflow correctness failure.

This is a non-blocking performance follow-up, not a reason to reopen Workflow design now.

## Revisit only when

- ordinary production Workflow runs repeatedly exceed the agreed latency target;
- long Sessions cause visible UI stalls, missed heartbeats, or failed tool cancellation;
- profiling identifies event persistence/projection as a dominant cost; or
- durable/resumable background Workflow execution becomes a committed product requirement.

When revisiting, start with a reproducible long-session performance fixture and profiling evidence. Do not optimize from this single soak run alone.
