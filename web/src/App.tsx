import React, { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { ActivationCard, ApprovalCard, MissionControlView, UserCapabilityStatus, WorkObjectKind, WorkbenchProjection } from '../../src/domain/workspace/types'
import {
  activateCandidate,
  decideApproval,
  establishSession,
  fetchView,
  formatMarkdownLite,
  openViewStream,
  recoveryActionId,
  runRecovery,
  sendMessage,
  type UiEnvelope,
} from './api'
import { Glyph } from './icons'

function isPendingApproval(status: string): boolean {
  return status === 'pending' || status === 'approval-requested' || status === 'unreviewed'
}

function isUserMessage(kind: WorkObjectKind): boolean {
  return kind === 'user-message'
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
  if (kind === 'WAITING' || kind === 'PLANNED') return ''
  return ''
}

function previewText(text: string, limit = 72): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact
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
}) {
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
    </header>
  )
}

function WorkspaceNavigation(props: { readonly view: MissionControlView }) {
  const recentMemory = props.view.memory.slice(0, 8)
  const recentKnowledge = props.view.knowledge.slice(0, 4)
  const current = [...props.view.conversation].reverse().find((item) => isUserMessage(item.kind))
    ?? props.view.conversation[0]
  return (
    <aside className="nav-panel instrument-panel" aria-label="Workspace navigation">
      <div className="panel-code">
        <span>NAV 01</span>
        <span>LOCAL / PRIMARY</span>
      </div>
      <nav className="primary-nav" aria-label="Primary">
        <a className="nav-item nav-item--active" href="#today" aria-current="page">
          <Glyph name="today" /><span>TODAY</span>
        </a>
        <a className="nav-item" href="#today">
          <Glyph name="conversations" /><span>CONVERSATIONS</span>
        </a>
        <span className="nav-item nav-item--idle" aria-disabled="true" title="Calendar management is not available in this soak">
          <Glyph name="calendar" /><span>CALENDAR</span>
        </span>
        <a className="nav-item" href="#memory">
          <Glyph name="memory" /><span>MEMORY</span>
        </a>
        <a className="nav-item" href="#capabilities">
          <Glyph name="capabilities" /><span>CAPABILITIES</span>
        </a>
      </nav>
      <section className="recent" id="memory" aria-labelledby="recent-title">
        <div className="section-label" id="recent-title"><span>LOG 02</span><span>RECENT</span></div>
        {current ? (
          <div className="conversation-link conversation-link--current">
            <span className="conversation-title">{props.view.objective?.text ?? 'Current conversation'}</span>
            <span className="conversation-preview">{previewText(current.text)}</span>
          </div>
        ) : null}
        {recentMemory.map((item) => (
          <div className="conversation-link" key={item.id}>
            <span className="conversation-title">{item.topicKey}</span>
            <span className="conversation-preview">{item.statement}</span>
          </div>
        ))}
        {recentKnowledge.map((item) => (
          <div className="conversation-link" key={item.sourceUri}>
            <span className="conversation-title">{item.title ?? item.sourceUri}</span>
            <span className="conversation-preview">{item.excerpt ?? item.sourceUri}</span>
          </div>
        ))}
        {!current && recentMemory.length === 0 && recentKnowledge.length === 0 ? (
          <p className="recent-empty">No local memory yet</p>
        ) : null}
      </section>
      <div className="panel-coordinates" aria-label="Local runtime marker">
        <span>SYS 03</span>
        <span>127.0.0.1</span>
      </div>
    </aside>
  )
}

