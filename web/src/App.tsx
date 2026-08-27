import React, { useEffect, useState } from 'react'
import {
  abandonCandidateActivation,
  activateCandidate,
  decideApproval,
  rollbackSystemState,
  runConversation,
  runRecovery,
  runSkillAction,
  sendMessage,
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
import {
  completeSkillInteraction,
  EMPTY_SKILL_INTERACTION,
  requestSkillInteraction,
  requireSkillDependents,
} from './skillInteraction'
import { type WorkspacePane } from './WorkspaceNavigation'
import { useMissionControlRuntime } from './useMissionControlRuntime'
import {
  EMPTY_WORKSPACE_INTERACTION,
  transitionWorkspaceInteraction,
  type WorkspaceInteractionEvent,
} from './workspaceInteraction'
import { workspacePaneFromHash, workspacePaneHash } from './workspaceRoute'

export { MissionControlScreen } from './MissionControlScreen'

export function App() {
  const runtime = useMissionControlRuntime()
  const [sending, setSending] = useState(false)
  const [draft, setDraft] = useState('')
  const [governanceInteraction, setGovernanceInteraction] = useState(EMPTY_GOVERNANCE_INTERACTION)
  const [pane, setPane] = useState<WorkspacePane>(() => workspacePaneFromHash(globalThis.location?.hash))
  const [workspaceInteraction, setWorkspaceInteraction] = useState(EMPTY_WORKSPACE_INTERACTION)
  const [skillInteraction, setSkillInteraction] = useState(EMPTY_SKILL_INTERACTION)

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
  const onSend = async () => {
    if (sending || draft.trim() === '') return
    setSending(true)
    try {
      const next = await runtime.perform(() => {
        const sessionId = view?.runtimeContext?.sessionId ?? view?.sessions?.currentSessionId
        if (!sessionId) throw new Error('current session is unknown')
        return sendMessage(draft.trim(), sessionId)
      }, 'send failed')
      if (next) setDraft('')
    } finally {
      setSending(false)
    }
  }

  const catalogRef = () => ({
    sessionId: view?.runtimeContext?.sessionId ?? view?.sessions?.currentSessionId ?? 'main',
    revision: view?.sessions?.revision ?? 0,
  })

  const interactWithWorkspace = (event: WorkspaceInteractionEvent) => {
    const requested = transitionWorkspaceInteraction(workspaceInteraction, event)
    setWorkspaceInteraction(requested.state)
    if (requested.command?.action === 'delete-conversation') {
      const { id } = requested.command
      void runtime.perform(() => runConversation('delete', { ...catalogRef(), id, confirm: true }))
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
      sending={sending}
      error={runtime.error}
      draft={draft}
      armedRecovery={governanceInteraction.armedRecovery}
      onDraft={setDraft}
      onSend={() => { void onSend() }}
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
      onCreateConversation={() => { void runtime.perform(() => runConversation('create', catalogRef())) }}
      onSwitchConversation={(id) => { void runtime.perform(() => runConversation('switch', { ...catalogRef(), id })) }}
      onRenameConversation={(id, title) => { void runtime.perform(() => runConversation('rename', { ...catalogRef(), id, title })) }}
      onArchiveConversation={(id) => { void runtime.perform(() => runConversation('archive', { ...catalogRef(), id })) }}
      onRestoreConversation={(id) => { void runtime.perform(() => runConversation('restore', { ...catalogRef(), id })) }}
      onAskDeleteConversation={(id) => { interactWithWorkspace({ action: 'ask-conversation-delete', id }) }}
      onConfirmDeleteConversation={(id) => { interactWithWorkspace({ action: 'confirm-conversation-delete', id }) }}
      inspectingExtension={workspaceInteraction.inspectingExtension}
      onInspectExtension={(id) => { interactWithWorkspace({ action: 'inspect-extension', id }) }}
      confirmingSkill={skillInteraction.confirmingSkill}
      armedSkill={skillInteraction.armedSkill}
      skillDependents={skillInteraction.dependents
        ? { id: skillInteraction.dependents.id, dependents: skillInteraction.dependents.values }
        : undefined}
      onPickSkill={(skill) => {
        setDraft((current) => current.trim() === '' ? `Use the ${skill.name} skill.` : `${current.trim()} ${skill.name}`)
      }}
      onSkillAction={(action, skill) => {
        const requested = requestSkillInteraction(skillInteraction, action, skill)
        setSkillInteraction(requested.state)
        const command = requested.command
        if (!command) return
        if (command.action === 'uninstall' || command.action === 'disable') {
          if (!command.skill) return
          const destructiveAction = command.action
          const target = command.skill
          void runtime.perform(async () => {
            try {
              const next = await runSkillAction({
                action: destructiveAction,
                skill: target,
                confirm: true,
                acknowledgeDependents: command.acknowledgeDependents,
                dependents: command.dependents,
              })
              setSkillInteraction((current) => completeSkillInteraction(current))
              return next
            } catch (caught) {
              const error = caught as Error & { code?: string; dependents?: readonly string[] }
              if (error.code === 'dependents-required' && error.dependents) {
                setSkillInteraction((current) => requireSkillDependents(
                  current,
                  destructiveAction,
                  target,
                  error.dependents ?? [],
                ))
              }
              throw caught
            }
          })
          return
        }
        void runtime.perform(() => runSkillAction({
          action: command.action,
          skill: command.skill,
          confirm: true,
          rollback: view.skillRollback,
        }))
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
