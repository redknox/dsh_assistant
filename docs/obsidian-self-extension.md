# First Self-Extension vertical slice: Obsidian Vault

Status: **Verified** by `test/obsidian-e2e.test.ts`. This is the first complete governed lifecycle, not a second filesystem product.

**AI may produce the candidate. A human must approve the exact digest/diff before it becomes active.**

```text
"I need Obsidian support"
        ↓
Capability Registry          What do I have?
        ↓
Capability Resolution Review What should change?
        ↓
Candidate Workspace          Write / test / validate / seal
        ↓
Governance summary           Exact capability + permission diff
        ↓
Human / Recovery Root        Approve this exact fingerprint
        ↓
Cordis activation            Mount the sealed candidate
        ↓
Live vault tools             list / read / search / create
        ↓
Trusted rollback             Return to Last Known Good
```

## Why a new plugin

`files.read` already exists on `managed/integrations`. Resolution **reuses** that capability when the need is generic file listing.

The Obsidian need is different: vault-relative note identity, YAML frontmatter, `#tags`, and `[[wikilinks]]`. Review of `obsidian.notes.read` with a complete inventory therefore returns `new-plugin`, and the implications state that generic `files.read` is insufficient. The candidate must not register a second generic filesystem service.

## Human authority

These steps are Recovery Root / human-control only. They are not model tools.

| Step | Who |
| --- | --- |
| Request approval | Assistant / orchestrator (`request_extension_approval`) |
| Approve exact fingerprint | Human via `RecoveryRoot.recordApproval` |
| Activate | Human via `RecoveryRoot.activate` |
| Rollback / Safe Mode | Human via `RecoveryRoot` |

`ctx.extensionRecovery` cannot mint a trusted credential.

## Candidate artifact

The generated plugin lives in the Candidate Workspace (copied from `fixtures/self-extension/obsidian-vault-candidate/` in the E2E). It is not added to the managed product tree before approval. Validation executes the candidate's Node test files and binds evidence to the sealed digest.

Vault access is confined to one approved root. The inspectable permission ids are `filesystem.vault.read` and `filesystem.vault.write`; the exact root is in `effects.filesystem` and `configRequired: vaultRoot`. Network and process effects stay empty.

## Offline fixture

`fixtures/obsidian-vault/` is a deterministic Vault with nested notes, frontmatter, tags, wikilinks, and an ambiguous `Alpha` basename. The E2E copies it to a temp directory so the repo fixture is not mutated.
