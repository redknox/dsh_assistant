import { existsSync } from 'node:fs'
import { inspectSandboxRoot } from '../domain/files/sandbox-root.js'
import { generatedRuntimeDiagnosis, type GeneratedRuntimeDiagnosis } from '../domain/generated-runtime/index.js'
import type { OperatorStatus } from '../domain/self-extension/status.js'
import { inspectCompatibility, type CompatibilityReport } from './compatibility.js'
import { PRODUCT_NAME } from './constants.js'
import { credentialInventory, missingCredentialNames, type CredentialPresence, type EnvFileLoad } from './env.js'
import type { ProductHomeLayout } from './home.js'
import { publicRuntimeContextView, sessionPersistenceDirOf, type RuntimeContext } from './runtime-context.js'
import { catalogBindingOf, inspectSessionCatalog, inspectSessionJournal, SessionCatalogError } from './session-catalog.js'
import type { LlmDiagnosis } from './llm.js'

export type IntegrationMode = 'live' | 'fake' | 'unavailable' | 'disabled'

export interface IntegrationDiagnosis {
  readonly capability: string
  readonly mode: IntegrationMode
  readonly missing?: readonly string[]
  readonly note: string
}

export interface DoctorReport {
  readonly product: string
  readonly productVersion: string
  readonly compatibility: CompatibilityReport
  readonly home: string
  readonly homeExists: boolean
  readonly envFiles: readonly EnvFileLoad[]
  readonly credentials: readonly CredentialPresence[]
  readonly missingConfiguration: readonly string[]
  readonly allowFixtures: boolean
  readonly integrations: readonly IntegrationDiagnosis[]
  readonly persistence?: string
  readonly safeMode?: boolean
  readonly recoveryRequired?: boolean
  readonly operator?: OperatorStatus
  readonly lastStartup?: unknown
  readonly logFile: string
  readonly llm?: LlmDiagnosis
  readonly generatedRuntime?: GeneratedRuntimeDiagnosis
  readonly runtimeContext?: RuntimeContext
}

export function calendarDiagnosis(allowFixtures: boolean): IntegrationDiagnosis {
  const mode = process.env.DSH_ASSISTANT_GOOGLE_CALENDAR_MODE
  const tokenPresent = Boolean(process.env.DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN)
  if (mode === 'live') {
    return {
      capability: 'calendar',
      mode: tokenPresent ? 'live' : 'unavailable',
      missing: tokenPresent ? [] : ['DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN'],
      note: tokenPresent
        ? 'Live Google Calendar v3. Access tokens expire; replace DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN when 401/unavailable.'
        : 'Live mode selected but DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN is missing.',
    }
  }
  if (allowFixtures) {
    return {
      capability: 'calendar',
      mode: 'fake',
      note: 'Fixture calendar is explicit. Results are not live user data.',
    }
  }
  return {
    capability: 'calendar',
    mode: 'unavailable',
    missing: ['DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN'],
    note: 'Not configured. Set DSH_ASSISTANT_GOOGLE_CALENDAR_MODE=live and inject the access token, or enable a generated Google Calendar provider after human approval.',
  }
}

export function searchDiagnosis(): IntegrationDiagnosis {
  const missing = ['GOOGLE_SEARCH_API_KEY', 'GOOGLE_SEARCH_ENGINE_ID'].filter((name) => !process.env[name])
  return {
    capability: 'search',
    mode: 'unavailable',
    missing,
    note: 'Google Search is not a shipped TARS-NG capability. Credentials are diagnosed by name only so soak config is visible; they are not used.',
  }
}

export function sandboxDiagnosis(allowFixtures: boolean): IntegrationDiagnosis {
  const inspected = inspectSandboxRoot(process.env.DSH_ASSISTANT_SANDBOX_ROOT)
  if (inspected.configured && inspected.ok) {
    return {
      capability: 'sandbox',
      mode: 'live',
      note: 'Confined files and tasks are live. Writes use existing policy; deletes stay L4.',
    }
  }
  if (inspected.configured) {
    return {
      capability: 'sandbox',
      mode: 'unavailable',
      note: inspected.reason,
    }
  }
  if (allowFixtures) {
    return {
      capability: 'sandbox',
      mode: 'fake',
      note: 'Fixture files/tasks are explicit. Results are not the operator sandbox.',
    }
  }
  return {
    capability: 'sandbox',
    mode: 'unavailable',
    missing: ['DSH_ASSISTANT_SANDBOX_ROOT'],
    note: 'Not configured. Set DSH_ASSISTANT_SANDBOX_ROOT to an existing directory that is not a symlink.',
  }
}

export function collectStaticDoctor(input: {
  readonly layout: ProductHomeLayout
  readonly envFiles: readonly EnvFileLoad[]
  readonly allowFixtures: boolean
  readonly lastStartup?: unknown
  readonly runtimeContext?: RuntimeContext
}): DoctorReport {
  const compatibility = inspectCompatibility()
  const credentials = credentialInventory()
  return {
    product: PRODUCT_NAME,
    productVersion: compatibility.productVersion,
    compatibility,
    home: input.layout.root,
    homeExists: existsSync(input.layout.root),
    envFiles: input.envFiles,
    credentials,
    missingConfiguration: missingCredentialNames(credentials),
    allowFixtures: input.allowFixtures,
    integrations: [calendarDiagnosis(input.allowFixtures), sandboxDiagnosis(input.allowFixtures), searchDiagnosis()],
    lastStartup: input.lastStartup,
    logFile: input.layout.logFile,
    generatedRuntime: generatedRuntimeDiagnosis(),
    ...(input.runtimeContext ? { runtimeContext: input.runtimeContext } : {}),
  }
}

