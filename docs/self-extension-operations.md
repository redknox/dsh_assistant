# Self-Extension operator runbook (v0.2.0)

Trusted control lives on `RecoveryRoot` / `npm run self-extension`. The model may inspect and request approval only.

Set `DSH_ASSISTANT_HOME` (or pass `bootAssistantControl({ home })`).

## What survives restart

Registry records, sealed candidate artifacts + digest, approvals, activation transaction, LKG, Safe Mode, last failure. Not: Cordis fibers, live tools, AbortSignals, model objects.

## What the Assistant/model can do

Inspect registry, request a Capability Resolution Review, write/validate/seal a candidate, request approval, inspect eligibility.

## What only a trusted operator can do

Approve an exact fingerprint, activate, rollback, disable, enter/exit Safe Mode, rewrite LKG indirectly via those actions.

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
self-extension safe-mode enter|status|exit
self-extension diagnostics
self-extension lkg
```

## Recovery

- Missing or mutated active artifact: boot fails closed into Safe Mode with `missing-active-artifact` / `digest-mismatch`. Recovery root remains available.
- Corrupt / unknown `authority.json` schema: no auto-activation; Safe Mode / recovery control still boots.
- Interrupted activation before commit: prior LKG stays authoritative.
- Interrupted activation after a tentative Registry update and before the authority commit: prior LKG remains authoritative.
- Interrupted activation after commit: restart remounts the committed version.
- One committed generated artifact missing or mutated: Safe Mode, no generated extension remounts.
- Interrupted rollback: restart completes rollback or enters Safe Mode.
- Exit Safe Mode is a trusted operator action. It does not remount a failed generated plugin by itself.
