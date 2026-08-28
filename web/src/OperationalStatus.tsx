import React from 'react'
import type { MissionControlView, UserCapabilityStatus, UserPluginView, WorkbenchProjection } from '../../src/domain/workspace/types'
import { PluginLifecycleControl } from './ExtensionsWorkspace'
import { PlateRivets } from './Faceplate'
import { Glyph } from './icons'
import { formatDiff } from './missionControlPresentation'

export interface OperationsActions {
  readonly askUninstall?: (plugin: UserPluginView) => void
  readonly cancelUninstall?: () => void
  readonly confirmUninstall?: (plugin: UserPluginView) => void
  readonly openExtensions?: () => void
}

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
  return ''
}

function WorkbenchPanel(props: { readonly candidates: readonly WorkbenchProjection[] }) {
  if (props.candidates.length === 0) return null
  return (
    <section className="workbench-section" data-workbench="true" aria-labelledby="workbench-title">
      <h2 id="workbench-title">CANDIDATE WORKBENCH</h2>
      <ul className="workbench-list">
        {props.candidates.map((item) => (
          <li key={item.id} className="workbench-item" data-candidate-id={item.id} data-can-request={item.canRequestApproval ? 'yes' : 'no'} data-review-state={item.reviewState ?? 'not-reviewed'}>
            <div className="workbench-identity">{item.owner}@{item.version}</div>
            <div className="workbench-meta">{item.resolutionKind ?? 'unresolved'} {item.resolutionCapability ?? ''}</div>
            <div className="workbench-meta" data-current-step={item.currentStep ?? 'author'}>step {item.currentStep ?? item.lifecycle}{item.parentId ? ` · repair of ${item.parentId}` : ''}{item.leftover ? ' · leftover repair' : ''}</div>
            <div className="workbench-meta">validation {item.validationPassed === true ? 'passed' : item.validationFailureSummary || item.validationFailed?.join(', ') || item.lifecycle}</div>
            <div className="workbench-meta">review {item.reviewState ?? 'not-reviewed'}{item.blockingFindings ? ` · ${item.blockingFindings} blockers` : ''}{item.blockerClaims?.length ? ` (${item.blockerClaims.join(', ')})` : ''}</div>
            <div className="workbench-meta" data-review-state={item.reviewState ?? 'not-reviewed'}>reviewState {item.reviewState ?? 'not-reviewed'}</div>
            <div className="workbench-meta" data-governance-approval={item.governanceApproval ?? 'none'}>governanceApproval {item.governanceApproval ?? 'none'}</div>
            <div className="workbench-meta" data-activation-state={item.activationState ?? 'inactive'}>activationState {item.activationState ?? 'inactive'}{item.activationFailureSummary ? ` · ${item.activationFailureSummary}` : ''}</div>
            <div className="workbench-meta" data-approval-state={item.approvalState ?? 'not-ready'} data-extension-lifecycle={item.extensionLifecycle ?? 'APPROVAL_REQUIRED'}>
              {item.extensionLifecycle === 'ACTIVE' ? 'approved and active' : item.extensionLifecycle === 'APPROVED_NOT_ACTIVE' ? 'approved, not active' : item.extensionLifecycle === 'ACTIVATING' ? 'activating' : item.extensionLifecycle === 'ACTIVATION_FAILED' ? 'activation failed' : item.extensionLifecycle === 'DISABLED_REACTIVATABLE' ? 'disabled, reactivatable' : item.extensionLifecycle === 'DISABLED_BLOCKED' ? 'disabled, blocked' : item.extensionLifecycle === 'SUPERSEDED' ? 'superseded' : item.approvalState === 'approval-requested' || item.canRequestApproval ? 'ready for approval' : 'not ready for approval'}
            </div>
            <div className="workbench-diff">capabilities {formatDiff(item.diff?.capabilities.added ?? [], item.diff?.capabilities.removed ?? [], item.diff?.capabilities.changed ?? [])}</div>
            <div className="workbench-diff">permissions {formatDiff(item.diff?.permissions.added ?? [], item.diff?.permissions.removed ?? [], item.diff?.permissions.changed ?? [])}</div>
            <div className="workbench-diff">effects {item.effectSummary?.length ? item.effectSummary.join('; ') : 'none'}</div>
            <div className="workbench-request" data-can-request={item.canRequestApproval ? 'yes' : 'no'}>{item.canRequestApproval ? 'can request approval' : `cannot request${item.requestDenials?.length ? `: ${item.requestDenials.join(', ')}` : ''}`}</div>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function OperationsPanel(props: {
  readonly view: MissionControlView
  readonly connected: boolean
  readonly confirmingPlugin?: string
  readonly actions: OperationsActions
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
        <div className="ops-section-heading"><h2 id="ops-overview-title">OPERATIONS</h2><span className={`status-lamp status-lamp--${lampModifier(props.view.systemState, props.connected)}`} aria-hidden="true" /></div>
        <strong className="ops-mode">{props.view.systemState.replaceAll('_', ' ')}</strong>
        <p className="ops-detail">{props.connected ? degradation ?? 'ALL CORE SYSTEMS NOMINAL' : 'CONTROL LINK OFFLINE'}</p>
        <div className="ops-counters" aria-label="Operational counters">
          <span><small>APPROVALS</small><strong className={pendingApprovals > 0 ? 'amber' : undefined}>{pendingApprovals}</strong></span>
          <span><small>JOBS</small><strong>{props.view.controlStrip.backgroundJobs}</strong></span>
        </div>
        {pendingApprovals > 0 ? <p className="ops-alert"><Glyph name="warn" /> HUMAN DECISION REQUIRED</p> : null}
      </section>
      <WorkbenchPanel candidates={props.view.candidates ?? []} />
      <section className="capability-section" id="capabilities" aria-labelledby="capability-title">
        <div className="ops-section-heading capability-heading"><h2 id="capability-title">CAPABILITIES</h2><span>{props.view.capabilities.length} CHANNELS</span></div>
        <div className="capability-summary" aria-label="Capability summary">
          <span data-capability-state="active"><strong>{activeCapabilities}</strong> ACTIVE</span>
          <span data-capability-state="governed"><strong>{governedCapabilities}</strong> GOVERNED</span>
          <span data-capability-state="unavailable"><strong>{unavailableCapabilities}</strong> INOP</span>
        </div>
        <dl className="capability-list">
          {(props.view.plugins ?? []).map((plugin) => <PluginLifecycleControl key={plugin.id} plugin={plugin} locked={!props.connected} confirming={props.confirmingPlugin === plugin.id} actions={props.actions} />)}
          {props.view.capabilities.map((item) => (
            <div key={`${item.area}-${item.action}`}><dt><span className="capability-area">{item.area}</span><span className="capability-action">{item.action}</span></dt><dd data-status={item.status} data-capability-state={capabilitySignal(item.status)}>{item.status === 'approval-required' ? 'CONFIRM' : item.status === 'not-connected' ? 'NOT LINKED' : item.status === 'safe-mode-disabled' ? 'SAFE OFF' : item.status === 'unavailable' ? 'INOP' : 'ACTIVE'}</dd></div>
          ))}
        </dl>
      </section>
      <section className="activity-section activity-section--recent" aria-labelledby="activity-title">
        <div className="ops-section-heading"><h2 id="activity-title">RECENT EVENTS</h2><span>LAST {recentActivity.length}</span></div>
        {recentActivity.length === 0 ? <p className="ops-empty">NO RECENT EVENTS</p> : <ol className="activity-list">{recentActivity.map((item) => <li key={item.id} className={`activity-item${activityModifier(item.kind)}`} data-activity={item.kind}><span className="activity-node">{item.kind === 'APPROVAL_REQUIRED' ? <Glyph name="warn" /> : null}</span><span>{item.kind.replaceAll('_', ' ')}</span><span className="activity-summary">{item.summary}</span></li>)}</ol>}
        {(props.view.approvalResolutions ?? []).length > 0 ? <ul className="ops-decisions" data-actions-history="true" aria-label="Recent human decisions">{(props.view.approvalResolutions ?? []).slice(-3).reverse().map((item) => <li key={item.confirmationId} data-approval-resolution={item.confirmationId} data-approval-outcome={item.outcome}><span>{item.capability ?? 'action'}.{item.operation ?? item.decision}</span><strong>{item.decision.toUpperCase()}</strong></li>)}</ul> : null}
      </section>
      <div className="ops-footer"><span><strong>{(props.view.extensions ?? []).length}</strong> USER EXTENSIONS</span><button type="button" className="button button--secondary" data-open-extensions="true" onClick={props.actions.openExtensions}>OPEN</button></div>
    </aside>
  )
}

export function ControlStripView(props: { readonly view: MissionControlView; readonly connected: boolean }) {
  const strip = props.view.controlStrip
  const safe = props.view.systemState === 'SAFE_MODE' || props.view.systemState === 'RECOVERY'
  return (
    <footer className="faceplate control-strip" aria-label="Runtime status" data-control-plane="user-workspace">
      <PlateRivets />
      <div className="control-strip-row">
        <div><Glyph name="chip" /><span className="strip-copy"><span className="strip-label">MODE</span><strong>{strip.mode}</strong>{strip.degradation ? <span className="sr-only">{strip.degradation}</span> : null}</span></div>
        <div><Glyph name="shield" /><span className="strip-copy"><span className="strip-label">SAFE MODE</span><strong>{safe ? 'ON' : 'OFF'}</strong></span></div>
        <div><Glyph name="check" /><span className="strip-copy"><span className="strip-label">APPROVALS</span><strong className={strip.pendingApprovals > 0 ? 'amber' : undefined}>{strip.pendingApprovals}</strong></span></div>
        <div><Glyph name="terminal" /><span className="strip-copy"><span className="strip-label">{props.connected ? 'LOCAL' : 'TRANSPORT'}</span><strong>{props.connected ? '127.0.0.1' : 'DISCONNECTED'}</strong>{strip.backgroundJobs > 0 ? <span className="sr-only">JOBS {strip.backgroundJobs}</span> : null}</span></div>
      </div>
    </footer>
  )
}
