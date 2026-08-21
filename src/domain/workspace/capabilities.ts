import type { UserCapabilityStatus, UserCapabilityView, WorkspaceSnapshotInput } from './types.js'

interface CatalogRow {
  readonly area: string
  readonly action: string
  readonly match: (capability: string) => boolean
  readonly write?: boolean
}

const CATALOG: readonly CatalogRow[] = [
  { area: 'Calendar', action: 'Read schedule', match: (id) => id.includes('calendar') && !isWrite(id) },
  { area: 'Calendar', action: 'Find free time', match: (id) => id.includes('freebusy') || id === 'calendar.read' },
  { area: 'Calendar', action: 'Create event', match: (id) => isWrite(id) && id.includes('calendar'), write: true },
  { area: 'Tasks', action: 'Create task', match: (id) => id.includes('task'), write: true },
  { area: 'Files', action: 'Manage files', match: (id) => id.includes('files'), write: true },
  { area: 'Memory', action: 'Remember facts', match: (id) => id.includes('memory') },
  { area: 'Knowledge', action: 'Retrieve notes', match: (id) => id.includes('knowledge') },
]

function isWrite(id: string): boolean {
  return /create|write|delete|send|update/.test(id)
}

export function projectUserCapabilities(input: WorkspaceSnapshotInput): readonly UserCapabilityView[] {
  const views: UserCapabilityView[] = []
  const seen = new Set<string>()
  for (const record of input.registry) {
    for (const capability of record.capabilities) {
      const row = CATALOG.find((item) => item.match(capability))
      if (!row) continue
      const key = `${row.area}:${row.action}`
      if (seen.has(key)) continue
      seen.add(key)
      views.push({
        area: row.area,
        action: row.action,
        status: capabilityStatus(input, record, row.write === true),
        advanced: {
          owner: record.owner,
          version: record.version,
          provenance: record.provenance,
        },
      })
    }
  }
  for (const integration of input.integrationStatus) {
    const rows = CATALOG.filter((item) => item.match(integration.capability) || (integration.capability === 'calendar' && item.area === 'Calendar'))
    for (const row of rows) {
      const key = `${row.area}:${row.action}`
      if (seen.has(key)) continue
      seen.add(key)
      views.push({
        area: row.area,
        action: row.action,
        status: capabilityFromIntegration(input, integration, row.write === true),
      })
    }
  }
  return views
}

function capabilityFromIntegration(
  input: WorkspaceSnapshotInput,
  integration: WorkspaceSnapshotInput['integrationStatus'][number],
  write: boolean,
): UserCapabilityStatus {
  if (input.safeMode) return 'safe-mode-disabled'
  if (!integration.available) return 'unavailable'
  return write ? 'approval-required' : 'active'
}

function capabilityStatus(
  input: WorkspaceSnapshotInput,
  record: WorkspaceSnapshotInput['registry'][number],
  write: boolean,
): UserCapabilityStatus {
  if (input.safeMode && record.provenance === 'generated') return 'safe-mode-disabled'
  if (record.status !== 'active') return 'unavailable'
  return write ? 'approval-required' : 'active'
}
