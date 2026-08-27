import React, { useEffect, useMemo, useState } from 'react'
import type { ActivationCard, ApprovalCard, MissionControlView, RollbackCard, SkillProjection, UserPluginView } from '../../src/domain/workspace/types'
import {
  abandonCandidateActivation,
  activateCandidate,
  decideApproval,
  establishSession,
  fetchView,
  openViewStream,
  recoveryActionId,
  rollbackSystemState,
  runConversation,
  runRecovery,
  runSkillAction,
  sendMessage,
  uninstallPlugin,
  type UiEnvelope,
} from './api'
import { Glyph } from './icons'
import { ConversationWorkspace } from './ConversationWorkspace'
import { ExtensionsWorkspace } from './ExtensionsWorkspace'
import { PlateRivets } from './Faceplate'
import { MemoryWorkspace } from './MemoryWorkspace'
import { ControlStripView, OperationsPanel } from './OperationalStatus'
import { WorkspaceNavigation, type WorkspacePane } from './WorkspaceNavigation'
import {
  completeSkillInteraction,
  EMPTY_SKILL_INTERACTION,
  requestSkillInteraction,
  requireSkillDependents,
} from './skillInteraction'
import {
  deferActivation,
  deferSystemRollback,
  EMPTY_GOVERNANCE_INTERACTION,
  requestAbandonment,
  requestActivation,
  requestRecovery,
  requestSystemRollback,
} from './governanceInteraction'

function lampModifier(state: MissionControlView['systemState'], connected: boolean): string {
  if (!connected) return 'offline'
  if (state === 'READY') return 'ready'
  if (state === 'WORKING') return 'working'
  if (state === 'WAITING') return 'waiting'
  if (state === 'NEEDS_APPROVAL') return 'approval'
  if (state === 'DEGRADED') return 'degraded'
  if (state === 'BLOCKED') return 'blocked'
  return 'fault'
}

type CompactSurface = 'conversation' | 'navigation' | 'operations'

function paneFromHash(): WorkspacePane {
  if (globalThis.location?.hash === '#extensions') return 'extensions'
  if (globalThis.location?.hash === '#conversations') return 'memory'
  if (globalThis.location?.hash === '#memory') return 'memory'
  return 'today'
}

function SystemHeader(props: {
  readonly identity: string
  readonly systemState: MissionControlView['systemState']
  readonly objective?: string
  readonly connected: boolean
  readonly runtimeContext?: MissionControlView['runtimeContext']
}) {
  const context = props.runtimeContext
  return (
    <header className="faceplate topbar" aria-label="System header">
      <PlateRivets />
      <div className="topbar-well">
        <div className="brand-block">
          <span className="brand">{props.identity}</span>
          <span className="divider" aria-hidden="true">/</span>
          <span className="product-area">MISSION CONTROL</span>
          {props.objective ? <span className="objective">{props.objective}</span> : null}
        </div>
        <div className="system-state" role="status" aria-label={`System state ${props.systemState}${props.connected ? '' : ', disconnected'}`}>
          <span className={`status-lamp status-lamp--${lampModifier(props.systemState, props.connected)}`} aria-hidden="true"></span>
          <span>{props.systemState}</span>
        </div>
      </div>
      {context ? (
        <p className="runtime-context" data-runtime-context="true">
          Profile {context.profile} · Workspace {context.workspaceLabel} · Session {context.sessionId} · Persistence {context.sessionPersistence}
        </p>
      ) : null}
    </header>
  )
}

function RecoveryPanel(props: {
  readonly systemState: MissionControlView['systemState']
  readonly recovery: NonNullable<MissionControlView['recovery']>
  readonly locked: boolean
  readonly armedRecovery?: string
  readonly error?: string
  readonly onRecovery: (action: 'diagnostics' | 'rollback' | 'exit-safe-mode') => void
}) {
  return (
    <section className="recovery-panel" data-recovery="true">
      <h1>{props.systemState}</h1>
      <p>{props.recovery.why}</p>
      <p>Disabled: {props.recovery.disabled.join(', ') || 'generated/optional capabilities'}</p>
      {props.error ? <p className="error" role="alert">{props.error}</p> : null}
      <div className="recovery-actions">
        {props.recovery.actions.map((action) => {
          const mapped = recoveryActionId(action)
          if (!mapped) {
            return <button key={action} className="button button--secondary" type="button" disabled title="Not available from this Web UI">{action}</button>
          }
          const needsConfirm = mapped !== 'diagnostics'
          const armed = props.armedRecovery === mapped
          const label = needsConfirm && armed ? `Confirm ${action}` : action
          const tone = mapped === 'diagnostics' ? 'button--secondary' : 'button--fault'
          return (
            <button
              key={action}
              type="button"
              className={`button ${tone}`}
              data-recovery-action={mapped}
              disabled={props.locked}
              onClick={() => props.onRecovery(mapped)}
            >
              {label}
            </button>
          )
        })}
      </div>
    </section>
  )
}

