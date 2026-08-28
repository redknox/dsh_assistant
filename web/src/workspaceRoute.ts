import type { WorkspacePane } from './WorkspaceNavigation'

export function workspacePaneFromHash(hash: string | undefined): WorkspacePane {
  if (hash === '#extensions') return 'extensions'
  if (hash === '#conversations' || hash === '#memory') return 'memory'
  if (hash === '#logs') return 'logs'
  return 'today'
}

export function workspacePaneHash(pane: WorkspacePane): `#${WorkspacePane}` {
  return `#${pane}`
}
