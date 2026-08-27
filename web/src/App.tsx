import React, { useEffect, useMemo, useState } from 'react'
import type { ActivationCard, ApprovalCard, MissionControlView, RollbackCard, SkillProjection, UserCapabilityStatus, UserPluginView, WorkbenchProjection } from '../../src/domain/workspace/types'
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
import { ExtensionsWorkspace, PluginLifecycleControl } from './ExtensionsWorkspace'
import { MemoryWorkspace } from './MemoryWorkspace'
import { formatDiff, isPendingApproval, skillInvocationSurfaceOpen } from './missionControlPresentation'
import { WorkspaceNavigation, type WorkspacePane } from './WorkspaceNavigation'

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

function capabilitySignal(status: UserCapabilityStatus): 'active' | 'governed' | 'unavailable' {
  if (status === 'active') return 'active'
  if (status === 'approval-required') return 'governed'
  return 'unavailable'
}

function activityModifier(kind: string): string {
  if (kind === 'APPROVAL_REQUIRED') return ' activity-item--approval'
  if (kind === 'COMPLETED' || kind === 'RECOVERED') return ' activity-item--done'
  if (kind === 'BLOCKED' || kind === 'FAILED') return ' activity-item--fault'
  if (kind === 'WAITING' || kind === 'PLANNED') return ''
  return ''
}

type CompactSurface = 'conversation' | 'navigation' | 'operations'

function paneFromHash(): WorkspacePane {
  if (globalThis.location?.hash === '#extensions') return 'extensions'
  if (globalThis.location?.hash === '#conversations') return 'memory'
  if (globalThis.location?.hash === '#memory') return 'memory'
  return 'today'
}

