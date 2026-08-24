import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { operatorStatus } from '../domain/self-extension/status.js'
import { runSelfExtensionCli } from '../runtime/self-extension-cli.js'
import { bootAssistantControl, createAssistantAgent } from '../runtime/boot.js'
import { inspectCompatibility } from './compatibility.js'
import { DEFAULT_LLM_MODEL, DEFAULT_LLM_PROVIDER, PRODUCT_COMMAND, PRODUCT_NAME, PRODUCT_UI_SESSION_ID } from './constants.js'
import { attachRuntimeDoctor, collectStaticDoctor, formatDoctorReport } from './doctor.js'
import { inspectEnvFile, type EnvFileLoad } from './env.js'
import { inspectLlmRuntime, formatUnusableLlmError } from './llm.js'
import {
  ensureProductHome,
  processAlive,
  readLastStatus,
  readProductUserConfig,
  resolveProductHome,
  writeLastStatus,
  xdgConfigEnvPath,
  type ProductHomeLayout,
} from './home.js'
import { appendProductLog } from './log.js'
import {
  acquireRuntimeLease,
  inspectRuntimeLease,
  readRuntimeIdentity,
  removeLeaseIfRunId,
  runtimeStopUrl,
  type RuntimeIdentity,
} from './runtime-lease.js'
import { AssistantControlSurface } from '../ui/controller.js'
import { attachWebUiBroadcast, startWebUiServer } from './web-ui-server.js'

export interface ProductCliOptions {
  readonly command: string
  readonly rest: readonly string[]
  readonly home?: string
  readonly once: boolean
  readonly allowFixtures?: boolean
  readonly help: boolean
}

function usage(): string {
  return `${PRODUCT_COMMAND} <command>
  start [--once] [--home <dir>] [--allow-fixtures]
  status [--home <dir>]
  doctor [--home <dir>] [--allow-fixtures]
  stop [--home <dir>]
  self-extension <subcommand>

TARS-NG home defaults to $TARS_NG_HOME, then $DSH_ASSISTANT_HOME, then ~/.local/share/tars-ng.
A TARS-NG Home has at most one verified writer. A PID is liveness metadata, not process identity.
Secrets belong in $TARS_NG_HOME/config/env or ~/.config/tars-ng/env (chmod 600).
start prints a loopback Web UI URL (default http://127.0.0.1:8787).
stop authenticates against the live lease holder and does not signal an unverified PID.`
}

export function parseProductArgv(argv: readonly string[]): ProductCliOptions {
  const rest: string[] = []
  let command = ''
  let home: string | undefined
  let once = false
  let allowFixtures: boolean | undefined
  let help = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (arg === '--once') {
      once = true
      continue
    }
    if (arg === '--allow-fixtures') {
      allowFixtures = true
      continue
    }
    if (arg === '--home') {
      home = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--home=')) {
      home = arg.slice('--home='.length)
      continue
    }
    if (command === '') {
      command = arg
      continue
    }
    rest.push(arg)
  }
  return { command: command || 'help', rest, home, once, allowFixtures, help }
}

function resolveAllowFixtures(cli: boolean | undefined, fileValue: boolean): boolean {
  if (cli === true) return true
  if (process.env.TARS_NG_ALLOW_FIXTURES === '1' || process.env.TARS_NG_ALLOW_FIXTURES === 'true') return true
  return fileValue
}

function loadEnvFiles(layout: ProductHomeLayout): EnvFileLoad[] {
  return [inspectEnvFile(xdgConfigEnvPath()), inspectEnvFile(layout.envFile)]
}

function writePidFile(layout: ProductHomeLayout): void {
  writeFileSync(layout.pidFile, `${process.pid}\n`, { mode: 0o600 })
}

function removePidFile(layout: ProductHomeLayout): void {
  try {
    unlinkSync(layout.pidFile)
  } catch {
    // pid file may already be gone
  }
}

async function requestAuthenticatedStop(identity: RuntimeIdentity): Promise<'stopped' | 'mismatch' | 'unreachable'> {
  if (identity.controlEndpoint === undefined) return 'unreachable'
  try {
    const response = await fetch(runtimeStopUrl(identity.controlEndpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: identity.runId }),
      signal: AbortSignal.timeout(2000),
    })
    if (response.status === 200) return 'stopped'
    if (response.status === 403) return 'mismatch'
    return 'unreachable'
  } catch {
    return 'unreachable'
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntilDead(pid: number, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true
    await delay(50)
  }
  return !processAlive(pid)
}

async function bootProduct(layout: ProductHomeLayout, allowFixtures: boolean) {
  return bootAssistantControl({
    home: layout.root,
    allowFixtures,
    memory: { persistence: 'json-file', jsonFilePath: layout.memoryFile },
  })
}

