import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { operatorStatus } from '../domain/self-extension/status.js'
import { runSelfExtensionCli } from '../runtime/self-extension-cli.js'
import { bootAssistantControl, createAssistantAgent, type AssistantControl } from '../runtime/boot.js'
import { inspectCompatibility } from './compatibility.js'
import { DEFAULT_LLM_MODEL, DEFAULT_LLM_PROVIDER, PRODUCT_COMMAND, PRODUCT_NAME } from './constants.js'
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
  isLoopbackControlEndpoint,
  readRuntimeIdentity,
  removeLeaseIfRunId,
  runIdEquals,
  runtimeStopUrl,
  type RuntimeIdentity,
} from './runtime-lease.js'
import { AssistantControlSurface } from '../ui/controller.js'
import { assertAssistantAdapterContract, assertRecoveryAdapterContract, assertSelectedProfile } from './profile-composition.js'
import {
  claimSessionPartition,
  commitRuntimeContext,
  completeProfileIdentityMigration,
  discardEphemeralRecoverySessions,
  inspectRuntimeContext,
  recoverySessionsDir,
  rollbackSessionRootOwner,
  RUNTIME_CONTEXT_SCHEMA_VERSION,
  sessionPersistenceDirOf,
  writeProductRuntimeSection,
  type RuntimeContext,
  type SessionPartitionHold,
} from './runtime-context.js'
import { catalogBindingOf, inspectSessionCatalog, inspectSessionJournal, SessionCatalog, SessionCatalogError, type CatalogJournal } from './session-catalog.js'
import { LiveSessionHost } from './session-lifecycle.js'
import { attachWebUiBroadcast, startWebUiServer, type WebUiServer } from './web-ui-server.js'

export interface ProductCliOptions {
  readonly command: string
  readonly rest: readonly string[]
  readonly home?: string
  readonly once: boolean
  readonly allowFixtures?: boolean
  readonly profile?: string
  readonly workspace?: string
  readonly sessionRoot?: string
  readonly sessionId?: string
  readonly help: boolean
}

function usage(): string {
  return `${PRODUCT_COMMAND} <command>
  start [--once] [--home <dir>] [--allow-fixtures] [--profile <name>] [--workspace <dir>] [--session-root <dir>] [--session-id <id>]
  status [--home <dir>]
  doctor [--home <dir>] [--allow-fixtures] [--profile <name>] [--workspace <dir>] [--session-root <dir>] [--session-id <id>]
  stop [--home <dir>]
  self-extension <subcommand>
    import-local <directory>   trusted operator only; no model or browser path
  skill <subcommand>
    import-local <directory>   trusted operator only; inactive third-party Skill candidate
    approve <id> <fingerprint> | activate <id> | disable <name> | uninstall <name> | rollback

TARS-NG home defaults to $TARS_NG_HOME, then $DSH_ASSISTANT_HOME, then ~/.local/share/tars-ng.
Runtime context precedence: CLI → environment → $TARS_NG_HOME/config/product.json → defaults (profile=assistant, workspace=$HOME/workspace, sessions=$HOME/sessions, session-id=main).
A TARS-NG Home has at most one verified writer. A PID is liveness metadata, not process identity.
Secrets belong in $TARS_NG_HOME/config/env or ~/.config/tars-ng/env (chmod 600).
start prints a loopback Web UI URL (default http://127.0.0.1:8787).
stop authenticates against the live lease holder and does not signal a PID.`
}

export interface ProductCliHooks {
  readonly bootProduct?: (layout: ProductHomeLayout, allowFixtures: boolean) => Promise<AssistantControl>
  readonly stopConfirmTimeoutMs?: number
  readonly afterWebUiBound?: (web: WebUiServer) => void | Promise<void>
  readonly flushSession?: () => Promise<boolean>
}

function takeValue(argv: readonly string[], index: number, flag: string): { readonly value: string; readonly next: number } {
  const inline = argv[index]?.startsWith(`${flag}=`) === true ? argv[index]!.slice(`${flag}=`.length) : undefined
  if (inline !== undefined) {
    if (inline === '') throw new Error(`missing ${flag} value`)
    return { value: inline, next: index }
  }
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('-')) throw new Error(`missing ${flag} value`)
  return { value, next: index + 1 }
}