function PlateRivets() {
  return (
    <>
      <span className="rivet rivet--tl" aria-hidden="true" />
      <span className="rivet rivet--tr" aria-hidden="true" />
      <span className="rivet rivet--bl" aria-hidden="true" />
      <span className="rivet rivet--br" aria-hidden="true" />
    </>
  )
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

function OperationsPanel(props: {
  readonly view: MissionControlView
  readonly locked?: boolean
  readonly confirmingPlugin?: string
  readonly onAskUninstall?: (plugin: UserPluginView) => void
  readonly onCancelUninstall?: () => void
  readonly onConfirmUninstall?: (plugin: UserPluginView) => void
  readonly onOpenExtensions?: () => void
}) {
  const activeCapabilities = props.view.capabilities.filter((item) => item.status === 'active').length
  const governedCapabilities = props.view.capabilities.filter((item) => item.status === 'approval-required').length
  const unavailableCapabilities = props.view.capabilities.length - activeCapabilities - governedCapabilities
  const recentActivity = props.view.activity.slice(-3).reverse()
  const degradation = props.view.controlStrip.degradation
  const pendingApprovals = props.view.controlStrip.pendingApprovals
  return (
    <aside className="ops-panel instrument-panel" id="activity" aria-label="Operational state">
      <div className="panel-code"><span>OPS 04</span><span>LIVE STATUS</span></div>
      <section className="ops-overview" aria-labelledby="ops-overview-title">
        <div className="ops-section-heading">
          <h2 id="ops-overview-title">OPERATIONS</h2>
          <span className={`status-lamp status-lamp--${lampModifier(props.view.systemState, props.locked !== true)}`} aria-hidden="true" />
        </div>
        <strong className="ops-mode">{props.view.systemState.replaceAll('_', ' ')}</strong>
        <p className="ops-detail">{props.locked ? 'CONTROL LINK OFFLINE' : degradation ?? 'ALL CORE SYSTEMS NOMINAL'}</p>
        <div className="ops-counters" aria-label="Operational counters">
          <span><small>APPROVALS</small><strong className={pendingApprovals > 0 ? 'amber' : undefined}>{pendingApprovals}</strong></span>
          <span><small>JOBS</small><strong>{props.view.controlStrip.backgroundJobs}</strong></span>
        </div>
        {pendingApprovals > 0 ? <p className="ops-alert"><Glyph name="warn" /> HUMAN DECISION REQUIRED</p> : null}
      </section>
      <WorkbenchPanel candidates={props.view.candidates ?? []} />
      <section className="capability-section" id="capabilities" aria-labelledby="capability-title">
        <div className="ops-section-heading capability-heading">
          <h2 id="capability-title">CAPABILITIES</h2>
          <span>{props.view.capabilities.length} CHANNELS</span>
        </div>
        <div className="capability-summary" aria-label="Capability summary">
          <span data-capability-state="active"><strong>{activeCapabilities}</strong> ACTIVE</span>
          <span data-capability-state="governed"><strong>{governedCapabilities}</strong> GOVERNED</span>
          <span data-capability-state="unavailable"><strong>{unavailableCapabilities}</strong> INOP</span>
        </div>
        <dl className="capability-list">
          {(props.view.plugins ?? []).map((plugin) => (
            <PluginLifecycleControl
              key={plugin.id}
              plugin={plugin}
              locked={props.locked === true}
              confirming={props.confirmingPlugin === plugin.id}
              actions={{
                askUninstall: props.onAskUninstall,
                cancelUninstall: props.onCancelUninstall,
                confirmUninstall: props.onConfirmUninstall,
              }}
            />
          ))}
          {props.view.capabilities.map((item) => (
            <div key={`${item.area}-${item.action}`}>
              <dt>
                <span className="capability-area">{item.area}</span>
                <span className="capability-action">{item.action}</span>
              </dt>
              <dd data-status={item.status} data-capability-state={capabilitySignal(item.status)}>
                {item.status === 'approval-required' ? 'APPROVAL'
                  : item.status === 'safe-mode-disabled' ? 'SAFE OFF'
                    : item.status === 'unavailable' ? 'INOP' : 'ACTIVE'}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="activity-section activity-section--recent" aria-labelledby="activity-title">
        <div className="ops-section-heading">
          <h2 id="activity-title">RECENT EVENTS</h2>
          <span>LAST {recentActivity.length}</span>
        </div>
        {recentActivity.length === 0 ? <p className="ops-empty">NO RECENT EVENTS</p> : (
          <ol className="activity-list">
            {recentActivity.map((item) => (
              <li key={item.id} className={`activity-item${activityModifier(item.kind)}`} data-activity={item.kind}>
                <span className="activity-node">{item.kind === 'APPROVAL_REQUIRED' ? <Glyph name="warn" /> : null}</span>
                <span>{item.kind.replaceAll('_', ' ')}</span>
                <span className="activity-summary">{item.summary}</span>
              </li>
            ))}
          </ol>
        )}
        {(props.view.approvalResolutions ?? []).length > 0 ? (
          <ul className="ops-decisions" data-actions-history="true" aria-label="Recent human decisions">
            {(props.view.approvalResolutions ?? []).slice(-3).reverse().map((item) => (
              <li
                key={item.confirmationId}
                data-approval-resolution={item.confirmationId}
                data-approval-outcome={item.outcome}
              >
                <span>{item.capability ?? 'action'}.{item.operation ?? item.decision}</span>
                <strong>{item.decision.toUpperCase()}</strong>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <div className="ops-footer">
        <span><strong>{(props.view.extensions ?? []).length}</strong> USER EXTENSIONS</span>
        <button type="button" className="button button--secondary" data-open-extensions="true" onClick={() => props.onOpenExtensions?.()}>OPEN</button>
      </div>
    </aside>
  )
}

function WorkbenchPanel(props: { readonly candidates: readonly WorkbenchProjection[] }) {
  if (props.candidates.length === 0) return null
  return (
    <section className="workbench-section" data-workbench="true" aria-labelledby="workbench-title">
      <h2 id="workbench-title">CANDIDATE WORKBENCH</h2>
      <ul className="workbench-list">
        {props.candidates.map((item) => (
          <li
            key={item.id}
            className="workbench-item"
            data-candidate-id={item.id}
            data-can-request={item.canRequestApproval ? 'yes' : 'no'}
            data-review-state={item.reviewState ?? 'not-reviewed'}
          >
            <div className="workbench-identity">{item.owner}@{item.version}</div>
            <div className="workbench-meta">
              {item.resolutionKind ?? 'unresolved'} {item.resolutionCapability ?? ''}
            </div>
            <div className="workbench-meta" data-current-step={item.currentStep ?? 'author'}>
              step {item.currentStep ?? item.lifecycle}
              {item.parentId ? ` · repair of ${item.parentId}` : ''}
              {item.leftover ? ' · leftover repair' : ''}
            </div>
            <div className="workbench-meta">
              validation {item.validationPassed === true ? 'passed' : item.validationFailureSummary || item.validationFailed?.join(', ') || item.lifecycle}
            </div>
            <div className="workbench-meta">
              review {item.reviewState ?? 'not-reviewed'}
              {item.blockingFindings ? ` · ${item.blockingFindings} blockers` : ''}
              {item.blockerClaims?.length ? ` (${item.blockerClaims.join(', ')})` : ''}
            </div>
            <div className="workbench-meta" data-review-state={item.reviewState ?? 'not-reviewed'}>
              reviewState {item.reviewState ?? 'not-reviewed'}
            </div>
            <div className="workbench-meta" data-governance-approval={item.governanceApproval ?? 'none'}>
              governanceApproval {item.governanceApproval ?? 'none'}
            </div>
            <div className="workbench-meta" data-activation-state={item.activationState ?? 'inactive'}>
              activationState {item.activationState ?? 'inactive'}
              {item.activationFailureSummary ? ` · ${item.activationFailureSummary}` : ''}
            </div>
            <div className="workbench-meta" data-approval-state={item.approvalState ?? 'not-ready'} data-extension-lifecycle={item.extensionLifecycle ?? 'APPROVAL_REQUIRED'}>
              {item.extensionLifecycle === 'ACTIVE' ? 'approved and active'
                : item.extensionLifecycle === 'APPROVED_NOT_ACTIVE' ? 'approved, not active'
                  : item.extensionLifecycle === 'ACTIVATING' ? 'activating'
                    : item.extensionLifecycle === 'ACTIVATION_FAILED' ? 'activation failed'
                      : item.extensionLifecycle === 'DISABLED_REACTIVATABLE' ? 'disabled, reactivatable'
                        : item.extensionLifecycle === 'DISABLED_BLOCKED' ? 'disabled, blocked'
                          : item.extensionLifecycle === 'SUPERSEDED' ? 'superseded'
                            : item.approvalState === 'approval-requested' || item.canRequestApproval ? 'ready for approval'
                              : 'not ready for approval'}
            </div>
            <div className="workbench-diff">
              capabilities {formatDiff(item.diff?.capabilities.added ?? [], item.diff?.capabilities.removed ?? [], item.diff?.capabilities.changed ?? [])}
            </div>
            <div className="workbench-diff">
              permissions {formatDiff(item.diff?.permissions.added ?? [], item.diff?.permissions.removed ?? [], item.diff?.permissions.changed ?? [])}
            </div>
            <div className="workbench-diff">
              effects {item.effectSummary?.length ? item.effectSummary.join('; ') : 'none'}
            </div>
            <div className="workbench-request" data-can-request={item.canRequestApproval ? 'yes' : 'no'}>
              {item.canRequestApproval ? 'can request approval' : `cannot request${item.requestDenials?.length ? `: ${item.requestDenials.join(', ')}` : ''}`}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function ControlStripView(props: {
  readonly view: MissionControlView
  readonly connected: boolean
}) {
  const strip = props.view.controlStrip
  const safe = props.view.systemState === 'SAFE_MODE' || props.view.systemState === 'RECOVERY'
  return (
    <footer className="faceplate control-strip" aria-label="Runtime status" data-control-plane="user-workspace">
      <PlateRivets />
      <div className="control-strip-row">
        <div>
          <Glyph name="chip" />
          <span className="strip-copy">
            <span className="strip-label">MODE</span>
            <strong>{strip.mode}</strong>
            {strip.degradation ? <span className="sr-only">{strip.degradation}</span> : null}
          </span>
        </div>
        <div>
          <Glyph name="shield" />
          <span className="strip-copy"><span className="strip-label">SAFE MODE</span><strong>{safe ? 'ON' : 'OFF'}</strong></span>
        </div>
        <div>
          <Glyph name="check" />
          <span className="strip-copy">
            <span className="strip-label">APPROVALS</span>
            <strong className={strip.pendingApprovals > 0 ? 'amber' : undefined}>{strip.pendingApprovals}</strong>
          </span>
        </div>
        <div>
          <Glyph name="terminal" />
          <span className="strip-copy">
            <span className="strip-label">{props.connected ? 'LOCAL' : 'TRANSPORT'}</span>
            <strong>{props.connected ? '127.0.0.1' : 'DISCONNECTED'}</strong>
            {strip.backgroundJobs > 0 ? <span className="sr-only">JOBS {strip.backgroundJobs}</span> : null}
          </span>
        </div>
      </div>
    </footer>
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
          locked={locked}
          confirmingPlugin={props.confirmingPlugin}
          onAskUninstall={props.onAskUninstall}
          onCancelUninstall={props.onCancelUninstall}
          onConfirmUninstall={props.onConfirmUninstall}
          onOpenExtensions={() => navigate('extensions')}
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
  const [armedRecovery, setArmedRecovery] = useState<string>()
  const [armedActivation, setArmedActivation] = useState<string>()
  const [armedAbandonment, setArmedAbandonment] = useState<string>()
  const [deferredActivations, setDeferredActivations] = useState<string[]>([])
  const [confirmingPlugin, setConfirmingPlugin] = useState<string>()
  const [deferredRollback, setDeferredRollback] = useState(false)
  const [armedRollback, setArmedRollback] = useState(false)
  const [pane, setPane] = useState<WorkspacePane>(paneFromHash)
  const [confirmingSession, setConfirmingSession] = useState<string>()
  const [inspectingExtension, setInspectingExtension] = useState<string>()
  const [confirmingSkill, setConfirmingSkill] = useState<string>()
  const [armedSkill, setArmedSkill] = useState<string>()
  const [skillDependents, setSkillDependents] = useState<{ readonly id: string; readonly dependents: readonly string[] }>()
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
      armedRecovery={armedRecovery}
      onDraft={setDraft}
      onSend={() => { void onSend() }}
      acknowledgement={acknowledgement}
      onDismissAcknowledgement={() => setAcknowledgement(undefined)}
      onApprove={(card) => { void act(() => decideApproval(card, 'approve')) }}
      onReject={(card) => { void act(() => decideApproval(card, 'deny')) }}
      deferredActivations={deferredActivations}
      armedActivation={armedActivation}
      armedAbandonment={armedAbandonment}
      onDeferActivation={(card) => {
        setDeferredActivations((current) => current.includes(card.id) ? current : [...current, card.id])
      }}
      onActivate={(card) => {
        if (armedActivation !== card.id) {
          setArmedAbandonment(undefined)
          setArmedActivation(card.id)
          return
        }
        setArmedActivation(undefined)
        void act(() => activateCandidate(card, true))
      }}
      onAbandonActivation={(card) => {
        if (armedAbandonment !== card.id) {
          setArmedActivation(undefined)
          setArmedAbandonment(card.id)
          return
        }
        setArmedAbandonment(undefined)
        void act(() => abandonCandidateActivation(card, true))
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
      confirmingSkill={confirmingSkill}
      armedSkill={armedSkill}
      skillDependents={skillDependents}
      onPickSkill={(skill) => {
        setDraft((current) => current.trim() === '' ? `Use the ${skill.name} skill.` : `${current.trim()} ${skill.name}`)
      }}
      onSkillAction={(action, skill) => {
        if (action === 'uninstall' || action === 'disable') {
          if (action === 'uninstall') {
            if (skill === undefined) {
              setConfirmingSkill(undefined)
              setSkillDependents(undefined)
              return
            }
            if (confirmingSkill !== skill.id) {
              setConfirmingSkill(skill.id)
              setSkillDependents(undefined)
              return
            }
          } else {
            if (skill === undefined) return
            const key = `disable:${skill.id}`
            if (armedSkill !== key && skillDependents?.id !== skill.id) {
              setArmedSkill(key)
              setSkillDependents(undefined)
              return
            }
            setArmedSkill(undefined)
          }
          void act(async () => {
            try {
              const next = await runSkillAction({
                action,
                skill,
                confirm: true,
                acknowledgeDependents: skillDependents?.id === skill.id,
                dependents: skillDependents?.id === skill.id ? skillDependents.dependents : [],
              })
              setConfirmingSkill(undefined)
              setSkillDependents(undefined)
              return next
            } catch (caught) {
              const error = caught as Error & { code?: string; dependents?: readonly string[] }
              if (error.code === 'dependents-required' && error.dependents && skill) {
                setSkillDependents({ id: skill.id, dependents: error.dependents })
                if (action === 'disable') setArmedSkill(`disable:${skill.id}`)
              }
              throw caught
            }
          })
          return
        }
        if (action === 'approve' || action === 'reject' || action === 'activate' || action === 'reactivate' || action === 'rollback') {
          const key = action === 'rollback' ? 'rollback' : `${action}:${skill?.id ?? ''}`
          if (armedSkill !== key) {
            setArmedSkill(key)
            return
          }
          setArmedSkill(undefined)
          void act(() => runSkillAction({
            action,
            skill,
            confirm: true,
            rollback: empty.skillRollback,
          }))
          return
        }
      }}
      confirmingPlugin={confirmingPlugin}
      onAskUninstall={(plugin) => { setConfirmingPlugin(plugin.id) }}
      onCancelUninstall={() => { setConfirmingPlugin(undefined) }}
      onConfirmUninstall={(plugin) => {
        setConfirmingPlugin(undefined)
        void act(() => uninstallPlugin(plugin, true))
      }}
      deferredRollback={deferredRollback}
      armedRollback={armedRollback}
      onDeferRollback={() => {
        setArmedRollback(false)
        setDeferredRollback(true)
      }}
      onAskRollback={(card) => {
        if (!armedRollback) {
          setArmedRollback(true)
          return
        }
        setArmedRollback(false)
        void act(() => rollbackSystemState(card, true))
      }}
      onRecovery={(action) => {
        if (action !== 'diagnostics' && armedRecovery !== action) {
          setArmedRecovery(action)
          return
        }
        setArmedRecovery(undefined)
        void act(() => runRecovery(action, true))
      }}
    />
  )
}