export function MissionControlScreen(props: {
  readonly view: MissionControlView
  readonly connected: boolean
  readonly sending: boolean
  readonly error?: string
  readonly draft: string
  readonly armedRecovery?: string
  readonly onDraft: (value: string) => void
  readonly onSend: () => void
  readonly onApprove: (card: ApprovalCard) => void
  readonly onReject: (card: ApprovalCard) => void
  readonly onActivate?: (card: ActivationCard) => void
  readonly onAbandonActivation?: (card: ActivationCard) => void
  readonly onDeferActivation?: (card: ActivationCard) => void
  readonly deferredActivations?: readonly string[]
  readonly armedActivation?: string
  readonly armedAbandonment?: string
  readonly pane?: WorkspacePane
  readonly onNavigate?: (pane: WorkspacePane) => void
  readonly confirmingSession?: string
  readonly onCreateConversation?: () => void
  readonly onSwitchConversation?: (id: string) => void
  readonly onRenameConversation?: (id: string, title: string) => void
  readonly onArchiveConversation?: (id: string) => void
  readonly onRestoreConversation?: (id: string) => void
  readonly onAskDeleteConversation?: (id: string) => void
  readonly onConfirmDeleteConversation?: (id: string) => void
  readonly inspectingExtension?: string
  readonly onInspectExtension?: (id: string) => void
  readonly confirmingPlugin?: string
  readonly onAskUninstall?: (plugin: UserPluginView) => void
  readonly onCancelUninstall?: () => void
  readonly onConfirmUninstall?: (plugin: UserPluginView) => void
  readonly deferredRollback?: boolean
  readonly armedRollback?: boolean
  readonly onAskRollback?: (card: RollbackCard) => void
  readonly onDeferRollback?: (card: RollbackCard) => void
  readonly onRecovery: (action: 'diagnostics' | 'rollback' | 'exit-safe-mode') => void
  readonly acknowledgement?: { readonly text: string }
  readonly onDismissAcknowledgement?: () => void
  readonly confirmingSkill?: string
  readonly armedSkill?: string
  readonly skillDependents?: { readonly id: string; readonly dependents: readonly string[] }
  readonly onSkillAction?: (action: 'approve' | 'reject' | 'activate' | 'disable' | 'reactivate' | 'uninstall' | 'rollback', skill?: SkillProjection) => void
  readonly onPickSkill?: (skill: SkillProjection) => void
}) {
  const { view } = props
  const safe = view.systemState === 'SAFE_MODE' || view.systemState === 'RECOVERY'
  const locked = !props.connected
  const pane = props.pane ?? 'today'
  const [compactSurface, setCompactSurface] = useState<CompactSurface>('conversation')
  const navigate = (next: WorkspacePane) => {
    props.onNavigate?.(next)
    setCompactSurface('conversation')
  }
  const openOperations = () => {
    setCompactSurface('operations')
    globalThis.setTimeout(() => globalThis.document?.getElementById('capabilities')?.scrollIntoView({ block: 'start' }), 0)
  }
  return (
    <div className="chassis" data-shuttle-variant="A">
    <div className="console" data-system-state={view.systemState} data-connected={props.connected ? 'yes' : 'no'}>
      <SystemHeader
        identity={view.identity}
        systemState={view.systemState}
        objective={view.objective?.text}
        connected={props.connected}
        runtimeContext={view.runtimeContext}
      />
      {!props.connected ? <p className="transport" role="status">Disconnected from local runtime</p> : null}
      {props.acknowledgement ? (
        <div className="acknowledgement" role="status" data-acknowledgement-region="toast" data-acknowledgement="true">
          <span>{props.acknowledgement.text}</span>
          <button type="button" className="button button--secondary" data-acknowledgement-dismiss="true" onClick={() => props.onDismissAcknowledgement?.()}>Dismiss</button>
        </div>
      ) : null}
      {safe && view.recovery ? (
        <RecoveryPanel
          systemState={view.systemState}
          recovery={view.recovery}
          locked={locked}
          armedRecovery={props.armedRecovery}
          error={props.error}
          onRecovery={props.onRecovery}
        />
      ) : null}
      <nav className="compact-workspace-nav" aria-label="Compact workspace">
        <button type="button" className={compactSurface === 'navigation' ? 'is-active' : ''} aria-pressed={compactSurface === 'navigation'} onClick={() => setCompactSurface('navigation')}>
          <span className="control-lamp" aria-hidden="true" /><Glyph name="conversations" /><span>Navigate</span>
        </button>
        <button type="button" className={compactSurface === 'conversation' ? 'is-active' : ''} aria-pressed={compactSurface === 'conversation'} onClick={() => setCompactSurface('conversation')}>
          <span className="control-lamp" aria-hidden="true" /><Glyph name="today" /><span>Workspace</span>
        </button>
        <button type="button" className={compactSurface === 'operations' ? 'is-active' : ''} aria-pressed={compactSurface === 'operations'} onClick={() => setCompactSurface('operations')}>
          <span className="control-lamp" aria-hidden="true" /><Glyph name="capabilities" /><span>Status</span>
        </button>
      </nav>
      <div className="workspace-grid" data-compact-surface={compactSurface}>
        <WorkspaceNavigation
          view={view}
          pane={pane}
          actions={{
            navigate,
            openOperations,
            createConversation: props.onCreateConversation,
            switchConversation: props.onSwitchConversation,
          }}
        />
        {pane === 'extensions' ? (
          <ExtensionsWorkspace
            view={view}
            state={{
              locked,
              inspecting: props.inspectingExtension,
              confirmingPlugin: props.confirmingPlugin,
              armedActivation: props.armedActivation,
              armedAbandonment: props.armedAbandonment,
              confirmingSkill: props.confirmingSkill,
              armedSkill: props.armedSkill,
              skillDependents: props.skillDependents,
            }}
            actions={{
              inspect: props.onInspectExtension ?? (() => {}),
              approve: props.onApprove,
              reject: props.onReject,
              activate: props.onActivate,
              abandonActivation: props.onAbandonActivation,
              askUninstall: props.onAskUninstall,
              cancelUninstall: props.onCancelUninstall,
              confirmUninstall: props.onConfirmUninstall,
              skill: props.onSkillAction ?? (() => {}),
            }}
          />
        ) : pane === 'memory' ? (
          <MemoryWorkspace
            view={view}
            confirmingSession={props.confirmingSession}
            actions={{
              create: props.onCreateConversation,
              open: (id) => {
                props.onSwitchConversation?.(id)
                navigate('today')
              },
              rename: props.onRenameConversation,
              archive: props.onArchiveConversation,
              restore: props.onRestoreConversation,
              askDelete: props.onAskDeleteConversation,
              confirmDelete: props.onConfirmDeleteConversation,
            }}
          />
        ) : (
        <ConversationWorkspace
          view={view}
          state={{
            connected: props.connected,
            sending: props.sending,
            draft: props.draft,
            error: props.error,
            activations: (view.activations ?? []).filter((card) => !(props.deferredActivations ?? []).includes(card.id)),
            armedActivation: props.armedActivation,
            armedAbandonment: props.armedAbandonment,
            rollback: view.rollback,
            deferredRollback: props.deferredRollback,
            armedRollback: props.armedRollback,
          }}
          actions={{
            draft: props.onDraft,
            send: props.onSend,
            approve: props.onApprove,
            reject: props.onReject,
            activate: props.onActivate ?? (() => {}),
            abandonActivation: props.onAbandonActivation ?? (() => {}),
            deferActivation: props.onDeferActivation ?? (() => {}),
            pickSkill: props.onPickSkill,
            askRollback: props.onAskRollback,
            deferRollback: props.onDeferRollback,
          }}
        />
        )}
        <OperationsPanel
          view={view}
          connected={props.connected}
          confirmingPlugin={props.confirmingPlugin}
          actions={{
            askUninstall: props.onAskUninstall,
            cancelUninstall: props.onCancelUninstall,
            confirmUninstall: props.onConfirmUninstall,
            openExtensions: () => navigate('extensions'),
          }}
        />
      </div>
      <ControlStripView view={view} connected={props.connected} />
    </div>
    </div>
  )
}

export function App() {
  const [envelope, setEnvelope] = useState<UiEnvelope | undefined>()
  const [connected, setConnected] = useState(false)
  const [sending, setSending] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string>()
  const [governanceInteraction, setGovernanceInteraction] = useState(EMPTY_GOVERNANCE_INTERACTION)
  const [confirmingPlugin, setConfirmingPlugin] = useState<string>()
  const [pane, setPane] = useState<WorkspacePane>(paneFromHash)
  const [confirmingSession, setConfirmingSession] = useState<string>()
  const [inspectingExtension, setInspectingExtension] = useState<string>()
  const [skillInteraction, setSkillInteraction] = useState(EMPTY_SKILL_INTERACTION)
  const [acknowledgement, setAcknowledgement] = useState<{ readonly text: string }>()

  useEffect(() => {
    const sync = () => { setPane(paneFromHash()) }
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
      globalThis.location.hash = next
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