export function parseProductArgv(argv: readonly string[]): ProductCliOptions {
  const rest: string[] = []
  let command = ''
  let home: string | undefined
  let once = false
  let allowFixtures: boolean | undefined
  let profile: string | undefined
  let workspace: string | undefined
  let sessionRoot: string | undefined
  let sessionId: string | undefined
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
    if (arg === '--home' || arg.startsWith('--home=')) {
      const taken = takeValue(argv, i, '--home')
      home = taken.value
      i = taken.next
      continue
    }
    if (arg === '--profile' || arg.startsWith('--profile=')) {
      const taken = takeValue(argv, i, '--profile')
      profile = taken.value
      i = taken.next
      continue
    }
    if (arg === '--workspace' || arg.startsWith('--workspace=')) {
      const taken = takeValue(argv, i, '--workspace')
      workspace = taken.value
      i = taken.next
      continue
    }
    if (arg === '--session-root' || arg.startsWith('--session-root=')) {
      const taken = takeValue(argv, i, '--session-root')
      sessionRoot = taken.value
      i = taken.next
      continue
    }
    if (arg === '--session-id' || arg.startsWith('--session-id=')) {
      const taken = takeValue(argv, i, '--session-id')
      sessionId = taken.value
      i = taken.next
      continue
    }
    if (arg.startsWith('--') && command !== 'self-extension' && command !== 'skill') {
      throw new Error(`unknown option ${arg}`)
    }
    if (command === '') {
      command = arg
      continue
    }
    rest.push(arg)
  }
  return {
    command: command || 'help',
    rest,
    home,
    once,
    allowFixtures,
    profile,
    workspace,
    sessionRoot,
    sessionId,
    help,
  }
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

function removeOwnPidFile(layout: ProductHomeLayout): void {
  try {
    unlinkSync(layout.pidFile)
  } catch {
    // pid file may already be gone
  }
}

async function requestAuthenticatedStop(identity: RuntimeIdentity): Promise<'accepted' | 'mismatch' | 'unreachable'> {
  if (identity.controlEndpoint === undefined || !isLoopbackControlEndpoint(identity.controlEndpoint)) return 'unreachable'
  try {
    const response = await fetch(runtimeStopUrl(identity.controlEndpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: identity.runId }),
      signal: AbortSignal.timeout(2000),
    })
    if (response.status === 200) return 'accepted'
    if (response.status === 403) return 'mismatch'
    return 'unreachable'
  } catch {
    return 'unreachable'
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntilStopConfirmed(layout: ProductHomeLayout, identity: RuntimeIdentity, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const current = readRuntimeIdentity(layout)
    if (!current || !runIdEquals(current.runId, identity.runId)) return true
    const inspected = await inspectRuntimeLease(layout)
    if (inspected.state === 'empty' || inspected.state === 'stale') return true
    await delay(50)
  }
  const current = readRuntimeIdentity(layout)
  return current === undefined || !runIdEquals(current.runId, identity.runId) || !processAlive(current.pid)
}

