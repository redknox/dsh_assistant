import type { UserCapabilityStatus, UserCapabilityView, WorkspaceSnapshotInput } from './types.js'

interface CatalogRow {
  readonly area: string
  readonly action: string
  readonly match: (capability: string) => boolean
  readonly write?: boolean
}

const HUB_CAPABILITIES = new Set(['calendar', 'mail', 'contacts', 'files', 'tasks'])

const CATALOG: readonly CatalogRow[] = [
  { area: 'Calendar', action: 'Read schedule', match: (id) => isCalendar(id) && !isCalendarWrite(id) },
  { area: 'Calendar', action: 'Create event', match: (id) => isCalendarWrite(id), write: true },
  { area: 'Tasks', action: 'Create task', match: (id) => id.includes('task'), write: true },
  { area: 'Files', action: 'Manage files', match: (id) => id.includes('files'), write: true },
  { area: 'Mail', action: 'Read mail', match: (id) => id.includes('mail') },
  { area: 'Contacts', action: 'Find people', match: (id) => id.includes('contacts') },
  { area: 'Memory', action: 'Remember facts', match: (id) => id.includes('memory') },
  { area: 'Knowledge', action: 'Retrieve notes', match: (id) => id.includes('knowledge') },
  { area: 'Web', action: 'Search public sources', match: (id) => id.includes('web') || id.includes('search') },
]

function isWrite(id: string): boolean {
  return /create|write|delete|send|update/.test(id)
}

function isCalendar(id: string): boolean {
  return id === 'calendar' || id.includes('calendar')
}

function isCalendarWrite(id: string): boolean {
  return isCalendar(id) && (isWrite(id) || id.includes('execute') || id.includes('propose'))
}

function rowsFor(capability: string): readonly CatalogRow[] {
  if (HUB_CAPABILITIES.has(capability)) {
    return CATALOG.filter((item) => item.area.toLowerCase() === capability)
  }
  const row = CATALOG.find((item) => item.match(capability))
  return row ? [row] : []
}

export function projectUserCapabilities(input: WorkspaceSnapshotInput): readonly UserCapabilityView[] {
  const views: UserCapabilityView[] = []
  const seen = new Set<string>()
  for (const record of input.registry) {
    for (const capability of record.capabilities) {
      for (const row of rowsFor(capability)) {
        const key = `${row.area}:${row.action}`
        if (seen.has(key)) continue
        seen.add(key)
        const provider = integrationProvider(input, row.area) ?? projectionProvider(row.area, record)
        const status = resolveStatus(input, row, record)
        views.push({
          area: row.area,
          action: row.action,
          status,
          readiness: readinessOf(input, row, status, provider),
          advanced: {
            owner: record.owner,
            version: record.version,
            provenance: record.provenance,
            ...(provider ? { provider } : {}),
          },
        })
      }
    }
  }
  for (const integration of input.integrationStatus) {
    for (const row of rowsFor(integration.capability)) {
      const key = `${row.area}:${row.action}`
      if (seen.has(key)) continue
      seen.add(key)
      const status = resolveStatus(input, row)
      views.push({
        area: row.area,
        action: row.action,
        status,
        readiness: readinessOf(input, row, status, integration.provider),
        ...(integration.provider ? { advanced: { provider: integration.provider } } : {}),
      })
    }
  }
  return views
}

function readinessOf(
  input: WorkspaceSnapshotInput,
  row: CatalogRow,
  status: UserCapabilityStatus,
  provider?: string,
): UserCapabilityView['readiness'] {
  const integration = input.integrationStatus.find((item) => item.capability === row.area.toLowerCase())
  const runtime = status === 'safe-mode-disabled'
    ? 'withheld' as const
    : status === 'active' || status === 'approval-required'
      ? 'mounted' as const
      : 'not-mounted' as const
  const configuration = integration
    ? integration.configured === false
      ? 'not-configured' as const
      : integration.configured === true || integration.available
        ? 'configured' as const
        : 'unknown' as const
    : 'not-required' as const
  const authentication = integration?.authorization === 'ready'
    ? 'verified' as const
    : integration?.authorization === 'expiring'
      ? 'expiring' as const
      : integration?.authorization === 'expired' || integration?.authorization === 'unavailable'
        ? 'required' as const
        : provider === 'sandbox' || !integration
          ? 'not-required' as const
          : 'unverified' as const
  const data = row.area === 'Memory'
    ? input.memory.length > 0 ? 'present' as const : 'empty' as const
    : row.area === 'Knowledge'
      ? input.knowledge.length > 0 ? 'present' as const : 'empty' as const
      : integration && runtime === 'mounted'
        ? 'verified-on-use' as const
        : 'unknown' as const
  return {
    runtime,
    configuration,
    authentication,
    data,
    summary: readinessSummary({ runtime, configuration, authentication, data }),
  }
}

function readinessSummary(input: Omit<UserCapabilityView['readiness'], 'summary'>): string {
  if (input.runtime === 'withheld') return 'WITHHELD BY SAFE MODE'
  if (input.configuration === 'not-configured') return 'CONNECTION REQUIRED'
  if (input.authentication === 'required') return 'REAUTHENTICATION REQUIRED'
  if (input.runtime !== 'mounted') return 'NOT MOUNTED'
  if (input.data === 'empty') return 'AVAILABLE · NO DATA YET'
  if (input.data === 'present') return 'AVAILABLE · LOCAL DATA PRESENT'
  if (input.authentication === 'verified') return 'AUTH VERIFIED · DATA CHECKED ON USE'
  if (input.authentication === 'expiring') return 'AUTH EXPIRING · DATA CHECKED ON USE'
  if (input.authentication === 'unverified') return 'CONFIGURED · VERIFIED ON USE'
  return 'LOCAL RUNTIME MOUNTED'
}

function integrationProvider(input: WorkspaceSnapshotInput, area: string): string | undefined {
  return input.integrationStatus.find((item) => item.capability === area.toLowerCase())?.provider
}

function projectionProvider(
  area: string,
  record: WorkspaceSnapshotInput['registry'][number],
): string | undefined {
  const permissions = record.permissions ?? []
  if (area === 'Files' && permissions.some((item) => item.startsWith('local.sandbox.files.'))) return 'sandbox'
  if (area === 'Tasks' && permissions.some((item) => item.startsWith('local.sandbox.tasks.'))) return 'sandbox'
  return record.provider
}

function resolveStatus(
  input: WorkspaceSnapshotInput,
  row: CatalogRow,
  record?: WorkspaceSnapshotInput['registry'][number],
): UserCapabilityStatus {
  if (input.safeMode && (record?.provenance === 'generated' || record?.provenance === 'third-party')) {
    return 'safe-mode-disabled'
  }
  const integration = input.integrationStatus.find((item) => item.capability === row.area.toLowerCase())
  if (integration) {
    if (input.safeMode && record === undefined) return 'safe-mode-disabled'
    if (!integration.available && integration.configured === false) return 'not-connected'
    if (!integration.available) return 'unavailable'
    return requiresConfirmation(input, row) ? 'approval-required' : 'active'
  }
  if (record && record.status !== 'active') return 'unavailable'
  if (record) return requiresConfirmation(input, row) ? 'approval-required' : 'active'
  return 'unavailable'
}

function requiresConfirmation(input: WorkspaceSnapshotInput, row: CatalogRow): boolean {
  return row.write === true && !input.autoExecuteCapabilities?.includes(row.area.toLowerCase())
}
