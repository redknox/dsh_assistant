# Skill lifecycle packaged human soak record

Status: **historical feature soak for Issue #94**. #94 was accepted and closed; PR #95 merged to `main`. This file remains the Skill-lifecycle soak record (package `0.3.0`). It is **not** the v0.4.0 product seal. Final packaged integration evidence is [v0.4.0-seal.md](./v0.4.0-seal.md).

This is not `test/packaging.test.ts` and not `test/skill-lifecycle.test.ts`. Those remain scripted coverage.

Do not paste credentials, tokens, home paths, candidate source dumps, or instruction bodies into this file.

## Identity

| Field | Value |
| --- | --- |
| Date | 2026-08-26 |
| Commit | `3db11daa258fa4fe1c268ba9db3fc96ce913c54d` |
| Package | `dsh-assistant@0.3.0` packed tarball `dsh-assistant-0.3.0.tgz` |
| Tarball SHA-256 | `77c53ed33e4bb41fac76db96fb1f85cbc883e808aabf49c601c7a4c98babf42f` |
| Install | `npm install --omit=dev` of that tarball into a clean prefix |
| Home | isolated temp Home (`TARS_NG_HOME`); daily `127.0.0.1:8787` Home was not used or stopped |
| Web UI | packed `dist/web` on loopback port **8799** (`TARS_NG_UI_PORT`) |
| Profile identity | `v1:f151980e5483a185518db82be340a1d4b2ae06441fe3c73f2c8f3236761e5b81` |
| LLM | `deepseek-official` / `deepseek-v4-flash` (credential present by name only) |
| Fixtures | `TARS_NG_ALLOW_FIXTURES` unset |

## Checklist

| #94 step | Result |
| --- | --- |
| Start with no user Skills; ambient Skills not discovered | Packed `doctor` / first start: `skills: catalog=empty candidates=0 active=(none)`. WUI Skills Center: “No Skills in this Profile catalog.” |
| Ask TARS-NG to draft a harmless Skill | Conversation: `plan_skill` → `create_skill_candidate` → inspect/list/read. Activity: `Skill weekly-review@1.0.0 draft`. |
| Inspect and validate | `validate_skill` then `seal_skill`. Activity: `validate`, `seal`. |
| Independent Review + exact approval | `request_skill_review` then `request_skill_approval`. WUI Skills Center **APPROVE** / **CONFIRM APPROVE**. Lifecycle `approved` while catalog stayed `empty`. |
| Unavailable before activation | `skillCatalog.state=empty`; no composer chip until activate. |
| Activate from WUI; invoke in a topic conversation | **ACTIVATE** / **CONFIRM ACTIVATE**. Catalog `ok`, chip `weekly-review`. New conversation + chip “Use the weekly-review skill.” Activity: `COMPLETED skill`, then `recall_memory` / `retrieve_knowledge` only (no calendar/mail/shell). |
| Restart and invoke again | `tars-ng stop` of the soak Home only; daily 8787 stayed up. Restart `doctor`: `catalog=ok active=weekly-review@1.0.0`. New conversation after a fresh UI cookie; invoke posted again. |
| v2 with a visible instruction change | Fork `weekly-review@1.0.1`. Digest `f8e0841b69cf8dfecfdffd63e90e7816fad0f25de4d7dd23628001d9b7f05c88`. Fingerprint `afc2565c2de1a05379d31708ef4bf702fce6d0a841070c61076e2f3295c28e40`. Approve + activate. `1.0.0` became `disabled`; catalog `ok` on `1.0.1`. |
| Disable, reactivate, uninstall, rollback | Disable `1.0.1` → catalog `empty`. Reactivate restored `1.0.0` active. Uninstall exact `weekly-review@1.0.0` → `uninstalled`, catalog `empty`. Rollback restored `1.0.0` active, catalog `ok`. |
| Import one equivalent local third-party Skill from outside the package | Same name/version as sealed `1.0.0` → `import-duplicate-conflict`. Outside copy bumped to `2.0.0` only: `tars-ng skill import-local` → `weekly-review@2.0.0` `provenance.kind=third-party` `lifecycle=imported` `nextAction=validate`. |
| One malformed/symlink bundle rejection | Symlink `SKILL.md` → `skill-boundary: symlink rejected: SKILL.md` (exit 1). Catalog unchanged. |
| Safe Mode: user/third-party Skills withheld | First soak: live WUI `SAFE_MODE` / `safeMode=true`; CLI disagreed (see append). |