async function defaultBootProduct(layout: ProductHomeLayout, allowFixtures: boolean, context?: RuntimeContext, persistSessions = false) {
  return bootAssistantControl({
    home: layout.root,
    allowFixtures,
    memory: { persistence: 'json-file', jsonFilePath: layout.memoryFile },
    sessionRoot: persistSessions ? context?.sessionPersistenceDir : undefined,
    sessionId: context?.sessionId.value,
    workspace: context?.workspace.value,
    safeMode: context?.safeMode,
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
    skills: ctx.get('skillLifecycle')?.health(),
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

export async function runProductCli(
  argv: readonly string[],
  io: { log: (text: string) => void; error: (text: string) => void } = console,
  hooks: ProductCliHooks = {},
): Promise<number> {
  let parsed: ProductCliOptions
  try {
    parsed = parseProductArgv(argv)
  } catch (error) {
    io.error(error instanceof Error ? error.message : 'invalid arguments')
    return 1
  }
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
  if (parsed.command === 'skill') {
    const { runSkillCli } = await import('../runtime/skill-cli-import.js')
    return runSkillCli([...parsed.rest], parsed.home)
  }
  const envFiles = loadEnvFiles(layout)
  const userConfig = readProductUserConfig(layout)
  const allowFixtures = resolveAllowFixtures(parsed.allowFixtures, userConfig.config.allowFixtures)
  let runtimeContext: RuntimeContext | undefined
  if (parsed.command === 'start' || parsed.command === 'doctor' || parsed.command === 'status') {
    try {
      runtimeContext = inspectRuntimeContext(layout, {
        profile: parsed.profile,
        workspace: parsed.workspace,
        sessionRoot: parsed.sessionRoot,
        sessionId: parsed.sessionId,
      }, userConfig.config.runtime)
    } catch (error) {
      io.error(error instanceof Error ? error.message : 'runtime context failed')
      return 1
    }
  }
  const compatibility = inspectCompatibility()
  if (!compatibility.ok && (parsed.command === 'start' || parsed.command === 'doctor')) {
    io.error(compatibility.problems.join('\n'))
    if (parsed.command === 'start') return 1
  }

  if (parsed.command === 'stop') {
    const inspected = await inspectRuntimeLease(layout)
    if (inspected.state === 'ambiguous') {
      io.error(`home-ambiguous: ${inspected.detail}`)
      return 1
    }
    const identity = readRuntimeIdentity(layout)
    if (inspected.state === 'empty' || inspected.state === 'stale' || identity === undefined) {
      if (identity !== undefined) removeLeaseIfRunId(layout, identity.runId)
      io.log('TARS-NG is not running.')
      return 0
    }
    const requested = await requestAuthenticatedStop(identity)
    if (requested === 'mismatch' || requested === 'unreachable') {
      io.error(`identity-mismatch: refusing unverified stop for pid ${identity.pid}. A PID is liveness metadata, not process identity.`)
      return 1
    }
    const confirmed = await waitUntilStopConfirmed(layout, identity, hooks.stopConfirmTimeoutMs ?? 15_000)
    if (!confirmed) {
      io.error('stop requested but not confirmed')
      return 1
    }
    const leftover = readRuntimeIdentity(layout)
    if (leftover !== undefined && runIdEquals(leftover.runId, identity.runId) && !processAlive(leftover.pid)) {
      removeLeaseIfRunId(layout, leftover.runId)
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
      runtimeContext ? `profile: ${runtimeContext.profile.value} (${runtimeContext.profile.source})` : 'profile: unresolved',
      runtimeContext ? `profile-identity: ${runtimeContext.profileIdentity}` : 'profile-identity: unresolved',
      runtimeContext ? `workspace: ${runtimeContext.workspaceLabel} (${runtimeContext.workspace.source})` : 'workspace: unresolved',
      runtimeContext ? `session: ${runtimeContext.sessionId.value} (${runtimeContext.sessionId.source})` : 'session: unresolved',
      catalogStatusLine(runtimeContext),
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
      runtimeContext,
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
    const lease = await acquireRuntimeLease(layout, runtimeContext ? {
      profile: runtimeContext.profile.value,
      profileIdentity: runtimeContext.profileIdentity,
      workspaceIdentity: runtimeContext.workspaceIdentity,
      sessionRootIdentity: runtimeContext.sessionRootIdentity,
      sessionId: runtimeContext.sessionId.value,
    } : undefined)
    if (!lease.ok) {
      io.error(`${lease.error}: ${lease.detail}`)
      return 1
    }
    const hold = lease.hold
    let partition: SessionPartitionHold | undefined
    if (parsed.command === 'start' && runtimeContext) {
      try {
        assertSelectedProfile(runtimeContext.profile.value)
        if (runtimeContext.profileCompositionError !== undefined) {
          assertRecoveryAdapterContract()
        } else {
          try {
            assertAssistantAdapterContract()
          } catch (error) {
            runtimeContext = {
              ...runtimeContext,
              safeMode: true,
              profileCompositionError: error instanceof Error ? error.message : 'normal Profile composition failed',
            }
            assertRecoveryAdapterContract()
          }
        }
        if (!runtimeContext.bound && runtimeContext.profileCompositionError !== undefined) {
          runtimeContext = {
            ...runtimeContext,
            ephemeralRecovery: true,
            sessionPersistenceDir: recoverySessionsDir(layout),
          }
        }
        if (runtimeContext.bound && runtimeContext.profileCompositionError === undefined) {
          runtimeContext = completeProfileIdentityMigration(layout, runtimeContext, { allowFixtures })
          if (!hold.refreshContextStamp({
            profile: runtimeContext.profile.value,
            profileIdentity: runtimeContext.profileIdentity,
            workspaceIdentity: runtimeContext.workspaceIdentity,
            sessionRootIdentity: runtimeContext.sessionRootIdentity,
            sessionId: runtimeContext.sessionId.value,
          })) {
            throw new Error('failed to refresh Home lease identity after Profile migration')
          }
        }
        partition = claimSessionPartition(runtimeContext)
        if (!runtimeContext.bound && runtimeContext.profileCompositionError === undefined) {
          runtimeContext = commitRuntimeContext(layout, runtimeContext, { allowFixtures })
        }
      } catch (error) {
        if (partition?.createdOwner) rollbackSessionRootOwner(runtimeContext)
        partition?.release()
        if (runtimeContext.ephemeralRecovery) discardEphemeralRecoverySessions(layout)
        hold.release()
        io.error(error instanceof Error ? error.message : 'runtime context commit failed')
        return 1
      }
    }
    const boot = hooks.bootProduct ?? ((homeLayout, fixtures) => defaultBootProduct(homeLayout, fixtures, runtimeContext, parsed.command === 'start'))
    let booted: AssistantControl | undefined
    let handle: Awaited<ReturnType<typeof createAssistantAgent>> | undefined
    let sessionHost: LiveSessionHost | undefined
    let web: WebUiServer | undefined
    let detach = () => {}
    let writerStillActive = false
    const shutdownWriter = async (): Promise<boolean> => {
      try {
        detach()
        detach = () => {}
        if (web !== undefined) {
          await web.close()
          web = undefined
        }
        const live = sessionHost?.currentHandle() ?? handle
        let flushed = live === undefined
        if (live !== undefined) {
          try {
            if (hooks.flushSession) await hooks.flushSession()
            else if (booted !== undefined) await booted.ctx.sessions.flush(live.agent.session as never)
            flushed = true
          } catch {
            flushed = false
          }
          await live.dispose()
          handle = undefined
          sessionHost = undefined
        }
        if (booted !== undefined) {
          await booted.ctx.fiber.dispose()
          booted = undefined
        }
        partition?.release()
        partition = undefined
        if (runtimeContext?.ephemeralRecovery) discardEphemeralRecoverySessions(layout)
        if (!flushed) return false
        writerStillActive = false
        return true
      } catch {
        return false
      }
    }
    try {
      booted = await boot(layout, allowFixtures)
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
        ...(runtimeContext ? {
          profile: runtimeContext.profile.value,
          workspaceIdentity: runtimeContext.workspaceIdentity,
          sessionId: runtimeContext.sessionId.value,
        } : {}),
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
      if (parsed.once) {
        return compatibility.ok ? 0 : 1
      }
      let sessionId = runtimeContext?.sessionId.value ?? 'main'
      let catalog: SessionCatalog | undefined
      let recoveredJournal: CatalogJournal | undefined
      if (runtimeContext) {
        catalog = new SessionCatalog(sessionPersistenceDirOf(runtimeContext), catalogBindingOf(runtimeContext))
        if (!runtimeContext.ephemeralRecovery) {
          const started = catalog.resolveStartSession(sessionId)
          sessionId = started.sessionId
          recoveredJournal = started.journal
        }
      }
      handle = await createAssistantAgent(booted.ctx, sessionId, undefined, runtimeContext?.workspace.value)
      const surface = new AssistantControlSurface(booted.ctx, sessionId, runtimeContext, catalog)
      if (catalog && runtimeContext && handle && !runtimeContext.ephemeralRecovery) {
        const boundContext = runtimeContext
        const persistCurrent = (nextId: string) => writeProductRuntimeSection(layout, allowFixtures, {
          schemaVersion: RUNTIME_CONTEXT_SCHEMA_VERSION,
          profile: boundContext.profile.value,
          workspace: boundContext.workspace.value,
          sessionRoot: boundContext.sessionRoot.value,
          sessionId: nextId,
        })
        if (recoveredJournal) persistCurrent(sessionId)
        sessionHost = new LiveSessionHost(
          booted.ctx,
          surface,
          catalog,
          boundContext.workspace.value,
          persistCurrent,
          handle,
          boundContext.safeMode,
        )
        if (recoveredJournal) await sessionHost.finishCommittedJournal(recoveredJournal)
      }
      let requestStop = () => {}
      const stopped = new Promise<void>((resolve) => {
        requestStop = resolve
        process.once('SIGINT', resolve)
        process.once('SIGTERM', resolve)
      })
      try {
        web = await startWebUiServer({
          surface,
          recoveryRoot: booted.recoveryRoot,
          ...(sessionHost ? { sessionHost } : {}),
          diagnostics: { persistence: booted.diagnostics.persistence, reasons: booted.diagnostics.reasons },
          runtimeControl: {
            pid: hold.identity.pid,
            startedAt: hold.identity.startedAt,
            productVersion: hold.identity.productVersion,
            normalizedHome: hold.identity.normalizedHome,
            runId: hold.identity.runId,
            onStop: () => requestStop(),
          },
        })
      } catch (error) {
        await handle.dispose()
        handle = undefined
        const message = error instanceof Error ? error.message : 'Web UI failed to bind'
        io.error(message)
        appendProductLog(layout.logFile, `lifecycle start failed web-ui ${message}`)
        return 1
      }
      writerStillActive = true
      const bound = web
      detach = attachWebUiBroadcast(booted.ctx, () => bound.notify())
      await hooks.afterWebUiBound?.(bound)
      if (!hold.publishControlEndpoint(bound.url)) {
        throw new Error('failed to publish loopback control endpoint')
      }
      writeLastStatus(layout, { ...snapshot, webUi: bound.url })
      writePidFile(layout)
      io.log(`TARS-NG is running.\nWeb UI: ${bound.url}\nHome: ${layout.root}`)
      await stopped
      if (!await shutdownWriter()) {
        io.error('shutdown failed; retaining Home lease')
        appendProductLog(layout.logFile, 'lifecycle stop incomplete')
        return 1
      }
      removeOwnPidFile(layout)
      appendProductLog(layout.logFile, 'lifecycle stop')
      return 0
    } catch (error) {
      const message = error instanceof Error ? error.message : 'start failed'
      if (writerStillActive) {
        if (await shutdownWriter()) {
          io.error(message)
          appendProductLog(layout.logFile, `lifecycle ${parsed.command} failed ${message}`)
          return 1
        }
        io.error(`shutdown failed; retaining Home lease. ${message}`)
        appendProductLog(layout.logFile, `lifecycle stop incomplete ${message}`)
        return 1
      }
      io.error(message)
      appendProductLog(layout.logFile, `lifecycle ${parsed.command} failed ${message}`)
      return 1
    } finally {
      if (!writerStillActive) {
        if (booted !== undefined) await booted.ctx.fiber.dispose()
        partition?.release()
        if (runtimeContext?.ephemeralRecovery) discardEphemeralRecoverySessions(layout)
        removeOwnPidFile(layout)
        hold.release()
      }
    }
  }

  io.error(usage())
  return 1
}

function catalogStatusLine(runtimeContext: RuntimeContext | undefined): string {
  if (!runtimeContext) return 'session-catalog: unavailable'
  try {
    const binding = catalogBindingOf(runtimeContext)
    const dir = sessionPersistenceDirOf(runtimeContext)
    const catalog = inspectSessionCatalog(dir, binding)
    const journal = inspectSessionJournal(dir, binding)
    const catalogLine = catalog.health === 'absent'
      ? 'session-catalog: absent'
      : `session-catalog: ${catalog.health} (${catalog.activeCount} active, ${catalog.archivedCount} archived)`
    if (!journal) return catalogLine
    return `${catalogLine}\nsession-journal: ${journal.phase} ${journal.op}`
  } catch (error) {
    if (error instanceof SessionCatalogError) return `session-catalog: recovery-required (${error.code})`
    return 'session-catalog: recovery-required'
  }
}
