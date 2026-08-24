import React, { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { ActivationCard, ApprovalCard, MissionControlView, RollbackCard, UserCapabilityStatus, UserPluginView, WorkObjectKind, WorkbenchProjection } from '../../src/domain/workspace/types'
import {
  activateCandidate,
  decideApproval,
  establishSession,
  fetchView,
  formatMarkdownLite,
  openViewStream,
  recoveryActionId,
  rollbackSystemState,
  runConversation,
  runRecovery,
  sendMessage,
  uninstallPlugin,
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

type WorkspacePane = 'today' | 'extensions' | 'conversations'

function paneFromHash(): WorkspacePane {
  if (globalThis.location?.hash === '#extensions') return 'extensions'
  if (globalThis.location?.hash === '#conversations') return 'conversations'
  return 'today'
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

function WorkspaceNavigation(props: {
  readonly view: MissionControlView
  readonly pane: WorkspacePane
  readonly onNavigate: (pane: WorkspacePane) => void
  readonly confirmingSession?: string
  readonly onCreateConversation?: () => void
  readonly onSwitchConversation?: (id: string) => void
  readonly onRenameConversation?: (id: string, title: string) => void
  readonly onArchiveConversation?: (id: string) => void
  readonly onRestoreConversation?: (id: string) => void
  readonly onAskDeleteConversation?: (id: string) => void
  readonly onConfirmDeleteConversation?: (id: string) => void
}) {
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
        <button
          type="button"
          className={`nav-item${props.pane === 'today' ? ' nav-item--active' : ''}`}
          data-nav="today"
          aria-current={props.pane === 'today' ? 'page' : undefined}
          onClick={() => props.onNavigate('today')}
        >
          <Glyph name="today" /><span>TODAY</span>
        </button>
        <button
          type="button"
          className={`nav-item${props.pane === 'conversations' ? ' nav-item--active' : ''}`}
          data-nav="conversations"
          aria-current={props.pane === 'conversations' ? 'page' : undefined}
          onClick={() => props.onNavigate('conversations')}
        >
          <Glyph name="conversations" /><span>CONVERSATIONS</span>
        </button>
        <span className="nav-item nav-item--idle" aria-disabled="true" title="Calendar management is not available in this soak">
          <Glyph name="calendar" /><span>CALENDAR</span>
        </span>
        <a className="nav-item" href="#memory">
          <Glyph name="memory" /><span>MEMORY</span>
        </a>
        <button
          type="button"
          className={`nav-item${props.pane === 'extensions' ? ' nav-item--active' : ''}`}
          data-nav="extensions"
          aria-current={props.pane === 'extensions' ? 'page' : undefined}
          onClick={() => props.onNavigate('extensions')}
        >
          <Glyph name="capabilities" /><span>EXTENSIONS</span>
        </button>
        <a className="nav-item" href="#capabilities">
          <Glyph name="capabilities" /><span>CAPABILITIES</span>
        </a>
      </nav>
      {props.view.sessions ? (
        <section className="recent" aria-labelledby="conversations-title">
          <div className="section-label" id="conversations-title"><span>LOG 02</span><span>CONVERSATIONS</span></div>
          <button type="button" className="button button--secondary" data-conversation-action="create" onClick={() => props.onCreateConversation?.()}>New conversation</button>
          {(props.pane === 'conversations' ? props.view.sessions.sessions : props.view.sessions.sessions.filter((item) => item.lifecycle === 'active'))
            .slice()
            .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))
            .map((item) => (
              <div key={item.id} className={`conversation-link${item.current ? ' conversation-link--current' : ''}`} data-session-id={item.id}>
                <button type="button" className="conversation-title" onClick={() => props.onSwitchConversation?.(item.id)}>
                  {item.title}{item.lifecycle === 'archived' ? ' (archived)' : ''}
                </button>
                <span className="conversation-preview">{item.preview ?? item.id}</span>
                <span className="conversation-actions">
                  <button
                    type="button"
                    className="button button--secondary"
                    data-conversation-action="rename"
                    onClick={() => {
                      const next = globalThis.prompt?.('Rename conversation', item.title)
                      if (next && next.trim() !== '' && next !== item.title) props.onRenameConversation?.(item.id, next.trim())
                    }}
                  >
                    Rename
                  </button>
                  {item.lifecycle === 'active' ? (
                    <button type="button" className="button button--secondary" onClick={() => props.onArchiveConversation?.(item.id)}>Archive</button>
                  ) : (
                    <button type="button" className="button button--secondary" onClick={() => props.onRestoreConversation?.(item.id)}>Restore</button>
                  )}
                  {props.confirmingSession === item.id ? (
                    <button type="button" className="button button--fault" onClick={() => props.onConfirmDeleteConversation?.(item.id)}>Confirm delete</button>
                  ) : (
                    <button type="button" className="button button--secondary" onClick={() => props.onAskDeleteConversation?.(item.id)}>Delete</button>
                  )}
                </span>
              </div>
            ))}
          {props.view.sessions.health !== 'ok' ? <p className="recent-empty">Catalog {props.view.sessions.health}</p> : null}
        </section>
      ) : null}
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
  const actionable = (card.status === 'APPROVED_NOT_ACTIVE' || card.status === 'DISABLED_REACTIVATABLE' || card.status === 'ACTIVATION_FAILED') && card.eligibilityOk
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
        <div><dt>CAPABILITIES</dt><dd>{formatDiff(card.capabilitiesAdded, card.capabilitiesRemoved, card.capabilitiesChanged)}</dd></div>
        <div><dt>TOOLS</dt><dd>{formatDiff(card.toolsAdded, card.toolsRemoved, card.toolsChanged)}</dd></div>
        <div><dt>PERMISSIONS</dt><dd>{formatDiff(card.permissionsAdded, card.permissionsRemoved, card.permissionsChanged)}</dd></div>
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
            {props.armed
              ? (card.status === 'DISABLED_REACTIVATABLE' ? 'CONFIRM REACTIVATE' : card.status === 'ACTIVATION_FAILED' ? 'CONFIRM RETRY' : 'CONFIRM ACTIVATE')
              : (card.status === 'DISABLED_REACTIVATABLE' ? 'REACTIVATE' : card.status === 'ACTIVATION_FAILED' ? 'RETRY' : 'ACTIVATE')}
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

function RollbackCardView(props: {
  readonly card: RollbackCard
  readonly locked: boolean
  readonly deferred: boolean
  readonly armed: boolean
  readonly onAsk: (card: RollbackCard) => void
  readonly onDefer: (card: RollbackCard) => void
}) {
  const { card } = props
  if (props.deferred) return null
  return (
    <article
      className="approval-card"
      data-rollback-id={card.id}
      data-kind={card.kind}
      data-fingerprint={card.fingerprint}
      data-current-generation={card.currentGeneration}
      data-target-generation={card.targetGeneration}
      aria-labelledby={`rollback-title-${card.id}`}
    >
      <header className="approval-header">
        <Glyph name="shield" className="glyph approval-symbol" />
        <h2 id={`rollback-title-${card.id}`}>{card.title}</h2>
      </header>
      <dl className="approval-facts">
        <div><dt>CURRENT</dt><dd>generation {card.currentGeneration}</dd></div>
        <div><dt>TARGET</dt><dd>generation {card.targetGeneration}</dd></div>
        <div><dt>FINGERPRINT</dt><dd>{card.fingerprint}</dd></div>
        <div><dt>WHY</dt><dd>{card.reason}</dd></div>
        <div><dt>OWNERS</dt><dd>{card.ownerChanges.map((item) => `${item.change} ${item.owner}${item.from ? ` ${item.from}` : ''}${item.to ? `→${item.to}` : ''}`).join('; ') || 'none'}</dd></div>
        <div><dt>CAPABILITIES</dt><dd>added {card.capabilitiesAdded.join(', ') || 'none'}; removed {card.capabilitiesRemoved.join(', ') || 'none'}</dd></div>
        <div><dt>TOOLS</dt><dd>added {card.toolsAdded.join(', ') || 'none'}; removed {card.toolsRemoved.join(', ') || 'none'}</dd></div>
        <div><dt>MOUNTS</dt><dd>added {card.mountsAdded.length}; removed {card.mountsRemoved.length}</dd></div>
        <div><dt>RECOVERY REQUIRED</dt><dd>{card.recoveryRequired ? 'yes' : 'no'}</dd></div>
        <div><dt>WARNING</dt><dd>This is a system-state rollback, not a single-plugin uninstall. Candidate, approval, review, and audit history are retained.</dd></div>
      </dl>
      {props.armed ? (
        <div className="approval-actions">
          <button type="button" className="button button--secondary" data-rollback-action="cancel" disabled={props.locked} onClick={() => props.onDefer(card)}>Not now</button>
          <button type="button" className="button button--fault" data-rollback-action="confirm" disabled={props.locked} onClick={() => props.onAsk(card)}>Confirm Rollback system state</button>
        </div>
      ) : (
        <div className="approval-actions">
          <button type="button" className="button button--secondary" data-rollback-action="defer" disabled={props.locked} onClick={() => props.onDefer(card)}>Not now</button>
          <button type="button" className="button button--approval" data-rollback-action="ask" disabled={props.locked} onClick={() => props.onAsk(card)}>Rollback system state</button>
        </div>
      )}
    </article>
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
  readonly rollback?: RollbackCard
  readonly deferredRollback?: boolean
  readonly armedRollback?: boolean
  readonly onAskRollback?: (card: RollbackCard) => void
  readonly onDeferRollback?: (card: RollbackCard) => void
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
        {props.view.approvals.filter((card) => isPendingApproval(card.status)).map((card) => (
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
        {props.rollback ? (
          <RollbackCardView
            card={props.rollback}
            locked={locked}
            deferred={props.deferredRollback === true}
            armed={props.armedRollback === true}
            onAsk={props.onAskRollback ?? (() => {})}
            onDefer={props.onDeferRollback ?? (() => {})}
          />
        ) : null}
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

function PluginRow(props: {
  readonly plugin: UserPluginView
  readonly locked: boolean
  readonly confirming: boolean
  readonly onAsk: (plugin: UserPluginView) => void
  readonly onCancel: () => void
  readonly onConfirm: (plugin: UserPluginView) => void
}) {
  const { plugin } = props
  const blocked = plugin.dependency.severity === 'hard' || plugin.dependency.severity === 'unresolved'
  const hard = plugin.dependency.dependents.filter((item) => item.kind === 'hard')
  const optional = plugin.dependency.dependents.filter((item) => item.kind === 'optional')
  const historical = plugin.dependency.dependents.filter((item) => item.kind === 'historical')
  return (
    <div
      className="plugin-row"
      data-plugin-id={plugin.id}
      data-owner={plugin.owner}
      data-version={plugin.version}
      data-uninstallable={plugin.uninstallable ? 'yes' : 'no'}
    >
      <dt>
        <span className="capability-area">{plugin.owner}@{plugin.version}</span>
        <span className="capability-action">{plugin.capabilities.join(', ') || 'user plugin'}</span>
      </dt>
      <dd>
        {props.confirming ? (
          <div className="uninstall-dialog" role="dialog" aria-labelledby={`uninstall-title-${plugin.id}`} aria-describedby={`uninstall-body-${plugin.id}`}>
            <h3 id={`uninstall-title-${plugin.id}`}>Uninstall {plugin.owner}@{plugin.version}</h3>
            <p id={`uninstall-body-${plugin.id}`}>
              Will remove:
              {plugin.capabilities.length > 0 ? ` Capability: ${plugin.capabilities.join(', ')}.` : ''}
              {plugin.tools.length > 0 ? ` Tool: ${plugin.tools.join(', ')}.` : ''}
              {` Runtime mount: ${plugin.mounted ? 1 : 0}.`}
              {plugin.candidateId ? ` Candidate: ${plugin.candidateId}.` : ''}
              {plugin.digest ? ` Digest: ${plugin.digest}.` : ''}
            </p>
            <p>
              Dependency check: {plugin.dependency.severity === 'none' ? 'no active dependents' : plugin.dependency.severity}
              {hard.length > 0 ? ` — ${hard.map((item) => `${item.owner}@${item.version} requires ${item.requiredCapability}`).join('; ')}` : ''}
              {optional.length > 0 ? ` Optional dependents will degrade: ${optional.map((item) => `${item.owner}@${item.version}`).join(', ')}.` : ''}
              {historical.length > 0 ? ` Historical dependents: ${historical.map((item) => `${item.owner}@${item.version} required ${item.requiredCapability}`).join(', ')}.` : ''}
            </p>
            <p>Candidate files and audit history will be retained.</p>
            <div className="approval-actions">
              <button type="button" className="button button--secondary" data-uninstall-action="cancel" onClick={props.onCancel}>Cancel</button>
              <button
                type="button"
                className="button button--approval"
                data-uninstall-action="confirm"
                disabled={props.locked || blocked}
                onClick={() => props.onConfirm(plugin)}
              >
                Confirm uninstall
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="plugin-uninstall"
            data-uninstall-action="ask"
            aria-label="Uninstall plugin"
            title="Uninstall plugin"
            disabled={props.locked}
            onClick={() => props.onAsk(plugin)}
          >
            <Glyph name="trash" />
          </button>
        )}
      </dd>
    </div>
  )
}

function ExtensionsWorkspace(props: {
  readonly view: MissionControlView
  readonly locked: boolean
  readonly inspecting?: string
  readonly confirmingPlugin?: string
  readonly armedActivation?: string
  readonly onInspect: (id: string) => void
  readonly onApprove: (card: ApprovalCard) => void
  readonly onReject: (card: ApprovalCard) => void
  readonly onActivate?: (card: ActivationCard) => void
  readonly onAskUninstall?: (plugin: UserPluginView) => void
  readonly onCancelUninstall?: () => void
  readonly onConfirmUninstall?: (plugin: UserPluginView) => void
}) {
  return (
    <main className="conversation-panel extensions-panel" id="extensions" data-workspace-pane="extensions">
      <div className="conversation-scroll">
        <section className="capability-section" aria-labelledby="extensions-title">
          <h2 id="extensions-title">EXTENSIONS</h2>
          <ul className="workbench-list" data-extensions="true">
            {(props.view.extensions ?? []).length === 0 ? (
              <li className="workbench-item">No generated or user extensions in this home.</li>
            ) : (props.view.extensions ?? []).map((item) => {
              const approval = (props.view.approvals ?? []).find((card) => card.candidateId === item.candidateId)
              const card = (props.view.activations ?? []).find((activation) => activation.candidateId === item.candidateId)
              const plugin = (props.view.plugins ?? []).find((row) => row.owner === item.owner && row.version === item.version)
              const failure = props.view.activationFailure?.candidateId === item.candidateId ? props.view.activationFailure : undefined
              const open = props.inspecting === item.id
              const pending = approval !== undefined && isPendingApproval(approval.status)
              const canActivate = (item.lifecycle === 'DISABLED_REACTIVATABLE' || item.lifecycle === 'APPROVED_NOT_ACTIVE' || item.lifecycle === 'ACTIVATION_FAILED')
                && card !== undefined
                && item.eligibilityOk
              return (
                <li
                  key={item.id}
                  className="workbench-item"
                  data-extension-id={item.id}
                  data-extension-lifecycle={item.lifecycle}
                  data-registry-status={item.registryStatus}
                  data-extension-inspect={open ? 'open' : 'closed'}
                >
                  <div className="workbench-identity">{item.owner}@{item.version}</div>
                  <div className="workbench-meta">lifecycle {item.lifecycle.replaceAll('_', ' ')}</div>
                  <div className="workbench-meta">registry {item.registryStatus} · {item.mounted ? 'mounted' : 'unmounted'}</div>
                  <div className="workbench-meta">provenance {item.provenance}{item.provenanceOrigin ? ` / ${item.provenanceOrigin}` : ''}</div>
                  <div className="workbench-meta">capabilities {item.capabilities.join(', ') || 'none'}</div>
                  {item.candidateId ? <div className="workbench-meta">candidate {item.candidateId}</div> : null}
                  {item.digest ? <div className="workbench-meta">digest {item.digest}</div> : null}
                  <div className="workbench-meta">
                    {item.eligibilityOk ? 'eligible' : `not eligible${item.eligibilityDenials.length ? `: ${item.eligibilityDenials.join(', ')}` : ''}`}
                  </div>
                  {item.newerAuthoritative ? <div className="workbench-meta">newer authoritative revision exists</div> : null}
                  {open ? (
                    <div className="workbench-meta" data-extension-details="true">
                      review {item.reviewState ?? 'unknown'} · validation {item.validationPassed === true ? 'passed' : 'not passed'} · approval {item.approvalDecision ?? 'none'}
                      {failure ? ` · failed ${failure.phase}: ${failure.summary}` : ''}
                    </div>
                  ) : null}
                  <div className="approval-actions">
                    <button
                      type="button"
                      className="button button--secondary"
                      data-extension-action={
                        item.lifecycle === 'DISABLED_BLOCKED' ? 'inspect-denials'
                          : item.lifecycle === 'ACTIVATION_FAILED' ? 'diagnostics'
                            : item.lifecycle === 'SUPERSEDED' ? 'view-history'
                              : 'inspect'
                      }
                      disabled={props.locked}
                      onClick={() => props.onInspect(item.id)}
                    >
                      {item.lifecycle === 'DISABLED_BLOCKED' ? (open ? 'HIDE DENIALS' : 'INSPECT DENIALS')
                        : item.lifecycle === 'ACTIVATION_FAILED' ? (open ? 'HIDE DIAGNOSTICS' : 'DIAGNOSTICS')
                          : item.lifecycle === 'SUPERSEDED' ? (open ? 'HIDE HISTORY' : 'VIEW HISTORY')
                            : (open ? 'HIDE' : 'INSPECT')}
                    </button>
                    {item.lifecycle === 'APPROVAL_REQUIRED' && pending && approval ? (
                      <>
                        <button type="button" className="button button--secondary" data-extension-action="reject" disabled={props.locked} onClick={() => props.onReject(approval)}>REJECT</button>
                        <button type="button" className="button button--approval" data-extension-action="approve" disabled={props.locked} onClick={() => props.onApprove(approval)}>APPROVE</button>
                      </>
                    ) : null}
                    {canActivate && card ? (
                      <button
                        type="button"
                        className="button button--approval"
                        data-extension-action={item.lifecycle === 'DISABLED_REACTIVATABLE' ? 'reactivate' : item.lifecycle === 'ACTIVATION_FAILED' ? 'retry' : 'activate'}
                        disabled={props.locked}
                        onClick={() => props.onActivate?.(card)}
                      >
                        {props.armedActivation === card.id
                          ? (item.lifecycle === 'DISABLED_REACTIVATABLE' ? 'CONFIRM REACTIVATE' : item.lifecycle === 'ACTIVATION_FAILED' ? 'CONFIRM RETRY' : 'CONFIRM ACTIVATE')
                          : (item.lifecycle === 'DISABLED_REACTIVATABLE' ? 'REACTIVATE' : item.lifecycle === 'ACTIVATION_FAILED' ? 'RETRY' : 'ACTIVATE')}
                      </button>
                    ) : null}
                    {item.lifecycle === 'ACTIVE' && plugin ? (
                      <PluginRow
                        plugin={plugin}
                        locked={props.locked}
                        confirming={props.confirmingPlugin === plugin.id}
                        onAsk={props.onAskUninstall ?? (() => {})}
                        onCancel={props.onCancelUninstall ?? (() => {})}
                        onConfirm={props.onConfirmUninstall ?? (() => {})}
                      />
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      </div>
    </main>
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
      <section className="capability-section" id="actions" aria-labelledby="actions-title">
        <h2 id="actions-title">ACTIONS</h2>
        <ul className="workbench-list" data-actions-history="true">
          {(props.view.approvalResolutions ?? []).length === 0 ? (
            <li className="workbench-item">No resolved approvals yet.</li>
          ) : (props.view.approvalResolutions ?? []).map((item) => (
            <li
              key={item.confirmationId}
              className="workbench-item"
              data-approval-resolution={item.confirmationId}
              data-approval-outcome={item.outcome}
            >
              <div className="workbench-identity">{item.capability ?? 'action'}.{item.operation ?? item.decision}</div>
              <div className="workbench-meta">{item.decision} · {item.outcome}</div>
            </li>
          ))}
        </ul>
      </section>
      <section className="capability-section" aria-labelledby="extensions-ops-title">
        <h2 id="extensions-ops-title">EXTENSIONS</h2>
        <p className="workbench-meta">{(props.view.extensions ?? []).length} generated/user revision{(props.view.extensions ?? []).length === 1 ? '' : 's'}</p>
        <button type="button" className="button button--secondary" data-open-extensions="true" onClick={() => props.onOpenExtensions?.()}>
          Open Extensions
        </button>
      </section>
      <section className="capability-section" id="capabilities" aria-labelledby="capability-title">
        <h2 id="capability-title">CAPABILITY STATUS</h2>
        <dl className="capability-list">
          {(props.view.plugins ?? []).map((plugin) => (
            <PluginRow
              key={plugin.id}
              plugin={plugin}
              locked={props.locked === true}
              confirming={props.confirmingPlugin === plugin.id}
              onAsk={props.onAskUninstall ?? (() => {})}
              onCancel={props.onCancelUninstall ?? (() => {})}
              onConfirm={props.onConfirmUninstall ?? (() => {})}
            />
          ))}
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

function formatDiff(added: readonly string[], removed: readonly string[], changed: readonly string[] = []): string {
  const plus = added.map((item) => `+${item}`).join(' ')
  const minus = removed.map((item) => `-${item}`).join(' ')
  const tilde = changed.map((item) => `~${item}`).join(' ')
  return [plus, minus, tilde].filter((item) => item !== '').join(' ') || 'none'
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
  readonly onDeferActivation?: (card: ActivationCard) => void
  readonly deferredActivations?: readonly string[]
  readonly armedActivation?: string
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
}) {
  const { view } = props
  const safe = view.systemState === 'SAFE_MODE' || view.systemState === 'RECOVERY'
  const locked = !props.connected
  const pane = props.pane ?? 'today'
  return (
    <div className="chassis">
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
      <div className="workspace-grid">
        <WorkspaceNavigation
          view={view}
          pane={pane}
          onNavigate={props.onNavigate ?? (() => {})}
          confirmingSession={props.confirmingSession}
          onCreateConversation={props.onCreateConversation}
          onSwitchConversation={props.onSwitchConversation}
          onRenameConversation={props.onRenameConversation}
          onArchiveConversation={props.onArchiveConversation}
          onRestoreConversation={props.onRestoreConversation}
          onAskDeleteConversation={props.onAskDeleteConversation}
          onConfirmDeleteConversation={props.onConfirmDeleteConversation}
        />
        {pane === 'extensions' ? (
          <ExtensionsWorkspace
            view={view}
            locked={locked}
            inspecting={props.inspectingExtension}
            confirmingPlugin={props.confirmingPlugin}
            armedActivation={props.armedActivation}
            onInspect={props.onInspectExtension ?? (() => {})}
            onApprove={props.onApprove}
            onReject={props.onReject}
            onActivate={props.onActivate}
            onAskUninstall={props.onAskUninstall}
            onCancelUninstall={props.onCancelUninstall}
            onConfirmUninstall={props.onConfirmUninstall}
          />
        ) : (
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
          rollback={view.rollback}
          deferredRollback={props.deferredRollback}
          armedRollback={props.armedRollback}
          onAskRollback={props.onAskRollback}
          onDeferRollback={props.onDeferRollback}
        />
        )}
        <OperationsPanel
          view={view}
          locked={locked}
          confirmingPlugin={props.confirmingPlugin}
          onAskUninstall={props.onAskUninstall}
          onCancelUninstall={props.onCancelUninstall}
          onConfirmUninstall={props.onConfirmUninstall}
          onOpenExtensions={() => props.onNavigate?.('extensions')}
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
  const [deferredActivations, setDeferredActivations] = useState<string[]>([])
  const [confirmingPlugin, setConfirmingPlugin] = useState<string>()
  const [deferredRollback, setDeferredRollback] = useState(false)
  const [armedRollback, setArmedRollback] = useState(false)
  const [pane, setPane] = useState<WorkspacePane>(paneFromHash)
  const [confirmingSession, setConfirmingSession] = useState<string>()
  const [inspectingExtension, setInspectingExtension] = useState<string>()
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
      globalThis.location.hash = next === 'extensions' ? 'extensions' : next === 'conversations' ? 'conversations' : 'today'
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
      setEnvelope(await sendMessage(draft.trim(), view?.runtimeContext?.sessionId))
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