async function operatorFromBoot(booted: Awaited<ReturnType<typeof bootAssistantControl>>) {
  const { ctx, recoveryRoot, diagnostics } = booted
  const approvals = new Map(ctx.candidateWorkspace.list().map((item) => [
    item.id,
    ctx.extensionGovernance.inspectApproval(item.id)?.decision ?? 'unreviewed',
  ]))
  const fingerprints = new Map(ctx.candidateWorkspace.list().flatMap((item) => {
    const fingerprint = ctx.extensionGovernance.inspectApproval(item.id)?.fingerprint
    return fingerprint === undefined ? [] : [[item.id, fingerprint] as const]
  }))
  return operatorStatus({
    activation: recoveryRoot.inspect(),
    registry: [...ctx.capabilityRegistry.list()],
    candidates: [...ctx.candidateWorkspace.list()],
    approvals,
    fingerprints,
    persistence: diagnostics.persistence,
    reasons: diagnostics.reasons,
  })
}

function webUiFromLast(last: unknown): string | undefined {
  if (last !== null && typeof last === 'object' && 'webUi' in last) {
    const url = (last as { webUi?: unknown }).webUi
    return typeof url === 'string' ? url : undefined
  }
  return undefined
}

function firstRunText(layout: ProductHomeLayout, allowFixtures: boolean): string {
  return [
    `${PRODUCT_NAME} first run`,
    `Home: ${layout.root} (reinstalling package code does not delete this directory)`,
    'Required: Node >=22; DSH 0.1.0-rc.8 arrives via npm, not a DSH clone.',
    'Required for AI: DEEPSEEK_API_KEY (deepseek-official / deepseek-v4-flash). Product start is not a usable AI runtime until this key is present.',
    'Open the local Web UI URL printed by tars-ng start (loopback only).',
    'Optional: Google Calendar live token (DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN) and MODE=live.',
    'Optional: GOOGLE_SEARCH_API_KEY / GOOGLE_SEARCH_ENGINE_ID are diagnosed but Search is not shipped.',
    allowFixtures
      ? 'Fixture integrations are enabled; their results are not live user data.'
      : 'Core integrations stay unavailable until configured; fixture calendar is not presented as live data.',
    'Corrupt authority or unsupported durable schema fails closed into Safe Mode.',
    `Logs: ${layout.logFile}`,
    'Stop: Ctrl-C, or tars-ng stop (authenticated against this Home lease). Reset: delete the home directory (not the default uninstall path).',
  ].join('\n')
}