export function attachRuntimeDoctor(report: DoctorReport, input: {
  readonly persistence: string
  readonly safeMode: boolean
  readonly recoveryRequired: boolean
  readonly operator: OperatorStatus
  readonly llm?: LlmDiagnosis
}): DoctorReport {
  return {
    ...report,
    persistence: input.persistence,
    safeMode: input.safeMode,
    recoveryRequired: input.recoveryRequired,
    operator: input.operator,
    llm: input.llm,
    generatedRuntime: generatedRuntimeDiagnosis(),
  }
}

export function formatDoctorReport(report: DoctorReport): string {
  const envLines = report.envFiles.map((file) => {
    if (!file.loaded) return `env-file: ${file.path} (absent)`
    const perm = file.insecurePermissions ? 'insecure-permissions (expected chmod 600)' : 'mode-ok'
    return `env-file: ${file.path} (${perm}; keys-loaded=${file.keysSet.length})`
  })
  const credLines = report.credentials.map((item) => `${item.kind} ${item.name}: ${item.present ? 'present' : 'missing'}${item.required ? ' (required)' : ''}`)
  const integrationLines = report.integrations.map((item) => {
    const missing = item.missing?.length ? `; missing ${item.missing.join(', ')}` : ''
    return `${item.capability}: ${item.mode}${missing} — ${item.note}`
  })
  const dshLines = Object.entries(report.compatibility.dshFound).map(([name, version]) => `${name}@${version}`)
  return [
    `${report.product} ${report.productVersion}`,
    `node: ${report.compatibility.nodeVersion} (${report.compatibility.nodeSupported ? 'supported' : 'unsupported'})`,
    `dsh-supported: ${report.compatibility.dshSupported}`,
    ...dshLines,
    ...report.compatibility.problems.map((item) => `problem: ${item}`),
    `home: ${report.home}`,
    report.runtimeContext ? `profile: ${report.runtimeContext.profile.value} (${report.runtimeContext.profile.source})` : undefined,
    report.runtimeContext ? `profile-identity: ${report.runtimeContext.profileIdentity}` : undefined,
    report.runtimeContext ? `workspace: ${report.runtimeContext.workspaceLabel} (${report.runtimeContext.workspace.source})` : undefined,
    report.runtimeContext ? `session-id: ${report.runtimeContext.sessionId.value} (${report.runtimeContext.sessionId.source})` : undefined,
    sessionCatalogLine(report.runtimeContext),
    report.runtimeContext ? `session-persistence: ${publicRuntimeContextView(report.runtimeContext).sessionPersistence}` : undefined,
    report.runtimeContext?.profileCompositionError
      ? `profile-composition: recovery-required (${report.runtimeContext.profileCompositionError})`
      : report.runtimeContext ? `profile-composition: shipped ${report.runtimeContext.profile.value} Profile (official composeEntries; active composition)` : undefined,
    `log-file: ${report.logFile}`,
    ...envLines,
    ...credLines,
    `allow-fixtures: ${report.allowFixtures}`,
    ...integrationLines,
    report.llm ? `llm-provider: ${report.llm.provider}` : 'llm-provider: not-booted',
    report.llm ? `llm-model: ${report.llm.model}` : 'llm-model: not-booted',
    report.llm ? `llm-credential ${report.llm.credential}: ${report.llm.credentialPresent ? 'present' : 'missing'}` : undefined,
    report.llm ? `llm-route: ${report.llm.routeAvailable ? 'available' : 'unavailable'}` : undefined,
    report.llm ? `ai-runtime: ${report.llm.state}` : 'ai-runtime: LLM not configured/unavailable',
    report.llm ? `llm-note: ${report.llm.note}` : undefined,
    `persistence: ${report.persistence ?? 'not-booted'}`,
    `safe-mode: ${report.safeMode ?? 'not-booted'}`,
    `recovery-required: ${report.recoveryRequired ?? 'not-booted'}`,
    report.generatedRuntime ? `generated-runtime: ${report.generatedRuntime.state}` : 'generated-runtime: unavailable',
    report.generatedRuntime ? `isolation: ${report.generatedRuntime.isolation}` : undefined,
    report.generatedRuntime ? `active generated processes: ${report.generatedRuntime.activeProcesses}` : undefined,
    report.generatedRuntime?.lastFailure ? `last runner failure: ${report.generatedRuntime.lastFailure}` : undefined,
    report.operator ? `activation: ${report.operator.activationState}` : 'activation: not-booted',
    report.operator ? `active: ${report.operator.active.join(', ') || '(none)'}` : undefined,
    report.operator?.lastFailure ? `last-failure: ${report.operator.lastFailure}` : undefined,
  ].filter((item): item is string => item !== undefined).join('\n')
}

function sessionCatalogLine(runtimeContext: RuntimeContext | undefined): string | undefined {
  if (!runtimeContext) return undefined
  try {
    const binding = catalogBindingOf(runtimeContext)
    const dir = sessionPersistenceDirOf(runtimeContext)
    const catalog = inspectSessionCatalog(dir, binding)
    const journal = inspectSessionJournal(dir, binding)
    const catalogLine = catalog.health === 'absent'
      ? 'session-catalog: absent'
      : `session-catalog: ${catalog.health} (${catalog.activeCount} active, ${catalog.archivedCount} archived, current ${catalog.currentSessionId})`
    if (!journal) return catalogLine
    return `${catalogLine}\nsession-journal: ${journal.phase} ${journal.op}`
  } catch (error) {
    if (error instanceof SessionCatalogError) return `session-catalog: recovery-required (${error.code})`
    return 'session-catalog: recovery-required'
  }
}
