import type { MissionControlView, UserCapabilityStatus } from '../workspace/types.js'

export type SystemSurfaceAvailability = 'available' | 'not-connected' | 'unavailable' | 'withheld'

export interface SystemSurfaceAction {
  readonly name: string
  readonly state: 'ready' | 'approval-on-use' | 'not-connected' | 'unavailable' | 'withheld'
}

export interface SystemSurface {
  readonly id: string
  readonly name: string
  readonly availability: SystemSurfaceAvailability
  readonly provider?: string
  readonly actions: readonly SystemSurfaceAction[]
}

export interface SystemInfoProjection {
  readonly surfaces: readonly SystemSurface[]
  readonly summary: {
    readonly builtIn: number
    readonly available: number
    readonly needsConnection: number
    readonly mode: MissionControlView['systemState']
  }
}

/**
 * Presents product-declared runtime surfaces as diagnostics, not installable capabilities.
 * Provider implementation details that are only fixtures are deliberately hidden.
 */
export function projectSystemInfo(view: Pick<MissionControlView, 'capabilities' | 'systemState'>): SystemInfoProjection {
  const grouped = new Map<string, MissionControlView['capabilities']>()
  for (const item of view.capabilities) {
    grouped.set(item.area, [...(grouped.get(item.area) ?? []), item])
  }

  const surfaces = [...grouped.entries()].map(([area, rows]): SystemSurface => {
    const provider = rows.map((row) => row.advanced?.provider).find((value) => value && value !== 'fake')
    const actions = rows.map((row) => ({ name: row.action, state: actionState(row.status) }))
    return {
      id: area.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-'),
      name: area,
      availability: surfaceAvailability(rows.map((row) => row.status)),
      ...(provider ? { provider } : {}),
      actions,
    }
  }).sort((left, right) => availabilityRank(left.availability) - availabilityRank(right.availability) || left.name.localeCompare(right.name))

  return {
    surfaces,
    summary: {
      builtIn: surfaces.length,
      available: surfaces.filter((surface) => surface.availability === 'available').length,
      needsConnection: surfaces.filter((surface) => surface.availability === 'not-connected').length,
      mode: view.systemState,
    },
  }
}

function actionState(status: UserCapabilityStatus): SystemSurfaceAction['state'] {
  if (status === 'active') return 'ready'
  if (status === 'approval-required') return 'approval-on-use'
  if (status === 'not-connected') return 'not-connected'
  if (status === 'safe-mode-disabled') return 'withheld'
  return 'unavailable'
}

function surfaceAvailability(statuses: readonly UserCapabilityStatus[]): SystemSurfaceAvailability {
  if (statuses.some((status) => status === 'active' || status === 'approval-required')) return 'available'
  if (statuses.every((status) => status === 'not-connected')) return 'not-connected'
  if (statuses.every((status) => status === 'safe-mode-disabled')) return 'withheld'
  return 'unavailable'
}

function availabilityRank(status: SystemSurfaceAvailability): number {
  if (status === 'available') return 0
  if (status === 'not-connected') return 1
  if (status === 'withheld') return 2
  return 3
}
