# TARS-NG operator guide

Product command: `tars-ng`. Package name remains `dsh-assistant` (private; install from a tarball). Architecture still uses DeepSeek Harness public seams; operators do not clone or assemble DSH by hand.

Supported runtime: **Node >=22**, DSH **0.1.0-rc.8** (pinned). Unsupported DSH versions fail in `tars-ng doctor` / `start` with an explicit problem line.

## Installation

From this repository (no public npm publish is required):

```sh
npm install
npm run build
npm pack
```

Install the tarball on the machine that will run TARS-NG:

```sh
npm install -g ./dsh-assistant-0.2.0.tgz
tars-ng doctor
```

or a local install:

```sh
npm install ./dsh-assistant-0.2.0.tgz
npx tars-ng doctor
```

Installing the package pulls Cordis/DSH runtime dependencies through npm. Do not clone DeepSeek Harness to start TARS-NG.

`tsx` and `src/` are contributor tools. The supported runtime is `dist/` via `tars-ng`.

## Quick start

```sh
tars-ng start --once    # first-run summary, then exit (no browser wait)
tars-ng start           # boot runtime + local Web UI; stay until Ctrl-C
tars-ng status
tars-ng doctor
tars-ng stop
```

`tars-ng start` prints a loopback URL (default `http://127.0.0.1:8787`). Open that address for daily conversation, Activity, approvals, capabilities, and Safe Mode/recovery. Override the port with `TARS_NG_UI_PORT`. The server binds loopback only; unsupported `Origin` headers are rejected; there is no wildcard CORS and no login in this release. Governance mutations require the per-launch `HttpOnly; SameSite=Strict` UI session cookie established when the page loads. Approval binds the current card id, candidate id (Self-Extension), and fingerprint. Rollback and Exit Safe Mode require an explicit confirmation. Exit Safe Mode is refused while recovery is still required; a verified rollback keeps historical `lastFailure` diagnostics but allows exit.

`tars-ng status` reports whether the product is running and, when it is, the Web UI address. `tars-ng stop` terminates the runtime and the local Web server.

If the browser disconnects, reconnect; the UI reloads a fresh `MissionControlView`. Do not treat browser-local state as approval, activation, or recovery authority.

CLI remains authoritative for installation, `doctor`, `status`, `stop`, and recovery when the Web UI itself is unavailable.

Missing optional Google credentials do not block core start. Missing `DEEPSEEK_API_KEY`, or an unresolved default model route, makes `tars-ng start` fail with `LLM not configured/unavailable`. `doctor` and `status` still run and report the problem. Missing Node/DSH, or corrupt/unsupported durable authority, fails closed.

Soak LLM baseline (shipped with the product, not assembled by the operator):

```text
provider: deepseek-official
model: deepseek-v4-flash
credential: DEEPSEEK_API_KEY
```

## Configuration precedence

```text
CLI flag (--home, --allow-fixtures)
→ process environment
→ $TARS_NG_HOME/config/env and ~/.config/tars-ng/env
→ $TARS_NG_HOME/config/product.json
→ product default
```

There is no hidden source. Later rows do not override a value already set higher up (`env` files skip keys already present in the process environment).

Classes of configuration:

| Class | Where | Examples |
| --- | --- | --- |
| Product configuration | `config/product.json` | `allowFixtures` |
| Non-secret integration config | env / env file | `GOOGLE_SEARCH_ENGINE_ID`, `DSH_ASSISTANT_GOOGLE_CALENDAR_MODE` |
| Secrets | env / chmod 600 env file only | `DEEPSEEK_API_KEY`, `DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN`, `GOOGLE_SEARCH_API_KEY` |
| Runtime/durable state | `$TARS_NG_HOME/self-extension/` | authority, candidates, review lineage |

`product.json` schema version is `1`. A newer schema fails clearly.

## Secrets

Never store secrets in source, git, candidate artifacts, Registry metadata, approval payloads, `product.json`, logs, diagnostics, or Self-Extension backups.

Supported injection:

```sh
mkdir -p ~/.config/tars-ng
chmod 700 ~/.config/tars-ng
cat > ~/.config/tars-ng/env <<'EOF'
DEEPSEEK_API_KEY=...
DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN=...
GOOGLE_SEARCH_API_KEY=...
GOOGLE_SEARCH_ENGINE_ID=...
EOF
chmod 600 ~/.config/tars-ng/env
```

`$TARS_NG_HOME/config/env` is also loaded. `tars-ng doctor` reports **which names are missing** and never prints values. An env file that is group/world-readable is flagged as insecure.

Do not invent an internal plaintext vault.

## Default LLM (soak baseline)

The packed runtime mounts `@deepseek-ai/dsh-llm-deepseek` and sets the Agent default to `deepseek-official` / `deepseek-v4-flash`. Operators do not wire DSH provider internals.

`DEEPSEEK_API_KEY` is required for a usable AI runtime. `tars-ng doctor` and `tars-ng status` may run without it. `tars-ng start` fails fast with `LLM not configured/unavailable`, names `DEEPSEEK_API_KEY` if missing, and does not write a pid or enter the long-running state. Product start is not equivalent to a usable AI runtime.

`tars-ng doctor` prints provider, model, whether the credential name is present, and whether the model route is available. It never prints the key.

## Google Search setup