export async function runProductCli(argv: readonly string[], io: { log: (text: string) => void; error: (text: string) => void } = console): Promise<number> {
  const parsed = parseProductArgv(argv)
  if (parsed.help || parsed.command === 'help' || parsed.command === '') {
    io.log(usage())
    return 0
  }

  const layout = ensureProductHome(resolveProductHome(parsed.home))
  process.env.TARS_NG_HOME = layout.root
  if (parsed.command === 'self-extension') {
    const code = await runSelfExtensionCli([...parsed.rest])
    return code
  }
  const envFiles = loadEnvFiles(layout)
  const userConfig = readProductUserConfig(layout)
  const allowFixtures = resolveAllowFixtures(parsed.allowFixtures, userConfig.config.allowFixtures)
  const compatibility = inspectCompatibility()
  if (!compatibility.ok && (parsed.command === 'start' || parsed.command === 'doctor')) {
    io.error(compatibility.problems.join('\n'))
    if (parsed.command === 'start') return 1
  }

  if (parsed.command === 'stop') {
    const identity = readRuntimeIdentity(layout)
    const inspected = await inspectRuntimeLease(layout)
    if (inspected.state === 'empty' || inspected.state === 'stale' || identity === undefined || !processAlive(identity.pid)) {
      if (identity !== undefined) removeLeaseIfRunId(layout, identity.runId)
      removePidFile(layout)
      io.log('TARS-NG is not running.')
      return 0
    }
    if (inspected.state === 'ambiguous') {
      io.error(`home-ambiguous: ${inspected.detail}`)
      return 1
    }
    const requested = await requestAuthenticatedStop(identity)
    if (requested === 'mismatch' || requested === 'unreachable') {
      io.error(`identity-mismatch: refusing to signal pid ${identity.pid}. A PID is liveness metadata, not process identity.`)
      return 1
    }
    try {
      process.kill(identity.pid, 'SIGTERM')
    } catch {
      // process may already be exiting after the authenticated stop
    }
    await waitUntilDead(identity.pid, 1_500)
    if (!processAlive(identity.pid)) {
      removeLeaseIfRunId(layout, identity.runId)
      removePidFile(layout)
    }
    io.log(`stopped the verified runtime (pid ${identity.pid})`)
    return 0
  }

  if (parsed.command === 'status') {
    const inspected = await inspectRuntimeLease(layout)
    const running = inspected.state === 'held'
    const last = readLastStatus(layout)
    const webUi = running ? (inspected.identity.controlEndpoint ?? webUiFromLast(last)) : undefined
    io.log([
      `${PRODUCT_NAME} ${compatibility.productVersion}`,
      `running: ${running ? `yes (pid ${inspected.identity.pid})` : inspected.state === 'ambiguous' ? 'ambiguous' : 'no'}`,
      `home: ${layout.root}`,
      `dsh: ${compatibility.dshSupported}`,
      `node: ${compatibility.nodeVersion}`,
      `llm: ${DEFAULT_LLM_PROVIDER} / ${DEFAULT_LLM_MODEL}`,
      webUi ? `web-ui: ${webUi}` : 'web-ui: not-running',
      last === undefined ? 'last-start: none' : `last-start: recorded`,
      inspected.state === 'ambiguous' ? `lease: ambiguous` : `lease: ${inspected.state}`,
    ].join('\n'))
    return 0
  }

  if (parsed.command === 'doctor' || parsed.command === 'start') {
    const first = !existsSync(layout.lastStatusFile)
    let report = collectStaticDoctor({
      layout,
      envFiles,
      allowFixtures,
      lastStartup: readLastStatus(layout),
    })
    if (parsed.command === 'doctor') {
      const inspected = await inspectRuntimeLease(layout)
      if (inspected.state === 'held') {
        io.log(`${formatDoctorReport(report)}\nhome-owner: verified runtime pid ${inspected.identity.pid} (doctor stayed read-only)`)
        return compatibility.ok ? 0 : 1
      }
      if (inspected.state === 'ambiguous') {
        io.error(`home-ambiguous: ${inspected.detail}`)
        return 1
      }
    }
    const lease = await acquireRuntimeLease(layout)
    if (!lease.ok) {
      io.error(`${lease.error}: ${lease.detail}`)
      return 1
    }
    const hold = lease.hold
    const booted = await bootProduct(layout, allowFixtures)
    try {
      const operator = await operatorFromBoot(booted)
      const llm = await inspectLlmRuntime(booted.ctx)
      report = attachRuntimeDoctor(report, {
        persistence: booted.diagnostics.persistence,
        safeMode: booted.diagnostics.safeMode,
        recoveryRequired: booted.diagnostics.recoveryRequired,
        operator,
        llm,
      })
      const snapshot = {
        productVersion: report.productVersion,
        home: layout.root,
        safeMode: report.safeMode,
        persistence: report.persistence,
        allowFixtures,
        missingConfiguration: report.missingConfiguration,
        calendar: report.integrations.find((item) => item.capability === 'calendar')?.mode,
        llm: { provider: llm.provider, model: llm.model, routeAvailable: llm.routeAvailable, usable: llm.usable },
      }
      writeLastStatus(layout, snapshot)
      appendProductLog(layout.logFile, `lifecycle ${parsed.command} persistence=${report.persistence} safeMode=${report.safeMode} llm=${llm.state}`)
      if (parsed.command === 'doctor') {
        io.log(formatDoctorReport(report))
        return compatibility.ok ? 0 : 1
      }
      if (first) io.log(firstRunText(layout, allowFixtures))
      io.log(formatDoctorReport(report))
      if (!llm.usable) {
        io.error(formatUnusableLlmError(llm))
        appendProductLog(layout.logFile, 'lifecycle start failed LLM not configured/unavailable')
        return 1
      }
      if (parsed.once) return compatibility.ok ? 0 : 1
      const handle = await createAssistantAgent(booted.ctx, PRODUCT_UI_SESSION_ID)
      const surface = new AssistantControlSurface(booted.ctx, PRODUCT_UI_SESSION_ID)
      let requestStop = () => {}
      const stopped = new Promise<void>((resolve) => {
        requestStop = resolve
        process.once('SIGINT', resolve)
        process.once('SIGTERM', resolve)
      })
      let detach = () => {}
      let web
      try {
        web = await startWebUiServer({
          surface,
          recoveryRoot: booted.recoveryRoot,
          diagnostics: { persistence: booted.diagnostics.persistence, reasons: booted.diagnostics.reasons },
          runtimeControl: {
            pid: hold.identity.pid,
            startedAt: hold.identity.startedAt,
            productVersion: hold.identity.productVersion,
            runId: hold.identity.runId,
            onStop: () => requestStop(),
          },
        })
      } catch (error) {
        await handle.dispose()
        const message = error instanceof Error ? error.message : 'Web UI failed to bind'
        io.error(message)
        appendProductLog(layout.logFile, `lifecycle start failed web-ui ${message}`)
        return 1
      }
      detach = attachWebUiBroadcast(booted.ctx, () => web.notify())
      hold.publishControlEndpoint(web.url)
      writeLastStatus(layout, { ...snapshot, webUi: web.url })
      writePidFile(layout)
      io.log(`TARS-NG is running.\nWeb UI: ${web.url}\nHome: ${layout.root}`)
      try {
        await stopped
      } finally {
        detach()
        await Promise.race([web.close(), delay(500)]).catch(() => undefined)
        await Promise.race([handle.dispose(), delay(2_000)]).catch(() => undefined)
      }
      removePidFile(layout)
      appendProductLog(layout.logFile, 'lifecycle stop')
      return 0
    } finally {
      await booted.ctx.fiber.dispose()
      hold.release()
      removePidFile(layout)
    }
  }

  io.error(usage())
  return 1
}
