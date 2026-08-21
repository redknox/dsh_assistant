import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { operatorStatus } from '../domain/self-extension/status.js'
import { runSelfExtensionCli } from '../runtime/self-extension-cli.js'
import { bootAssistantControl } from '../runtime/boot.js'
import { inspectCompatibility } from './compatibility.js'
import { PRODUCT_COMMAND, PRODUCT_NAME } from './constants.js'
import { attachRuntimeDoctor, collectStaticDoctor, formatDoctorReport } from './doctor.js'
import { inspectEnvFile, type EnvFileLoad } from './env.js'
import {
  ensureProductHome,
  readLastStatus,
  readProductUserConfig,
  resolveProductHome,
  writeLastStatus,
  xdgConfigEnvPath,
  type ProductHomeLayout,
} from './home.js'
import { appendProductLog } from './log.js'

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
Secrets belong in $TARS_NG_HOME/config/env or ~/.config/tars-ng/env (chmod 600).`
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

function readPid(layout: ProductHomeLayout): number | undefined {
  if (!existsSync(layout.pidFile)) return undefined
  const raw = Number.parseInt(readFileSync(layout.pidFile, 'utf8').trim(), 10)
  return Number.isInteger(raw) ? raw : undefined
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
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

function firstRunText(layout: ProductHomeLayout, allowFixtures: boolean): string {
  return [
    `${PRODUCT_NAME} first run`,
    `Home: ${layout.root} (reinstalling package code does not delete this directory)`,
    'Required: Node >=22; DSH 0.1.0-rc.8 arrives via npm, not a DSH clone.',
    'Optional: Google Calendar live token (DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN) and MODE=live.',
    'Optional: GOOGLE_SEARCH_API_KEY / GOOGLE_SEARCH_ENGINE_ID are diagnosed but Search is not shipped.',
    allowFixtures
      ? 'Fixture integrations are enabled; their results are not live user data.'
      : 'Core integrations stay unavailable until configured; fixture calendar is not presented as live data.',
    'Corrupt authority or unsupported durable schema fails closed into Safe Mode.',
    `Logs: ${layout.logFile}`,
    'Stop: Ctrl-C, or tars-ng stop. Reset: delete the home directory (not the default uninstall path).',
  ].join('\n')
}

export async function runProductCli(argv: readonly string[], io: { log: (text: string) => void; error: (text: string) => void } = console): Promise<number> {
  const parsed = parseProductArgv(argv)
  if (parsed.help || parsed.command === 'help' || parsed.command === '') {
    io.log(usage())
    return 0
  }

  const home = resolveProductHome(parsed.home)
  process.env.TARS_NG_HOME = home
  if (parsed.command === 'self-extension') {
    await runSelfExtensionCli([...parsed.rest])
    return 0
  }
  const layout = ensureProductHome(home)
  const envFiles = loadEnvFiles(layout)
  const userConfig = readProductUserConfig(layout)
  const allowFixtures = resolveAllowFixtures(parsed.allowFixtures, userConfig.config.allowFixtures)
  const compatibility = inspectCompatibility()
  if (!compatibility.ok && (parsed.command === 'start' || parsed.command === 'doctor')) {
    io.error(compatibility.problems.join('\n'))
    if (parsed.command === 'start') return 1
  }

  if (parsed.command === 'stop') {
    const pid = readPid(layout)
    if (pid === undefined || !processAlive(pid)) {
      io.log('TARS-NG is not running.')
      return 0
    }
    process.kill(pid, 'SIGTERM')
    io.log(`sent SIGTERM to ${pid}`)
    return 0
  }

  if (parsed.command === 'status') {
    const pid = readPid(layout)
    const running = pid !== undefined && processAlive(pid)
    const last = readLastStatus(layout)
    io.log([
      `${PRODUCT_NAME} ${compatibility.productVersion}`,
      `running: ${running ? `yes (pid ${pid})` : 'no'}`,
      `home: ${layout.root}`,
      `dsh: ${compatibility.dshSupported}`,
      `node: ${compatibility.nodeVersion}`,
      last === undefined ? 'last-start: none' : `last-start: recorded`,
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
    const booted = await bootProduct(layout, allowFixtures)
    try {
      const operator = await operatorFromBoot(booted)
      report = attachRuntimeDoctor(report, {
        persistence: booted.diagnostics.persistence,
        safeMode: booted.diagnostics.safeMode,
        recoveryRequired: booted.diagnostics.recoveryRequired,
        operator,
      })
      const snapshot = {
        productVersion: report.productVersion,
        home: layout.root,
        safeMode: report.safeMode,
        persistence: report.persistence,
        allowFixtures,
        missingConfiguration: report.missingConfiguration,
        calendar: report.integrations.find((item) => item.capability === 'calendar')?.mode,
      }
      writeLastStatus(layout, snapshot)
      appendProductLog(layout.logFile, `lifecycle ${parsed.command} persistence=${report.persistence} safeMode=${report.safeMode}`)
      if (parsed.command === 'doctor') {
        io.log(formatDoctorReport(report))
        return compatibility.ok ? 0 : 1
      }
      if (first) io.log(firstRunText(layout, allowFixtures))
      io.log(formatDoctorReport(report))
      if (parsed.once) return compatibility.ok ? 0 : 1
      writeFileSync(layout.pidFile, `${process.pid}\n`, { mode: 0o600 })
      io.log(`TARS-NG is running. Home ${layout.root}. Ctrl-C to stop.`)
      await new Promise<void>((resolve) => {
        const stop = () => resolve()
        process.once('SIGINT', stop)
        process.once('SIGTERM', stop)
      })
      try {
        unlinkSync(layout.pidFile)
      } catch {
        // pid file may already be gone
      }
      appendProductLog(layout.logFile, 'lifecycle stop')
      return 0
    } finally {
      await booted.ctx.fiber.dispose()
    }
  }

  io.error(usage())
  return 1
}
