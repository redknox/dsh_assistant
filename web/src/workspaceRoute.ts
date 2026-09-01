import type { WorkspacePane } from './WorkspaceNavigation'

export function workspacePaneFromHash(hash: string | undefined): WorkspacePane {
  if (hash === '#extensions') return 'extensions'
  if (hash === '#expense-review') return 'expense-review'
  if (hash === '#conversations' || hash === '#memory') return 'memory'
  if (hash === '#logs') return 'logs'
  if (hash === '#settings') return 'settings'
  if (hash === '#tools') return 'tools'
  if (hash === '#workflows') return 'workflows'
  if (hash === '#specifications') return 'specifications'
  return 'today'
}

export function workspacePaneHash(pane: WorkspacePane): `#${WorkspacePane}` {
  return `#${pane}`
}
