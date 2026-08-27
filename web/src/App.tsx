import React, { useEffect, useMemo, useState } from 'react'
import {
  abandonCandidateActivation,
  activateCandidate,
  decideApproval,
  establishSession,
  fetchView,
  openViewStream,
  rollbackSystemState,
  runConversation,
  runRecovery,
  runSkillAction,
  sendMessage,
  uninstallPlugin,
  type UiEnvelope,
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
import { workspacePaneFromHash, workspacePaneHash } from './workspaceRoute'

export { MissionControlScreen } from './MissionControlScreen'

export function App() {
  const [envelope, setEnvelope] = useState<UiEnvelope | undefined>()
  const [connected, setConnected] = useState(false)
  const [sending, setSending] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string>()
  const [governanceInteraction, setGovernanceInteraction] = useState(EMPTY_GOVERNANCE_INTERACTION)
  const [confirmingPlugin, setConfirmingPlugin] = useState<string>()
  const [pane, setPane] = useState<WorkspacePane>(() => workspacePaneFromHash(globalThis.location?.hash))
  const [confirmingSession, setConfirmingSession] = useState<string>()
  const [inspectingExtension, setInspectingExtension] = useState<string>()
  const [skillInteraction, setSkillInteraction] = useState(EMPTY_SKILL_INTERACTION)
  const [acknowledgement, setAcknowledgement] = useState<{ readonly text: string }>()

  useEffect(() => {
    const sync = () => { setPane(workspacePaneFromHash(globalThis.location?.hash)) }
    globalThis.addEventListener?.('hashchange', sync)
    return () => globalThis.removeEventListener?.('hashchange', sync)
  }, [])

  useEffect(() => {
    if (!acknowledgement) return
    const timer = globalThis.setTimeout(() => setAcknowledgement(undefined), 4000)
    return () => globalThis.clearTimeout(timer)
  }, [acknowledgement])

  const navigate = (next: WorkspacePane) => {
    setPane(next)
    if (globalThis.location) {
      globalThis.location.hash = workspacePaneHash(next)
    }
  }

  useEffect(() => {
    let closed = false
    let stop = () => {}
    void (async () => {
      try {
        await establishSession()
        if (closed) return
        const next = await fetchView()
        if (!closed) setEnvelope(next)
      } catch (caught: unknown) {
        if (!closed) setError(caught instanceof Error ? caught.message : 'unable to load workspace')
      }
      if (closed) return
      stop = openViewStream((next) => setEnvelope(next), setConnected)
    })()
    return () => {
      closed = true
      stop()
    }
  }, [])

  const view = envelope?.view
  const onSend = async () => {
    if (sending || draft.trim() === '') return
    setSending(true)
    setError(undefined)
    try {
      const sessionId = view?.runtimeContext?.sessionId ?? view?.sessions?.currentSessionId
      if (!sessionId) throw new Error('current session is unknown')
      setEnvelope(await sendMessage(draft.trim(), sessionId))
      setDraft('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'send failed')
    } finally {
      setSending(false)
    }
  }

  const act = async (run: () => Promise<UiEnvelope>) => {
    setError(undefined)
    try {
      const next = await run()
      setEnvelope(next)
      if (next.acknowledgement) setAcknowledgement(next.acknowledgement)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'action failed')
    }
  }

  const catalogRef = () => ({
    sessionId: envelope?.view.runtimeContext?.sessionId ?? envelope?.view.sessions?.currentSessionId ?? 'main',
    revision: envelope?.view.sessions?.revision ?? 0,
  })

  const empty = useMemo(() => view, [view])
  if (!empty) {
    return <p className="loading">Connecting to local TARS-NG…</p>
  }

  return (
    <MissionControlScreen
      view={empty}
      connected={connected}
      sending={sending}
      error={error}
      draft={draft}
      armedRecovery={governanceInteraction.armedRecovery}
      onDraft={setDraft}
      onSend={() => { void onSend() }}
      acknowledgement={acknowledgement}
      onDismissAcknowledgement={() => setAcknowledgement(undefined)}
      onApprove={(card) => { void act(() => decideApproval(card, 'approve')) }}
      onReject={(card) => { void act(() => decideApproval(card, 'deny')) }}
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
          void act(() => activateCandidate(target, true))
        }
      }}
      onAbandonActivation={(card) => {
        const requested = requestAbandonment(governanceInteraction, card)
        setGovernanceInteraction(requested.state)
        const command = requested.command
        if (command?.action === 'abandon-activation') {
          const target = command.card
          void act(() => abandonCandidateActivation(target, true))
        }
      }}
      pane={pane}
      onNavigate={navigate}
      confirmingSession={confirmingSession}
      onCreateConversation={() => { void act(() => runConversation('create', catalogRef())) }}
      onSwitchConversation={(id) => { void act(() => runConversation('switch', { ...catalogRef(), id })) }}
      onRenameConversation={(id, title) => { void act(() => runConversation('rename', { ...catalogRef(), id, title })) }}
      onArchiveConversation={(id) => { void act(() => runConversation('archive', { ...catalogRef(), id })) }}
      onRestoreConversation={(id) => { void act(() => runConversation('restore', { ...catalogRef(), id })) }}
      onAskDeleteConversation={(id) => { setConfirmingSession(id) }}
      onConfirmDeleteConversation={(id) => {
        setConfirmingSession(undefined)
        void act(() => runConversation('delete', { ...catalogRef(), id, confirm: true }))
      }}
      inspectingExtension={inspectingExtension}
      onInspectExtension={(id) => { setInspectingExtension((current) => current === id ? undefined : id) }}
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
          void act(async () => {
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
        void act(() => runSkillAction({
          action: command.action,
          skill: command.skill,
          confirm: true,
          rollback: empty.skillRollback,
        }))
      }}
      confirmingPlugin={confirmingPlugin}
      onAskUninstall={(plugin) => { setConfirmingPlugin(plugin.id) }}
      onCancelUninstall={() => { setConfirmingPlugin(undefined) }}
      onConfirmUninstall={(plugin) => {
        setConfirmingPlugin(undefined)
        void act(() => uninstallPlugin(plugin, true))
      }}
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
          void act(() => rollbackSystemState(target, true))
        }
      }}
      onRecovery={(action) => {
        const requested = requestRecovery(governanceInteraction, action)
        setGovernanceInteraction(requested.state)
        const command = requested.command
        if (command?.action === 'recover') {
          const recovery = command.recovery
          void act(() => runRecovery(recovery, true))
        }
      }}
    />
  )
}
