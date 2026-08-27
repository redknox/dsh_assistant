import type { MissionControlView } from '../../src/domain/workspace/types'

export function isPendingApproval(status: string): boolean {
  return status === 'pending' || status === 'approval-requested' || status === 'unreviewed'
}

export function skillInvocationSurfaceOpen(view: MissionControlView): boolean {
  if (view.systemState === 'SAFE_MODE' || view.runtimeContext?.safeMode === true) return false
  const state = view.skillCatalog?.state
  return state === undefined || state === 'ok' || state === 'empty'
}

export function formatDiff(added: readonly string[], removed: readonly string[], changed: readonly string[] = []): string {
  const plus = added.map((item) => `+${item}`).join(' ')
  const minus = removed.map((item) => `-${item}`).join(' ')
  const tilde = changed.map((item) => `~${item}`).join(' ')
  return [plus, minus, tilde].filter((item) => item !== '').join(' ') || 'none'
}