function ApprovalCardView(props: {
  readonly card: ApprovalCard
  readonly locked: boolean
  readonly onApprove: (card: ApprovalCard) => void
  readonly onReject: (card: ApprovalCard) => void
}) {
  const { card } = props
  const pending = isPendingApproval(card.status)
  return (
    <article
      className="approval-card"
      data-approval-id={card.id}
      data-kind={card.kind}
      data-fingerprint={card.fingerprint}
      data-candidate-id={card.candidateId ?? ''}
      aria-labelledby={`approval-title-${card.id}`}
    >
      <header className="approval-header">
        <Glyph name="calendar" className="glyph approval-symbol" />
        <h2 id={`approval-title-${card.id}`}>{card.title}</h2>
      </header>
      <dl className="approval-facts">
        <div><dt>TARGET</dt><dd>Target {card.target}</dd></div>
        <div><dt>AUTHORITY</dt><dd>{card.authorityChange}</dd></div>
        <div><dt>FINGERPRINT</dt><dd>Fingerprint {card.fingerprint}</dd></div>
        {card.candidateId ? <div><dt>CANDIDATE</dt><dd>{card.candidateId}</dd></div> : null}
        {card.digest ? <div><dt>DIGEST</dt><dd>{card.digest}</dd></div> : null}
        {card.details.map((line) => (
          <div key={line}><dt>DETAIL</dt><dd>{line}</dd></div>
        ))}
      </dl>
      <div className="effect-line">
        <Glyph name="info" className="glyph effect-icon" />
        <span><strong>EFFECT</strong> External side effect: {card.sideEffect}</span>
      </div>
      {pending ? (
        <div className="approval-actions">
          <button type="button" className="button button--secondary" data-approval-action="reject" disabled={props.locked} onClick={() => props.onReject(card)}>REJECT</button>
          <button type="button" className="button button--approval" data-approval-action="approve" disabled={props.locked} onClick={() => props.onApprove(card)}>APPROVE</button>
        </div>
      ) : <p className="approval-status">Status {card.status}</p>}
    </article>
  )
}

function ActivationCardView(props: {
  readonly card: ActivationCard
  readonly locked: boolean
  readonly armed: boolean
  readonly onActivate: (card: ActivationCard) => void
  readonly onDefer: (card: ActivationCard) => void
}) {
  const { card } = props
  const actionable = card.status === 'APPROVED_NOT_ACTIVE' && card.eligibilityOk
  return (
    <article
      className="approval-card"
      data-activation-id={card.id}
      data-kind={card.kind}
      data-fingerprint={card.fingerprint}
      data-candidate-id={card.candidateId}
      data-digest={card.digest}
      data-activation-status={card.status}
      aria-labelledby={`activation-title-${card.id}`}
    >
      <header className="approval-header">
        <Glyph name="shield" className="glyph approval-symbol" />
        <h2 id={`activation-title-${card.id}`}>{card.title}</h2>
      </header>
      <dl className="approval-facts">
        <div><dt>OWNER</dt><dd>{card.owner}@{card.version}</dd></div>
        <div><dt>CANDIDATE</dt><dd>{card.candidateId}</dd></div>
        <div><dt>DIGEST</dt><dd>{card.digest}</dd></div>
        <div><dt>FINGERPRINT</dt><dd>{card.fingerprint}</dd></div>
        {card.runtimeContractVersion ? <div><dt>CONTRACT</dt><dd>{card.runtimeContractVersion}</dd></div> : null}
        <div><dt>RUNTIME</dt><dd>Isolated runner only</dd></div>
        <div><dt>STATUS</dt><dd>{card.status}</dd></div>
        {card.details.map((line) => (
          <div key={line}><dt>DETAIL</dt><dd>{line}</dd></div>
        ))}
      </dl>
      {actionable ? (
        <div className="approval-actions">
          <button type="button" className="button button--secondary" data-activation-action="defer" disabled={props.locked} onClick={() => props.onDefer(card)}>NOT NOW</button>
          <button
            type="button"
            className="button button--approval"
            data-activation-action="activate"
            disabled={props.locked}
            onClick={() => props.onActivate(card)}
          >
            {props.armed ? 'CONFIRM ACTIVATE' : 'ACTIVATE'}
          </button>
        </div>
      ) : <p className="approval-status">Status {card.status}</p>}
    </article>
  )
}