### Bounded Skill ids

| Id | Digest (sha256) | Notes |
| --- | --- | --- |
| `weekly-review@1.0.0` | `351f49a1f41e3f5cfa07b03db6920982bf39bbd0939a380050269c522835e8c4` | Assistant-authored v1; later uninstalled then rollback-active |
| `weekly-review@1.0.1` | `f8e0841b69cf8dfecfdffd63e90e7816fad0f25de4d7dd23628001d9b7f05c88` | v2 fork; instruction change (first-line marker in the live body, not copied here) |
| `weekly-review@2.0.0` | (imported, unsealed) | Operator CLI third-party equivalent |

## Commands used (no secrets)

```sh
npm run build
npm pack
npm install --omit=dev --prefix <clean-prefix> ./dsh-assistant-0.3.0.tgz
TARS_NG_HOME=<isolated-home> TARS_NG_UI_PORT=8799 tars-ng doctor --home <isolated-home> --workspace <ws> --session-root <sessions>
tars-ng start --once --home <isolated-home> --workspace <ws> --session-root <sessions>
tars-ng skill import-local <outside-dir> --home <isolated-home>
tars-ng start --home <isolated-home> --workspace <ws> --session-root <sessions>
tars-ng stop --home <isolated-home>
```

Trusted WUI actions used `POST /api/skill` with `confirm: true` and exact id/name/version/digest/generation (and approval fingerprint when approving).

## Limitations

- Operator XDG env had Calendar token **present**; soak prompts forbade calendar/mail/filesystem/network tools. The invoke path observed `skill` + memory + knowledge only.
- After restart, a stale WUI cookie shows `Web UI session is untrusted; reload the page.` Reload is required. One post-restart soak process was stopped (product `lifecycle stop`); the soak Home was started again. Daily 8787 was not that stop target.
- Global Activity does not isolate per-conversation `COMPLETED skill` rows; post-restart invoke is recorded by new session id + message, not a unique activity id.
- First soak `reactivate` after disabling `1.0.1` used the disabled `1.0.0` row (name-based). Exact `1.0.1` reactivate is in the append.
- Same-name same-version third-party import is refused (`import-duplicate-conflict`). Equivalent import used version `2.0.0`.
- First soak CLI `doctor` / `start --once` disagreed with live WUI on Safe Mode. Fixed in `ed6c002`; four-way evidence is in the append.
- This record does not accept #94. No tag, no version bump.

## Append — review follow-up (`ed6c002`)

Code P1: doctor / status / `start --once` / live start share the same Home/Profile Safe Mode composition. Held `doctor` reads live `/api/runtime-health` (`doctor-source: live-runtime`) using the on-disk `runId`. Safe Mode Skill health is `catalog=withheld`, not ordinary `ok`.

Packaged identity for this append:

| Field | Value |
| --- | --- |
| Commit | `ed6c002` |
| Tarball SHA-256 | `315d41a3162783a8b13cc62a1db6a31bfec872373ae643066fa9eb50104e6bbc` |
| Install | `npm install --omit=dev` of that tarball into a clean prefix (no `src/`) |
| Skill Home | same isolated Home as the first soak (not daily 8787) |
| Safe Mode Home | a second isolated Home + `TARS_NG_PROFILE_ROOT` copy with a broken `assistant` patch |
| Web UI | **8799** (Skill Home); **8801** (Safe Mode Home) |

