import React, { useEffect, useState } from 'react'
import { MissionControlScreen } from './MissionControlScreen'
import { type WorkspacePane } from './WorkspaceNavigation'
import { useConversationControl } from './useConversationControl'
import { useGovernanceControl } from './useGovernanceControl'
import { useMissionControlRuntime } from './useMissionControlRuntime'
import { useSkillControl } from './useSkillControl'
import { useWorkspaceControl } from './useWorkspaceControl'
import { workspacePaneFromHash, workspacePaneHash } from './workspaceRoute'

export { MissionControlScreen } from './MissionControlScreen'

export function App() {
  const runtime = useMissionControlRuntime()
  const conversation = useConversationControl(runtime)
  const governance = useGovernanceControl(runtime)
  const skillControl = useSkillControl(runtime)
  const workspace = useWorkspaceControl(runtime, conversation)
  const [pane, setPane] = useState<WorkspacePane>(() => workspacePaneFromHash(globalThis.location?.hash))

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
      connected={runtime.connected}
      sending={conversation.sending}
      error={runtime.error}
      draft={conversation.draft}
      armedRecovery={governance.state.armedRecovery}
      onDraft={(value) => { conversation.dispatch({ action: 'draft', value }) }}
      onSend={() => { conversation.dispatch({ action: 'send' }) }}
      acknowledgement={runtime.acknowledgement}
      onDismissAcknowledgement={runtime.dismissAcknowledgement}
      onApprove={(card) => { governance.dispatch({ action: 'approve', card }) }}
      onReject={(card) => { governance.dispatch({ action: 'reject', card }) }}
      deferredActivations={governance.state.deferredActivations}
      armedActivation={governance.state.armedActivation}
      armedAbandonment={governance.state.armedAbandonment}
      onDeferActivation={(card) => {
        governance.dispatch({ action: 'defer-activation', card })
      }}
      onActivate={(card) => {
        governance.dispatch({ action: 'activate', card })
      }}
      onAbandonActivation={(card) => {
        governance.dispatch({ action: 'abandon-activation', card })
      }}
      pane={pane}
      onNavigate={navigate}
      confirmingSession={workspace.state.confirmingSession}
      onCreateConversation={() => { conversation.dispatch({ action: 'create' }) }}
      onSwitchConversation={(id) => { conversation.dispatch({ action: 'switch', id }) }}
      onRenameConversation={(id, title) => { conversation.dispatch({ action: 'rename', id, title }) }}
      onArchiveConversation={(id) => { conversation.dispatch({ action: 'archive', id }) }}
      onRestoreConversation={(id) => { conversation.dispatch({ action: 'restore', id }) }}
      onAskDeleteConversation={(id) => { workspace.dispatch({ action: 'ask-conversation-delete', id }) }}
      onConfirmDeleteConversation={(id) => { workspace.dispatch({ action: 'confirm-conversation-delete', id }) }}
      inspectingExtension={workspace.state.inspectingExtension}
      onInspectExtension={(id) => { workspace.dispatch({ action: 'inspect-extension', id }) }}
      confirmingSkill={skillControl.state.confirmingSkill}
      armedSkill={skillControl.state.armedSkill}
      skillDependents={skillControl.state.dependents
        ? { id: skillControl.state.dependents.id, dependents: skillControl.state.dependents.values }
        : undefined}
      onPickSkill={(skill) => {
        conversation.dispatch({ action: 'suggest-skill', name: skill.name })
      }}
      onSkillAction={(action, skill) => {
        skillControl.dispatch(action, skill)
      }}
      confirmingPlugin={workspace.state.confirmingPlugin?.id}
      onAskUninstall={(plugin) => { workspace.dispatch({ action: 'ask-plugin-uninstall', plugin }) }}
      onCancelUninstall={() => { workspace.dispatch({ action: 'cancel-plugin-uninstall' }) }}
      onConfirmUninstall={(plugin) => { workspace.dispatch({ action: 'confirm-plugin-uninstall', id: plugin.id }) }}
      deferredRollback={governance.state.deferredRollback}
      armedRollback={governance.state.armedRollback}
      onDeferRollback={() => {
        governance.dispatch({ action: 'defer-rollback' })
      }}
      onAskRollback={(card) => {
        governance.dispatch({ action: 'rollback', card })
      }}
      onRecovery={(action) => {
        governance.dispatch({ action: 'recover', recovery: action })
      }}
    />
  )
}
