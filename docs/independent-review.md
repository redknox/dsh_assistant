# Independent Review

Status: **Verified** by `test/review.test.ts`. This is the M4 answer to **Can TARS-NG review and repair a Self-Extension candidate without certifying itself?**

```text
Self-development without self-certification.
```

The assistant may design, implement, test, review, and repair candidates. It must not certify that work merely because the same execution path says it is correct. Review evidence is independently produced, replayable, and unable to override governance authority.

```text
review-complete != approved
review-complete != active
```

## Roles

| Role | Produces | Must not do |
| --- | --- | --- |
| **Builder** | Candidate changes and implementation evidence | Mark its own review as passed |
| **Reviewer** | Structured findings against a sealed Review Package | Approve, activate, waive M3 gates, or change Recovery Root authority |
| **Repairer** | A new candidate revision that addresses an accepted finding set | Implicitly authorize unrelated changes |
| **Governance / Human** | Exact-diff approval and activation | Be replaced by `review-complete` |

Builder and Reviewer may share the same underlying model implementation. They must not share an uncontrolled mutable reasoning state. Review always starts from a **fresh context** built from explicit artifacts.

Builder rationale, if present, is a claim to inspect. It is not trusted evidence.

```text
Explanation is evidence to inspect, not authority to inherit.
```

## Lifecycle

```text
Need
→ Capability Resolution
→ Architecture / Risk Model
→ Builder implementation
→ deterministic validation (M3)
→ Independent Review
→ findings
→ Repair loop
→ re-validation
→ re-review
→ review-complete
→ human/governance approval
→ activation
```

## Review Package

`reviewPackageFromCandidate()` is host-built. Candidate metadata cannot supply authoritative `reviewPassed`.

The package contains inspectable references only:

- issue / acceptance contract (resolution kind + capability)
- candidate identity + sealed digest
- parent revision
- Capability Resolution kind
- Risk Model and derived risk class
- Reliability Gate result
- validation stages
- provider/runtime contract fields
- permission/effect diff when provided
- prior review findings on re-review
- optional `builderClaims` (never authority)

Forbidden hidden keys: Builder scratch, chain-of-thought, private reasoning state.

The Reviewer provider contract is:

```text
ReviewService.review(reviewPackage) -> ReviewReport
ReviewerProvider.semanticReview(reviewPackage, policy) -> findings
```

Default provider: `PolicyReviewerProvider` (host-managed checklist). A later model, specialized prompt, or external reviewer can implement the same `ReviewerProvider` seam. There is no second Agent Loop.

## Sealed candidate identity

Every review binds to one digest. Findings record that digest. If the candidate changes, `status()` becomes `stale` and the previous report cannot certify the new revision. Re-review must bind to the new digest.

```text
No floating review target.
```

## Deterministic prechecks vs semantic review

```text
candidate
→ deterministic validation (M3)
→ deterministic review prechecks
→ model/semantic adversarial review
```

Prechecks (host-enforced, not waivable by Reviewer output):

- candidate is sealed and has a digest
- review policy version is the pinned host version (`m4.1`)
- validation passed
- Reliability Gate passed for R1/R3
- generated R4 / control-plane escalation is rejected
- candidate `reviewPassed` claims are ignored
- prior open BLOCKERs from the parent revision cannot be omitted

The semantic Reviewer spends effort on gaps the checklist cannot see. It cannot turn a failed deterministic gate into `review-complete`.

## Findings

Structured fields: id, reviewed digest, severity, category, claim, location, evidence, why it matters, required remediation, blocking, status.

Severity: `BLOCKER` | `MAJOR` | `MINOR` | `NOTE`. Only blocking open findings prevent completion. `BLOCKER` is blocking.

## Review states

| State | Meaning |
| --- | --- |
| `not-reviewed` | No host review for this candidate id |
| `changes-required` | Open blocking finding, or a deterministic gate failed |
| `review-complete` | Current digest, current policy, no open blocking finding |
| `stale` | A report exists, but it bound a different digest |

`review-complete` still reports `Approval status: NOT APPROVED`.

## Repair / re-review lineage

```text
Review N on candidate A
→ findings
→ accepted repair scope
→ Builder produces candidate B (new digest)
→ deterministic validation
→ Review N+1 on candidate B, carrying prior findings
```

Repairing one finding does not authorize unrelated edits. Resolved findings stay in the report. A BLOCKER that is simply dropped from `priorFindings` while the parent review still has it open becomes a lineage BLOCKER.

Prior open BLOCKERs are inherited from the host-owned parent `ReviewReport`, not from caller-edited `priorFindings` status. They remain open on the child revision by default. They may become resolved only when current-revision evidence proves the invariant:

- the Reviewer returns the same finding with `status: resolved` and `reviewedDigest` equal to the new digest; or
- a deterministic host-owned check for that invariant succeeds on the current package.

`priorFindings` is trace/context. It cannot rewrite an inherited BLOCKER from `open` to `resolved`. `parentRevision` is also a caller hint: the service derives the parent from host report history for the same candidate, and an unknown or mismatched parent digest fails closed instead of dropping lineage.

Host review history is durable (`self-extension/review-lineage.json` when `$DSH_ASSISTANT_HOME` is set). Restart reconstructs `byCandidate` / `byDigest` from that file. Caller `priorFindings` are not authority when host lineage is required. Missing or corrupt lineage fails closed; it is not treated as a first review.

Reviewer silence is not resolution. Stale resolution evidence bound to an older digest cannot close a newer revision. Builder text that says “fixed” is not proof. A BLOCKER omitted from `priorFindings` while the parent report still has it open also produces a lineage BLOCKER.

New findings may appear during re-review.

## Risk-aware depth

| Class | Review depth |
| --- | --- |
| R0 | Lightweight contract/regression |
| R1 | External contract + credential/network boundary |
| R2 | Mutation / persistence / rollback claims |
| R3 | Full adversarial side-effect, uncertain outcome, retry, reconciliation |
| R4 | Generated Self-Extension rejected; Reviewer cannot waive |

## Worked examples

### Successful Calendar R3 review

`googleCalendarWriteRiskModel()` plus a passing Reliability Gate is enough for a complete R3 review. The report still says **NOT APPROVED**. Human/governance approval remains required.

### Failed review + repair + re-review

An R3 candidate that reuses a cancelled reconciliation context receives a `cancelled-context-reuse` BLOCKER (`changes-required`). Repair produces a new digest with `cancelledContextReuse: false` and carries the prior finding. Re-review may mark it resolved only because a host check proves the invariant on the new digest, not because the Reviewer stayed silent. A new BLOCKER may still appear. Completing review still does not approve or activate.

## Non-goals

No autonomous approval or activation. No second DSH/Agent runtime. No GitHub review-bot product. No M5 personality/workspace work. No release or version bump for this issue.
