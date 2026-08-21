# Engineering Reliability

Status: **Verified** by `test/reliability.test.ts`. This is the M3 answer to **Is the claimed behavior still correct under real failure semantics?**

`validated` now means the candidate passed both the existing build/test pipeline **and** the reliability gate applicable to its risk class. It is still not approval or activation.

```text
Need
→ Capability Resolution
→ Candidate development
→ Validation + Reliability gate
→ Human approval
→ Activation
```

A passing happy-path test is not enough. Transport failure is not remote failure. Unknown stays unknown.

## Risk classes

Derived from declared effects, not capability-name verbs. `effects.remoteSideEffect` is authoritative:

- omitted + network/credentials → stored as `mutate` → **R3**
- explicit `read-only` + network/credentials → **R1**
- local filesystem mutation → **R2**
- generated control-plane capabilities → **R4** and rejected

A candidate cannot obtain a lower class by naming the capability `send`, `transfer`, `list`, or anything else. It may declare a higher class, but not a lower one.

| Class | Meaning | Gate weight |
| --- | --- | --- |
| R0 | Local / deterministic / no external effects | Synthesized minimal Risk Model is allowed |
| R1 | Bounded read-only external access | Credentials, network boundary, contract vs fixture |
| R2 | Local mutation or durable state | Side effects, filesystem authority, rollback semantics |
| R3 | Credentialed external mutation / process | Full uncertain-outcome, retry, idempotency, reconciliation, adversarial matrix |
| R4 | Control-plane / recovery / approval | Generated Self-Extension must not escalate here |

## Risk Model

Inspectable artifact on `candidate.manifest.riskModel`. Required for R1 and R3. R0 and local R2 may omit it; validation synthesizes an explicit model rather than skipping the stage.

Minimum fields: capability, external systems, trust boundaries, side effects, credentials, network, persistence, failure modes, uncertain outcomes, retry, idempotency, reconciliation, rollback, observability, validation scenarios, unresolved risks.

## Failure modes and outcomes

Failure modes are a closed taxonomy (`timeout-after-side-effect`, `caller-cancelled`, `reconciliation-failed`, …). Unknown semantics stay unknown.

Mutating actions classify outcomes as `not-applied` / `applied` / `unknown` / `reconciled`. A timeout after a possible remote write is `unknown` until independent reconciliation observes otherwise.

## Retry, idempotency, reconciliation

- Reads may retry under a bounded policy.
- Writes must not retry blindly because the transport failed.
- Duplicate-sensitive writes need a provider-native key, deterministic resource id, or equivalent **real contract** evidence.
- Fixture Map de-duplication is not that evidence.
- Uncertain writes reconcile with a **fresh** bounded context. An already-aborted caller signal is not a reconciliation budget.

## Provider contract vs fixture

A test double may simulate a provider. It may not define the provider. R1 external reads and R3 writes both require `real-contract-evidence-present`: `contractKind` must be `real-provider-contract`, `strategy` must not be `fixture-only`, and evidence must be non-empty. R0/local R2 do not take this check.

## Trust boundaries

Credentials, network, filesystem, process, persistence, approval, activation, and recovery each have an owner. Generated code does not inherit ambient host authority. Calendar candidates receive a host-managed bounded Google v3 transport, not arbitrary `fetch`.

Approval / activation / recovery stay on the Recovery Root.

## Adversarial matrix

R3 must cover or explicitly omit: happy path, fail before/after side effect, duplicate delivery, caller cancellation, reconciliation unavailable, credential failure, rate limit, stale proposal, restart, rollback interaction.

Omissions need a reason. Silence is not coverage.

## Rollback vs compensation

Unmounting a plugin rolls back runtime surface. It does not undo an already-committed Google event unless a compensating delete is declared.

## Worked examples

### Google Calendar write (R3)

`googleCalendarWriteRiskModel()` records Google Calendar v3 deterministic event ids, GET-before-insert, GET-after-uncertain-write with `reconciliationSignal()`, host-owned OAuth injection, and `compensatesExternal: false`.

### Obsidian vault (R2)

`obsidianVaultRiskModel()` stays on confined-root filesystem mutation. No credentialed remote matrix is required.

## Checklist for later Self-Extension

1. Derive the risk class from effects; do not pick a lower class.
2. Write a Risk Model before treating validation as complete.
3. Separate fixture behavior from the real contract.
4. Model `unknown` for any write whose remote effect may already have happened.
5. Reconcile with a new budget; never reuse a cancelled signal.
6. Keep credentials and network at the narrowest host boundary.
7. Say whether rollback only unmounts, or actually compensates.
8. Leave unresolved risks explicit.