Search is **not shipped**. `GOOGLE_SEARCH_API_KEY` (secret) and `GOOGLE_SEARCH_ENGINE_ID` (non-secret config) are diagnosed by name so soak machines can record what is configured. They are not consumed. Feature requests stay in the soak backlog.

## Google Calendar setup / token expiry

Calendar in the core product is **unavailable** unless you explicitly opt in:

| Mode | How | Operator meaning |
| --- | --- | --- |
| unavailable (default) | no `--allow-fixtures`, `DSH_ASSISTANT_GOOGLE_CALENDAR_MODE` unset | Not configured. Fixture events are not returned as live data. |
| fake | `--allow-fixtures` or `TARS_NG_ALLOW_FIXTURES=1` | Explicit fixture. Not live user data. |
| live | `DSH_ASSISTANT_GOOGLE_CALENDAR_MODE=live` plus access token | Host-bounded Google Calendar v3. |

`DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN` is an **OAuth access token**. It expires. It is not a stable API key. For this soak, replace the token manually when Calendar returns unavailable/401. TARS-NG does not implement OAuth refresh in this issue.

Missing token: live transport fails with `DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN is missing` and does not call Google. Expired/invalid token: `Calendar access token expired or invalid; replace DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN`. Messages are sanitized; values are not logged.

A generated Google Calendar provider still requires the existing M1–M4 approval/activation path. `review-complete` is not approval.

## Start / stop / status / doctor

| Command | Behavior |
| --- | --- |
| `tars-ng start` | Ensures home, loads env, checks Node/DSH and default LLM, boots, starts the loopback Web UI, prints the URL, waits for SIGINT/SIGTERM. Fails without writing a pid when the default LLM is unusable or the Web UI cannot bind |
| `tars-ng start --once` | Same checks and boot, then exits without serving the Web UI (packaging/smoke). Non-zero when the default LLM is unusable |
| `tars-ng status` | Version, running pid, home, Web UI URL when running, DSH compatibility — no secret values |
| `tars-ng doctor` | Version, Node, DSH packages, home, env-file safety, credential **names**, LLM provider/model/route, `ai-runtime`, integration mode, Safe Mode/recovery |
| `tars-ng stop` | SIGTERM to the pid recorded by `start` (runtime and Web UI) |
| `tars-ng self-extension …` | Existing Recovery Root operator commands (approve/activate/rollback/backup/…) |

Doctor never prints Authorization headers, token values, credential-bearing URLs, or chain-of-thought.

## Data directory

```text
$TARS_NG_HOME/          # TARS_NG_HOME, else DSH_ASSISTANT_HOME, else ~/.local/share/tars-ng
  config/               # product.json, optional env
  data/                 # personal memory JSON
  state/                # pid, last-status (no secrets)
  logs/                 # tars-ng.log (rotated ~2 MiB)
  backups/              # operator-chosen backup destination may live here
  generated/            # reserved; not trusted core
  self-extension/       # M1 durable authority / candidates / review lineage
```

Runtime data does not depend on the process working directory. Reinstalling package code does not delete this tree. Directories are created mode `700`.

`DSH_ASSISTANT_HOME` remains a compatibility alias. Prefer `TARS_NG_HOME`.

## Logs

Location: `$TARS_NG_HOME/logs/tars-ng.log`. Lifecycle, Safe Mode, and failure summaries only. Credentials and hidden chain-of-thought are not written. Provider errors pass through the existing sanitizer. Uncertain Calendar side effects stay distinct from definite failures (M3). This is not an observability platform.

## Backup / recovery / Safe Mode / uninstall

| Action | Effect |
| --- | --- |
| Uninstall / upgrade package code | Removes `node_modules` / global bin. **Does not** delete `$TARS_NG_HOME`. |
| Remove user data | `rm -rf "$TARS_NG_HOME"` — deliberate, not default |
| Reset TARS-NG | Same as removing user data, then `tars-ng start` |
| Restore backup | `tars-ng self-extension restore <dir>` (Recovery Root; no secrets in backup) |
| Safe Mode recovery | Durable integrity failure or `self-extension safe-mode enter` |

Backups exclude secrets, credentials, personal memory, env files, and unsealed workspaces. See [self-extension-durability.md](./self-extension-durability.md) and [self-extension-operations.md](./self-extension-operations.md).

## Upgrade / rollback

- Product version: `tars-ng doctor` / package.json `0.2.0`
- Durable authority schema: `1` (unknown/newer fails closed into Safe Mode; it is not reinterpreted)
- Product config schema: `1` (newer `product.json` fails clearly)
- Package rollback: reinstall the previous tarball; home is unchanged
- No cloud auto-updater

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `ai-runtime: LLM not configured/unavailable` | Set `DEEPSEEK_API_KEY`; `tars-ng start` fails until the default LLM is usable |
| `… is outside the supported DSH release` | Reinstall this tarball; do not mix newer RCs |
| Calendar fixture events in daily use | Unset `TARS_NG_ALLOW_FIXTURES`; do not pass `--allow-fixtures` |
| Calendar unavailable after live mode | Replace `DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN`; it expires |
| Safe Mode | Web UI recovery controls or `tars-ng doctor` then Recovery Root runbook; do not mint approval from the model |
| Web UI will not bind | Another process owns the port, or `TARS_NG_UI_HOST` is not loopback; start fails clearly |
| Env file insecure | `chmod 600` the file |

## Feature freeze / soak

After this product-readiness issue is accepted, TARS-NG enters feature freeze. See [soak.md](./soak.md).
