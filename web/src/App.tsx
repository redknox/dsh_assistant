import React, { useEffect, useState } from 'react'
import {
  abandonCandidateActivation,
  activateCandidate,
  decideApproval,
  rollbackSystemState,
  runRecovery,
  uninstallPlugin,
} from './api'
import {
  deferActivation,
  deferSystemRollback,
  EMPTY_GOVERNANCE_INTERACTION,
  requestAbandonment,
  requestActivation,
  requestRecovery,
  requestSystemRollback,
} from './governanceInteraction'
import { MissionControlScreen } from './MissionControlScreen'
import { type WorkspacePane } from './WorkspaceNavigation'
import { useConversationControl } from './useConversationControl'
import { useMissionControlRuntime } from './useMissionControlRuntime'
import { useSkillControl } from './useSkillControl'
import {
  EMPTY_WORKSPACE_INTERACTION,
  transitionWorkspaceInteraction,
  type WorkspaceInteractionEvent,
} from './workspaceInteraction'
import { workspacePaneFromHash, workspacePaneHash } from './workspaceRoute'

export { MissionControlScreen } from './MissionControlScreen'

export function App() {
  const runtime = useMissionControlRuntime()
  const conversation = useConversationControl(runtime)
  const skillControl = useSkillControl(runtime)
  const [governanceInteraction, setGovernanceInteraction] = useState(EMPTY_GOVERNANCE_INTERACTION)
  const [pane, setPane] = useState<WorkspacePane>(() => workspacePaneFromHash(globalThis.location?.hash))
  const [workspaceInteraction, setWorkspaceInteraction] = useState(EMPTY_WORKSPACE_INTERACTION)

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

  const interactWithWorkspace = (event: WorkspaceInteractionEvent) => {
    const requested = transitionWorkspaceInteraction(workspaceInteraction, event)
    setWorkspaceInteraction(requested.state)
    if (requested.command?.action === 'delete-conversation') {
      const { id } = requested.command
      conversation.dispatch({ action: 'delete', id })
    }
    if (requested.command?.action === 'uninstall-plugin') {
      const { plugin } = requested.command
      void runtime.perform(() => uninstallPlugin(plugin, true))
    }
  }

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
      armedRecovery={governanceInteraction.armedRecovery}
      onDraft={(value) => { conversation.dispatch({ action: 'draft', value }) }}
      onSend={() => { conversation.dispatch({ action: 'send' }) }}
      acknowledgement={runtime.acknowledgement}
      onDismissAcknowledgement={runtime.dismissAcknowledgement}
      onApprove={(card) => { void runtime.perform(() => decideApproval(card, 'approve')) }}
      onReject={(card) => { void runtime.perform(() => decideApproval(card, 'deny')) }}
      deferredActivations={governanceInteraction.deferredActivations}
      armedActivation={governanceInteraction.armedActivation}
      armedAbandonment={governanceInteraction.armedAbandonment}
      onDeferActivation={(card) => {
        setGovernanceInteraction((current) => deferActivation(current, card))
      }}
      onActivate={(card) => {
        const requested = requestActivation(governanceInteraction, card)
        setGovernanceInteraction(requested.state)
        const command = requested.command
        if (command?.action === 'activate') {
          const target = command.card
          void runtime.perform(() => activateCandidate(target, true))
        }
      }}
      onAbandonActivation={(card) => {
        const requested = requestAbandonment(governanceInteraction, card)
        setGovernanceInteraction(requested.state)
        const command = requested.command
        if (command?.action === 'abandon-activation') {
          const target = command.card
          void runtime.perform(() => abandonCandidateActivation(target, true))
        }
      }}
      pane={pane}
      onNavigate={navigate}
      confirmingSession={workspaceInteraction.confirmingSession}
      onCreateConversation={() => { conversation.dispatch({ action: 'create' }) }}
      onSwitchConversation={(id) => { conversation.dispatch({ action: 'switch', id }) }}
      onRenameConversation={(id, title) => { conversation.dispatch({ action: 'rename', id, title }) }}
      onArchiveConversation={(id) => { conversation.dispatch({ action: 'archive', id }) }}
      onRestoreConversation={(id) => { conversation.dispatch({ action: 'restore', id }) }}
      onAskDeleteConversation={(id) => { interactWithWorkspace({ action: 'ask-conversation-delete', id }) }}
      onConfirmDeleteConversation={(id) => { interactWithWorkspace({ action: 'confirm-conversation-delete', id }) }}
      inspectingExtension={workspaceInteraction.inspectingExtension}
      onInspectExtension={(id) => { interactWithWorkspace({ action: 'inspect-extension', id }) }}
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
      confirmingPlugin={workspaceInteraction.confirmingPlugin?.id}
      onAskUninstall={(plugin) => { interactWithWorkspace({ action: 'ask-plugin-uninstall', plugin }) }}
      onCancelUninstall={() => { interactWithWorkspace({ action: 'cancel-plugin-uninstall' }) }}
      onConfirmUninstall={(plugin) => { interactWithWorkspace({ action: 'confirm-plugin-uninstall', id: plugin.id }) }}
      deferredRollback={governanceInteraction.deferredRollback}
      armedRollback={governanceInteraction.armedRollback}
      onDeferRollback={() => {
        setGovernanceInteraction((current) => deferSystemRollback(current))
      }}
      onAskRollback={(card) => {
        const requested = requestSystemRollback(governanceInteraction, card)
        setGovernanceInteraction(requested.state)
        const command = requested.command
        if (command?.action === 'rollback-system') {
          const target = command.card
          void runtime.perform(() => rollbackSystemState(target, true))
        }
      }}
      onRecovery={(action) => {
        const requested = requestRecovery(governanceInteraction, action)
        setGovernanceInteraction(requested.state)
        const command = requested.command
        if (command?.action === 'recover') {
          const recovery = command.recovery
          void runtime.perform(() => runRecovery(recovery, true))
        }
      }}
    />
  )
}