### Four-way Safe Mode

Broken assistant Profile patch on the Safe Mode Home:

| Surface | Observed |
| --- | --- |
| `doctor` | `safe-mode: true`, `doctor-source: boot`, `catalog=withheld` |
| `status` | `safe-mode: true` |
| `start --once` | `safe-mode: true`, `catalog=withheld` |
| live `start` + WUI | `systemState=SAFE_MODE`, `runtimeContext.safeMode=true`, `skillCatalog.state=withheld` |
| held `doctor` | `safe-mode: true`, `doctor-source: live-runtime`, `catalog=withheld`, `home-owner: verified runtime … (doctor stayed read-only)` |
| held `status` | `safe-mode: true` |

After restoring the shipped patch: `doctor` / `status` `safe-mode: false`; catalog `empty` (no user Skills on that Home). Daily `127.0.0.1:8787` stayed up.

### Failed activation LKG (packaged WUI)

Skill Home started with `weekly-review@1.0.0` active and `weekly-review@1.0.1` disabled. Sealed `1.0.1` candidate bytes were mutated so they no longer matched digest `f8e0841b…`. WUI `POST /api/skill` **reactivate** bound exact `weekly-review@1.0.1` / digest / generation.

- HTTP **409** `skill-action-denied`
- `1.0.0` remained **active**
- `1.0.1` stayed **disabled** with bounded `lastFailure.phase=activate` `detail=digest-mismatch` (no body/path)
- live `doctor`: `doctor-source: live-runtime`, `active=weekly-review@1.0.0`, `failed=weekly-review@1.0.1`
- After `stop` + `start`, WUI and `doctor` still showed the same LKG + `lastFailure`

### Exact `weekly-review@1.0.1` Reactivate

Candidate bytes restored to the sealed digest. WUI **reactivate** bound `weekly-review@1.0.1` digest `f8e0841b…` generation `22` (`confirm: true`).

- HTTP **200**
- catalog `ok`, `active=weekly-review@1.0.1`, `failed=(none)`
- `1.0.0` stayed **disabled** (no silent version pick)
- `start --once` after `stop`: `active=weekly-review@1.0.1`

### backup / restore + Home isolation

`tars-ng self-extension backup` while the Skill Home was not held. Backup index kept exact `weekly-review@1.0.1` active digest `f8e0841b…` and disabled `1.0.0` digest `351f49a1…`. Unsealed imported `2.0.0` was not in the sealed backup set.

A **second** isolated Home: `catalog=empty`, no `weekly-review` active directory; restore into a **third** Home reproduced `active=weekly-review@1.0.1` with the same digests. The source Skill Home was unchanged. The second Home stayed empty.

## Append — withheld invocation (`6262c55`)

Active user Skill then the same Skill Home entered Safe Mode (`tars-ng self-extension safe-mode enter`). Packed tarball SHA-256 `cf716729eb148bc0b772a8490accd8333c70ce8cfc3d09038bf46031e3f6c308`. WUI **8799**. Daily 8787 stayed up.

- Live `doctor`: `safe-mode: true`, `doctor-source: live-runtime`, `catalog=withheld`, `active=weekly-review@1.0.1`
- WUI: `SAFE_MODE`, `skillCatalog.state=withheld`, persisted rows still listed (`1.0.1` active, `1.0.0` disabled)
- Composer: no Skill chip (`data-skill-chip` count 0)
- Skills Center: inspectable rows, Disable/Uninstall/Rollback present; no Activate / Reactivate
- Capability strip: no Skill tool row
- `POST /api/skill` activate and reactivate with exact id/digest/generation → **409** `catalog-withheld`; lifecycle/digest/generation unchanged
- Safe Mode exited after the probe; `weekly-review@1.0.1` remained the committed active revision

## Outcome

Packaged human soak **executed and recorded** against `3db11da`, then append-recorded against `ed6c002` and `6262c55`. Acceptance remains a human decision on #94.
