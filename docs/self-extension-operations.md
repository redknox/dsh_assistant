# Self-Extension operator runbook (v0.2.0)

Trusted control lives on `RecoveryRoot` / `npm run self-extension`, and on the local Mission-Control Web UI for exact-diff **approve** plus a separate **activate** confirmation. The model may inspect and request approval only. A control-plane decision is not a human conversation message.

Set `TARS_NG_HOME` (preferred) or `DSH_ASSISTANT_HOME`, or pass `bootAssistantControl({ home })`. Product CLI: `tars-ng self-extension <command>`.

## What survives restart

Registry records, sealed candidate artifacts + digest, approvals, activation transaction, LKG, Safe Mode, last failure. Not: Cordis fibers, live tools, AbortSignals, model objects.

## What the Assistant/model can do

Inspect registry, request a Capability Resolution Review, write/validate/seal a candidate, request approval, inspect eligibility.

## What only a trusted operator can do

Approve an exact fingerprint, activate (CLI or WUI Activation Card with explicit confirm), uninstall one active generated/user plugin from the READY-state WUI trash action, reactivate that exact disabled revision from the Extensions view, rollback the previous LKG from the READY-state **Rollback system state** card or CLI, disable, enter/exit Safe Mode, backup/restore durable Self-Extension state, rewrite LKG indirectly via those actions. Approval never auto-activates. Uninstall disables one plugin and keeps it discoverable. Reactivate remounts the same sealed owner/version after revalidation. Rollback restores the authoritative previous system snapshot. None of these delete sealed artifacts, review, approval, or audit history. Stale or replayed rollback/activation cards fail closed.

## Normal lifecycle

```text
self-extension status
self-extension candidates
self-extension inspect <id>
self-extension diff <id>
self-extension request-approval <id>
self-extension approve <id> <fingerprint>
self-extension activate <id>
# verify live tools
# restart the process
self-extension status
self-extension rollback
self-extension disable <owner> <version>
self-extension migrate-authoring-contract <id>
self-extension safe-mode enter|status|exit
self-extension diagnostics
self-extension lkg
self-extension backup <dir>
self-extension restore <dir>
```

Backup/restore procedures and the v0.2.x release-confidence command: [docs/v0.2-stabilization.md](./v0.2-stabilization.md).

## Recovery

- Missing or mutated active artifact: boot fails closed into Safe Mode with `missing-active-artifact` / `digest-mismatch`. Recovery root remains available.
- Corrupt / unknown `authority.json` schema: no auto-activation; Safe Mode / recovery control still boots.
- Interrupted activation before commit: prior LKG stays authoritative.
- Interrupted activation after a tentative Registry update and before the authority commit: prior LKG remains authoritative.
- Interrupted activation after commit: restart remounts the committed version.
- One committed generated artifact missing or mutated: Safe Mode, no generated extension remounts.
- Pre-`generated-extension-api/v1` generated artifacts (homes persisted before this contract): remount withholds **that owner only**. The host does not invent a v1 stamp or reuse the old approval fingerprint. Other valid generated owners still remount. After that verified withhold, `current` / `lastKnownGood` / `rollbackTarget` become the reduced remountable snapshot so a later migrate+activate rolls back to it, not to the unrunnable legacy owner. `lastFailure` includes `legacy-authoring-contract:<id>`. Operator path: `tars-ng self-extension migrate-authoring-contract <id>` (new host-stamped revision) → Independent Review → request → approve the **new** fingerprint → activate. Rollback after that activate restores the reduced snapshot. The old sealed parent stays for audit.
- Interrupted rollback: restart completes rollback or enters Safe Mode.
- Exit Safe Mode is a trusted operator action. It does not remount a failed generated plugin by itself. Historical `lastFailure` remains diagnosable after a verified rollback; that history is not the current recovery-required condition.