function RecoveryPanel(props: {
  readonly systemState: MissionControlView['systemState']
  readonly recovery: NonNullable<MissionControlView['recovery']>
  readonly locked: boolean
  readonly armedRecovery?: string
  readonly onRecovery: (action: 'diagnostics' | 'rollback' | 'exit-safe-mode') => void
}) {
  return (
    <section className="recovery-panel" data-recovery="true">
      <h1>{props.systemState}</h1>
      <p>{props.recovery.why}</p>
      <p>Disabled: {props.recovery.disabled.join(', ') || 'generated/optional capabilities'}</p>
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

function ConversationWorkspace(props: {
  readonly view: MissionControlView
  readonly connected: boolean
  readonly sending: boolean
  readonly draft: string
  readonly error?: string
  readonly onDraft: (value: string) => void
  readonly onSend: () => void
  readonly onApprove: (card: ApprovalCard) => void
  readonly onReject: (card: ApprovalCard) => void
  readonly activations: readonly ActivationCard[]
  readonly armedActivation?: string
  readonly onActivate: (card: ActivationCard) => void
  readonly onDefer: (card: ActivationCard) => void
}) {
  const locked = !props.connected
  return (
    <main className="conversation-panel" id="today">
      <div className="conversation-scroll">
        {props.view.conversation.map((item, index) => {
          const user = isUserMessage(item.kind)
          const alert = item.kind === 'warning' || item.kind === 'failure'
          return (
            <article key={`${item.kind}-${index}`} className={`message${user ? ' message--user' : ' message--assistant'}${alert ? ' message--alert' : ''}`} data-kind={item.kind}>
              {user ? null : (
                <div className="assistant-mark" aria-hidden="true">
                  <Glyph name="hex" />
                  <span>T</span>
                </div>
              )}
              <div>
                <div className="message-meta">
                  <span>{user ? 'YOU' : props.view.identity}</span>
                </div>
                <div className="message-body" dangerouslySetInnerHTML={{ __html: formatMarkdownLite(item.text) }} />
              </div>
            </article>
          )
        })}
        {props.view.approvals.map((card) => (
          <ApprovalCardView key={card.id} card={card} locked={locked} onApprove={props.onApprove} onReject={props.onReject} />
        ))}
        {props.activations.map((card) => (
          <ActivationCardView
            key={`act-${card.id}`}
            card={card}
            locked={locked}
            armed={props.armedActivation === card.id}
            onActivate={props.onActivate}
            onDefer={props.onDefer}
          />
        ))}
      </div>
      <div>
        <form className="composer" aria-label="Send a message" onSubmit={(event: FormEvent) => { event.preventDefault(); props.onSend() }}>
          <label className="sr-only" htmlFor="message">Message TARS-NG</label>
          <textarea
            id="message"
            rows={2}
            placeholder="Message TARS-NG…"
            value={props.draft}
            onChange={(event) => props.onDraft(event.target.value)}
          />
          <button
            className="icon-button"
            type="button"
            aria-label="Attach file"
            title="Attachments are not available in this soak"
            disabled
          >
            <Glyph name="attach" />
          </button>
          <button
            className="send-button"
            type="submit"
            aria-label="Send message"
            disabled={props.sending || locked || props.draft.trim() === ''}
          >
            <Glyph name="send" />
            <span className="sr-only">{props.sending ? 'SENDING' : 'SEND'}</span>
          </button>
        </form>
        {props.error ? <p className="error" role="alert">{props.error}</p> : null}
      </div>
    </main>
  )
}

function OperationsPanel(props: { readonly view: MissionControlView }) {
  return (
    <aside className="ops-panel instrument-panel" id="activity" aria-label="Operational state">
      <div className="panel-code"><span>OPS 04</span><span>AUTHORITATIVE</span></div>
      <section className="activity-section" aria-labelledby="activity-title">
        <h2 id="activity-title">ACTIVITY</h2>
        <ol className="activity-list">
          {props.view.activity.map((item) => (
            <li key={item.id} className={`activity-item${activityModifier(item.kind)}`} data-activity={item.kind}>
              <span className="activity-node">{item.kind === 'APPROVAL_REQUIRED' ? <Glyph name="warn" /> : null}</span>
              <span>{item.kind.replaceAll('_', ' ')}</span>
              <span className="activity-summary">{item.summary}</span>
            </li>
          ))}
        </ol>
      </section>
      <WorkbenchPanel candidates={props.view.candidates ?? []} />
      <section className="capability-section" id="capabilities" aria-labelledby="capability-title">
        <h2 id="capability-title">CAPABILITY STATUS</h2>
        <dl className="capability-list">
          {props.view.capabilities.map((item) => (
            <div key={`${item.area}-${item.action}`}>
              <dt>
                <span className="capability-area">{item.area}</span>
                <span className="capability-action">{item.action}</span>
              </dt>
              <dd data-status={item.status} data-capability-state={capabilitySignal(item.status)}>
                {item.status.replaceAll('-', ' ').toUpperCase()}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </aside>
  )
}

function formatDiff(added: readonly string[], removed: readonly string[]): string {
  const plus = added.map((item) => `+${item}`).join(' ')
  const minus = removed.map((item) => `-${item}`).join(' ')
  return [plus, minus].filter((item) => item !== '').join(' ') || 'none'
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
                      : item.extensionLifecycle === 'SUPERSEDED' ? 'superseded'
                        : item.approvalState === 'approval-requested' || item.canRequestApproval ? 'ready for approval'
                          : 'not ready for approval'}
            </div>
            <div className="workbench-diff">
              capabilities {formatDiff(item.diff?.capabilities.added ?? [], item.diff?.capabilities.removed ?? [])}
            </div>
            <div className="workbench-diff">
              permissions {formatDiff(item.diff?.permissions.added ?? [], item.diff?.permissions.removed ?? [])}
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
  readonly onDeferActivation?: (card: ActivationCard) => void
  readonly deferredActivations?: readonly string[]
  readonly armedActivation?: string
  readonly onRecovery: (action: 'diagnostics' | 'rollback' | 'exit-safe-mode') => void
}) {
  const { view } = props
  const safe = view.systemState === 'SAFE_MODE' || view.systemState === 'RECOVERY'
  const locked = !props.connected
  return (
    <div className="chassis">
    <div className="console" data-system-state={view.systemState} data-connected={props.connected ? 'yes' : 'no'}>
      <SystemHeader
        identity={view.identity}
        systemState={view.systemState}
        objective={view.objective?.text}
        connected={props.connected}
      />
      {!props.connected ? <p className="transport" role="status">Disconnected from local runtime</p> : null}
      {safe && view.recovery ? (
        <RecoveryPanel
          systemState={view.systemState}
          recovery={view.recovery}
          locked={locked}
          armedRecovery={props.armedRecovery}
          onRecovery={props.onRecovery}
        />
      ) : null}
      <div className="workspace-grid">
        <WorkspaceNavigation view={view} />
        <ConversationWorkspace
          view={view}
          connected={props.connected}
          sending={props.sending}
          draft={props.draft}
          error={props.error}
          onDraft={props.onDraft}
          onSend={props.onSend}
          onApprove={props.onApprove}
          onReject={props.onReject}
          activations={(view.activations ?? []).filter((card) => !(props.deferredActivations ?? []).includes(card.id))}
          armedActivation={props.armedActivation}
          onActivate={props.onActivate ?? (() => {})}
          onDefer={props.onDeferActivation ?? (() => {})}
        />
        <OperationsPanel view={view} />
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
  const [deferredActivations, setDeferredActivations] = useState<string[]>([])

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
      setEnvelope(await sendMessage(draft.trim()))
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
      setEnvelope(await run())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'action failed')
    }
  }

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
      onApprove={(card) => { void act(() => decideApproval(card, 'approve')) }}
      onReject={(card) => { void act(() => decideApproval(card, 'deny')) }}
      deferredActivations={deferredActivations}
      armedActivation={armedActivation}
      onDeferActivation={(card) => {
        setDeferredActivations((current) => current.includes(card.id) ? current : [...current, card.id])
      }}
      onActivate={(card) => {
        if (armedActivation !== card.id) {
          setArmedActivation(card.id)
          return
        }
        setArmedActivation(undefined)
        void act(() => activateCandidate(card, true))
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
