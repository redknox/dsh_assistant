# Self-Extension durability and ownership

Status: **Verified** by `test/self-extension-restart.test.ts`.

`$DSH_ASSISTANT_HOME/self-extension/` is the durable home. Directory presence is never authorization to mount.

## Ownership

| Store | File | Owns |
| --- | --- | --- |
| Candidate Workspace | `candidates/` + `candidates/index.json` | artifacts, digest, validation evidence, retention class |
| Capability Registry | `authority.json` → `registry` | owner/version/status metadata |
| Governance | `authority.json` → `governance` | approval request/decision + exact fingerprint |
| Activation | `authority.json` → `activation` | transaction state / generation / pending id |
| Recovery | `authority.json` → `recovery` | LKG, Safe Mode, last failure, diagnostics |

`authority.json` is one atomic write (temp + fsync + rename) with named sections so authority changes are not half-written. Schema version is `1`. Unknown or corrupt schema fails closed into Safe Mode / recovery; it never auto-activates.

Authoritative answers:

- current active version → Registry section
- LKG → Recovery section (`current` is not automatically LKG)
- pending activation → Activation section
- trusted approval → Governance section
- Safe Mode → Recovery section

## Restart

```text
load authority + candidate index
→ validate schema
→ complete interrupted rollback / abandon interrupted pre-commit activation
→ remount only committed generated actives after digest check
```

LKG advances only after successful health + durable commit. A restart does not rewrite LKG merely because the process booted.

## Artifact retention

`candidate` → `sealed` → `active` → `retired` / `rollback-retained` / `rejected`. Failed or rolled-back artifacts stay on disk for audit. v0.2.0 garbage collection is manual.
