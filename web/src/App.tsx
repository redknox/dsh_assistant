import React, { useEffect, useState } from 'react'
import { MissionControlScreen } from './MissionControlScreen'
import { type WorkspacePane } from './WorkspaceNavigation'
import { useConversationControl } from './useConversationControl'
import { useGovernanceControl } from './useGovernanceControl'
import { useMissionControlRuntime } from './useMissionControlRuntime'
import { useSkillControl } from './useSkillControl'
import { useWorkspaceControl } from './useWorkspaceControl'
import { useSettingsControl } from './useSettingsControl'
import { workspacePaneFromHash, workspacePaneHash } from './workspaceRoute'

export { MissionControlScreen } from './MissionControlScreen'

export function App() {
  const runtime = useMissionControlRuntime()
  const conversation = useConversationControl(runtime)
  const governance = useGovernanceControl(runtime)
  const skillControl = useSkillControl(runtime)
  const workspace = useWorkspaceControl(runtime, conversation)
  const [pane, setPane] = useState<WorkspacePane>(() => workspacePaneFromHash(globalThis.location?.hash))
  const settings = useSettingsControl(pane === 'settings')

  useEffect(() => {
    const sync = () => { setPane(workspacePaneFromHash(globalThis.location?.hash)) }
    globalThis.addEventListener?.('hashchange', sync)
    return () => globalThis.removeEventListener?.('hashchange', sync)
  }, [])

  const navigate = (next: WorkspacePane) => {
    setPane(next)
    if (globalThis.location) {
      globalThis.location.hash = workspacePaneHash(next)
    }
  }

  const view = runtime.view

  if (!view) {
    return <p className="loading">Connecting to local TARS-NG…</p>
  }

  return (
    <MissionControlScreen
      view={view}
      runtime={runtime}
      conversation={conversation}
      governance={governance}
      workspace={workspace}
      skill={skillControl}
      settings={settings}
      navigation={{ pane, navigate }}
    />
  )
}
