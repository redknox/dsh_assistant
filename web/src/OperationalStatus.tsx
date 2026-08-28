import React from 'react'
import type { MissionControlView, UserCapabilityStatus, UserPluginView, WorkbenchProjection } from '../../src/domain/workspace/types'
import { PluginLifecycleControl } from './ExtensionsWorkspace'
import { LiveExecutionLog } from './ExecutionLogWorkspace'
import { PlateRivets } from './Faceplate'
import { Glyph } from './icons'
import { formatDiff } from './missionControlPresentation'

export interface OperationsActions {
  readonly askUninstall?: (plugin: UserPluginView) => void
  readonly cancelUninstall?: () => void
  readonly confirmUninstall?: (plugin: UserPluginView) => void
  readonly openExtensions?: () => void
  readonly openLogs?: () => void
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

function capabilityLabel(status: UserCapabilityStatus): string {
  if (status === 'active') return 'READY'
  if (status === 'approval-required') return 'CONFIRM TO USE'
  if (status === 'not-connected') return 'NOT CONNECTED'
  if (status === 'safe-mode-disabled') return 'SAFE MODE OFF'
  return 'UNAVAILABLE'
}

function lifecycleLabel(item: WorkbenchProjection): string {
  if (item.extensionLifecycle === 'ACTIVE') return 'ACTIVE'
  if (item.extensionLifecycle === 'APPROVED_NOT_ACTIVE') return 'READY TO ACTIVATE'
  if (item.extensionLifecycle === 'ACTIVATING') return 'ACTIVATING'
  if (item.extensionLifecycle === 'ACTIVATION_FAILED') return 'ACTIVATION FAILED'
  if (item.extensionLifecycle === 'DISABLED_REACTIVATABLE') return 'DISABLED'
  if (item.extensionLifecycle === 'DISABLED_BLOCKED') return 'BLOCKED'
  if (item.extensionLifecycle === 'SUPERSEDED') return 'SUPERSEDED'
  if (item.approvalState === 'approval-requested') return 'AWAITING APPROVAL'
  if (item.canRequestApproval) return 'READY FOR APPROVAL'
  return 'IN REVIEW'
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  const rightParts = right.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function partitionCandidates(candidates: readonly WorkbenchProjection[]): {
  readonly current: readonly WorkbenchProjection[]
  readonly history: readonly WorkbenchProjection[]
} {
  const latestByOwner = new Map<string, WorkbenchProjection>()
  for (const item of candidates) {
    const previous = latestByOwner.get(item.owner)
    if (!previous || compareVersions(item.version, previous.version) > 0) latestByOwner.set(item.owner, item)
  }
  const current = [...latestByOwner.values()].filter((item) => item.extensionLifecycle !== 'SUPERSEDED')
  const currentIds = new Set(current.map((item) => item.id))
  return { current, history: candidates.filter((item) => !currentIds.has(item.id)) }
}

function CandidateSummary(props: { readonly item: WorkbenchProjection; readonly historical?: boolean }) {
  const item = props.item
  return (
    <li className="workbench-item" data-candidate-id={item.id} data-can-request={item.canRequestApproval ? 'yes' : 'no'} data-review-state={item.reviewState ?? 'not-reviewed'}>
      <div className="workbench-title-row">
        <span className="workbench-identity">{item.owner}@{item.version}</span>
        <strong className="workbench-state" data-extension-lifecycle={item.extensionLifecycle ?? 'APPROVAL_REQUIRED'}>{lifecycleLabel(item)}</strong>
      </div>
      {!props.historical ? <>
        <div className="workbench-checks">
          <span data-check={item.validationPassed === true ? 'passed' : 'pending'}>VALIDATION {item.validationPassed === true ? 'PASS' : 'PENDING'}</span>
          <span data-check={item.reviewState === 'review-complete' ? 'passed' : 'pending'}>REVIEW {item.reviewState === 'review-complete' ? 'COMPLETE' : 'PENDING'}</span>
        </div>
        {item.activationFailureSummary ? <div className="workbench-warning">{item.activationFailureSummary}</div> : null}
        <div className="workbench-meta" data-current-step={item.currentStep ?? 'author'}>CURRENT STEP · {(item.currentStep ?? item.lifecycle).replaceAll('-', ' ').toUpperCase()}</div>
        <div className="workbench-diff">CAPABILITIES · {formatDiff(item.diff?.capabilities.added ?? [], item.diff?.capabilities.removed ?? [], item.diff?.capabilities.changed ?? [])}</div>
        {item.canRequestApproval && (!item.extensionLifecycle || item.extensionLifecycle === 'APPROVAL_REQUIRED') ? <div className="workbench-request">HUMAN APPROVAL AVAILABLE</div> : null}
      </> : null}
    </li>
  )
}

function WorkbenchPanel(props: { readonly candidates: readonly WorkbenchProjection[] }) {
  if (props.candidates.length === 0) return null
  const { current, history } = partitionCandidates(props.candidates)
  return (
    <section className="workbench-section" data-workbench="true" aria-labelledby="workbench-title">
      <div className="ops-section-heading"><h2 id="workbench-title">EXTENSION PIPELINE</h2><span>{current.length} CURRENT</span></div>
      {current.length > 0 ? <ul className="workbench-list">{current.map((item) => <CandidateSummary key={item.id} item={item} />)}</ul> : <p className="ops-empty">NO EXTENSION WORK IN PROGRESS</p>}
      {history.length > 0 ? <details className="workbench-history"><summary>PAST CANDIDATES <span>{history.length}</span></summary><ul className="workbench-list">{history.map((item) => <CandidateSummary key={item.id} item={item} historical />)}</ul></details> : null}
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
  const degradation = props.view.controlStrip.degradation
  const pendingApprovals = props.view.controlStrip.pendingApprovals
  const currentCandidates = partitionCandidates(props.view.candidates ?? []).current
  const failedCandidates = currentCandidates.filter((item) => item.extensionLifecycle === 'ACTIVATION_FAILED').length
  const systemNeedsAttention = ['SAFE_MODE', 'RECOVERY', 'DEGRADED', 'BLOCKED', 'FAULT'].includes(props.view.systemState)
  const attentionCount = pendingApprovals + unavailableCapabilities + failedCandidates + (props.connected ? 0 : 1) + (systemNeedsAttention ? 1 : 0)
  const activeExtensions = (props.view.extensions ?? []).filter((item) => item.lifecycle === 'ACTIVE').length
  return (
    <aside className="ops-panel instrument-panel" id="activity" aria-label="Operational state">
      <div className="panel-code"><span>OPS 04</span><span>LIVE STATUS</span></div>
      <section className="attention-section" aria-labelledby="attention-title" data-attention={attentionCount > 0 ? 'required' : 'clear'}>
        <div className="ops-section-heading"><h2 id="attention-title">ATTENTION</h2><span className={`status-lamp status-lamp--${attentionCount > 0 ? 'approval' : 'ready'}`} aria-hidden="true" /></div>
        <strong>{attentionCount > 0 ? `${attentionCount} ITEM${attentionCount === 1 ? '' : 'S'} NEED REVIEW` : 'NO ACTION REQUIRED'}</strong>
        {pendingApprovals > 0 ? <p><Glyph name="warn" /> {pendingApprovals} APPROVAL{pendingApprovals === 1 ? '' : 'S'} WAITING</p> : null}
        {systemNeedsAttention ? <p><Glyph name="warn" /> SYSTEM MODE · {props.view.systemState.replaceAll('_', ' ')}</p> : null}
        {!props.connected ? <p><Glyph name="warn" /> CONTROL LINK OFFLINE</p> : null}
        {unavailableCapabilities > 0 ? <p><Glyph name="warn" /> {unavailableCapabilities} CAPABILIT{unavailableCapabilities === 1 ? 'Y' : 'IES'} UNAVAILABLE</p> : null}
        {failedCandidates > 0 ? <p><Glyph name="warn" /> {failedCandidates} ACTIVATION FAILURE{failedCandidates === 1 ? '' : 'S'}</p> : null}
      </section>
      <section className="ops-overview" aria-labelledby="ops-overview-title">
        <div className="ops-section-heading"><h2 id="ops-overview-title">SYSTEM HEALTH</h2><span className={`status-lamp status-lamp--${lampModifier(props.view.systemState, props.connected)}`} aria-hidden="true" /></div>
        <strong className="ops-mode">{props.view.systemState.replaceAll('_', ' ')}</strong>
        <p className="ops-detail">{props.connected ? degradation ?? props.view.recovery?.why ?? 'ALL CORE SYSTEMS NOMINAL' : 'CONTROL LINK OFFLINE'}</p>
        <div className="ops-counters" aria-label="Operational counters">
          <span><small>APPROVALS</small><strong className={pendingApprovals > 0 ? 'amber' : undefined}>{pendingApprovals}</strong></span>
          <span><small>JOBS</small><strong>{props.view.controlStrip.backgroundJobs}</strong></span>
        </div>
      </section>
      <section className="capability-section" id="capabilities" aria-labelledby="capability-title">
        <div className="ops-section-heading capability-heading"><h2 id="capability-title">CONNECTED CAPABILITIES</h2><span>{props.view.capabilities.length} CHANNELS</span></div>
        <div className="capability-summary" aria-label="Capability summary">
          <span data-capability-state="active"><strong>{activeCapabilities}</strong> READY</span>
          <span data-capability-state="governed"><strong>{governedCapabilities}</strong> CONFIRM</span>
          <span data-capability-state="unavailable"><strong>{unavailableCapabilities}</strong> UNAVAILABLE</span>
        </div>
        <dl className="capability-list">
          {(props.view.plugins ?? []).map((plugin) => <PluginLifecycleControl key={plugin.id} plugin={plugin} locked={!props.connected} confirming={props.confirmingPlugin === plugin.id} actions={props.actions} />)}
          {props.view.capabilities.map((item) => (
            <div key={`${item.area}-${item.action}`}><dt><span className="capability-area">{item.area}{item.advanced?.provider && item.advanced.provider !== 'fake' ? <small>{item.advanced.provider}</small> : null}</span><span className="capability-action">{item.action}</span></dt><dd data-status={item.status} data-capability-state={capabilitySignal(item.status)}>{capabilityLabel(item.status)}</dd></div>
          ))}
        </dl>
      </section>
      <WorkbenchPanel candidates={props.view.candidates ?? []} />
      <LiveExecutionLog entries={props.view.executionLog ?? []} open={props.actions.openLogs ?? (() => {})} />
      {(props.view.approvalResolutions ?? []).length > 0 ? (
        <ul className="ops-decisions" data-actions-history="true" aria-label="Recent human decisions">
          {(props.view.approvalResolutions ?? []).slice(-3).reverse().map((item) => (
            <li key={item.confirmationId} data-approval-resolution={item.confirmationId} data-approval-outcome={item.outcome}>
              <span>{item.capability ?? 'action'}.{item.operation ?? item.decision}</span>
              <strong>{item.decision.toUpperCase()}</strong>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="ops-footer"><span><strong>{activeExtensions}</strong> ACTIVE · {(props.view.extensions ?? []).length} EXTENSION RECORDS</span><button type="button" className="button button--secondary" data-open-extensions="true" onClick={props.actions.openExtensions}>MANAGE</button></div>
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
