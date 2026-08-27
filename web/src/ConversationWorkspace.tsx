import React, { type FormEvent } from 'react'
import type { ActivationCard, ApprovalCard, MissionControlView, RollbackCard, SkillProjection, WorkObjectKind } from '../../src/domain/workspace/types'
import { Glyph } from './icons'
import { MarkdownMessage } from './MarkdownMessage'
import { formatDiff, isPendingApproval, skillInvocationSurfaceOpen } from './missionControlPresentation'

export interface ConversationWorkspaceState {
  readonly connected: boolean
  readonly sending: boolean
  readonly draft: string
  readonly error?: string
  readonly activations: readonly ActivationCard[]
  readonly armedActivation?: string
  readonly armedAbandonment?: string
  readonly rollback?: RollbackCard
  readonly deferredRollback?: boolean
  readonly armedRollback?: boolean
}

export interface ConversationWorkspaceActions {
  readonly draft: (value: string) => void
  readonly send: () => void
  readonly approve: (card: ApprovalCard) => void
  readonly reject: (card: ApprovalCard) => void
  readonly activate: (card: ActivationCard) => void
  readonly abandonActivation: (card: ActivationCard) => void
  readonly deferActivation: (card: ActivationCard) => void
  readonly pickSkill?: (skill: SkillProjection) => void
  readonly askRollback?: (card: RollbackCard) => void
  readonly deferRollback?: (card: RollbackCard) => void
}

function isUserMessage(kind: WorkObjectKind): boolean {
  return kind === 'user-message'
}

function ApprovalCardView(props: {
  readonly card: ApprovalCard
  readonly locked: boolean
  readonly actions: Pick<ConversationWorkspaceActions, 'approve' | 'reject'>
}) {
  const { card } = props
  const pending = isPendingApproval(card.status)
  return (
    <article className="approval-card" data-approval-id={card.id} data-kind={card.kind} data-fingerprint={card.fingerprint} data-candidate-id={card.candidateId ?? ''} aria-labelledby={`approval-title-${card.id}`}>
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
        {card.details.map((line) => <div key={line}><dt>DETAIL</dt><dd>{line}</dd></div>)}
      </dl>
      <div className="effect-line">
        <Glyph name="info" className="glyph effect-icon" />
        <span><strong>EFFECT</strong> External side effect: {card.sideEffect}</span>
      </div>
      {pending ? (
        <div className="approval-actions">
          <button type="button" className="button button--secondary" data-approval-action="reject" disabled={props.locked} onClick={() => props.actions.reject(card)}>REJECT</button>
          <button type="button" className="button button--approval" data-approval-action="approve" disabled={props.locked} onClick={() => props.actions.approve(card)}>APPROVE</button>
        </div>
      ) : <p className="approval-status">Status {card.status}</p>}
    </article>
  )
}

function ActivationCardView(props: {
  readonly card: ActivationCard
  readonly locked: boolean
  readonly armed: boolean
  readonly abandonArmed: boolean
  readonly actions: Pick<ConversationWorkspaceActions, 'activate' | 'abandonActivation' | 'deferActivation'>
}) {
  const { card } = props
  const actionable = (card.status === 'APPROVED_NOT_ACTIVE' || card.status === 'DISABLED_REACTIVATABLE' || card.status === 'ACTIVATION_FAILED') && card.eligibilityOk
  return (
    <article className="approval-card" data-activation-id={card.id} data-kind={card.kind} data-fingerprint={card.fingerprint} data-candidate-id={card.candidateId} data-digest={card.digest} data-activation-status={card.status} aria-labelledby={`activation-title-${card.id}`}>
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
        {card.details.map((line) => <div key={line}><dt>DETAIL</dt><dd>{line}</dd></div>)}
      </dl>
      {actionable ? (
        <div className="approval-actions">
          <button type="button" className="button button--secondary" data-activation-action="defer" disabled={props.locked} onClick={() => props.actions.deferActivation(card)}>NOT NOW</button>
          {card.status === 'ACTIVATION_FAILED' ? (
            <button type="button" className="button button--fault" data-activation-action="abandon" disabled={props.locked} onClick={() => props.actions.abandonActivation(card)}>
              {props.abandonArmed ? 'CONFIRM ABANDON' : 'ABANDON'}
            </button>
          ) : null}
          <button type="button" className="button button--approval" data-activation-action="activate" disabled={props.locked} onClick={() => props.actions.activate(card)}>
            {props.armed
              ? (card.status === 'DISABLED_REACTIVATABLE' ? 'CONFIRM REACTIVATE' : card.status === 'ACTIVATION_FAILED' ? 'CONFIRM RETRY' : 'CONFIRM ACTIVATE')
              : (card.status === 'DISABLED_REACTIVATABLE' ? 'REACTIVATE' : card.status === 'ACTIVATION_FAILED' ? 'RETRY' : 'ACTIVATE')}
          </button>
        </div>
      ) : <p className="approval-status">Status {card.status}</p>}
    </article>
  )
}

function RollbackCardView(props: {
  readonly card: RollbackCard
  readonly locked: boolean
  readonly deferred: boolean
  readonly armed: boolean
  readonly actions: Pick<ConversationWorkspaceActions, 'askRollback' | 'deferRollback'>
}) {
  const { card } = props
  if (props.deferred) return null
  return (
    <article className="approval-card" data-rollback-id={card.id} data-kind={card.kind} data-fingerprint={card.fingerprint} data-current-generation={card.currentGeneration} data-target-generation={card.targetGeneration} aria-labelledby={`rollback-title-${card.id}`}>
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
          <button type="button" className="button button--secondary" data-rollback-action="cancel" disabled={props.locked} onClick={() => props.actions.deferRollback?.(card)}>Not now</button>
          <button type="button" className="button button--fault" data-rollback-action="confirm" disabled={props.locked} onClick={() => props.actions.askRollback?.(card)}>Confirm Rollback system state</button>
        </div>
      ) : (
        <div className="approval-actions">
          <button type="button" className="button button--secondary" data-rollback-action="defer" disabled={props.locked} onClick={() => props.actions.deferRollback?.(card)}>Not now</button>
          <button type="button" className="button button--approval" data-rollback-action="ask" disabled={props.locked} onClick={() => props.actions.askRollback?.(card)}>Rollback system state</button>
        </div>
      )}
    </article>
  )
}

export function ConversationWorkspace(props: {
  readonly view: MissionControlView
  readonly state: ConversationWorkspaceState
  readonly actions: ConversationWorkspaceActions
}) {
  const { state, actions } = props
  const locked = !state.connected
  const sendDisabled = state.sending || locked || state.draft.trim() === ''
  const empty = props.view.conversation.length === 0
    && props.view.approvals.filter((card) => isPendingApproval(card.status)).length === 0
    && state.activations.length === 0
    && state.rollback === undefined
  return (
    <main className="conversation-panel" id="today">
      <div className="conversation-scroll">
        {empty ? (
          <section className="conversation-empty" aria-labelledby="conversation-empty-title">
            <div className="empty-mark" aria-hidden="true"><Glyph name="hex" /><span>T</span></div>
            <p className="empty-kicker">LOCAL ASSISTANT · READY</p>
            <h1 id="conversation-empty-title">What are we working on?</h1>
            <p className="empty-copy">Start with a question, a decision, or a concrete outcome. TARS-NG keeps the work inside this local workspace.</p>
            <div className="empty-prompts" aria-label="Suggested prompts">
              {['Help me understand this project', 'Review the latest changes', 'Plan the next product milestone'].map((prompt) => (
                <button key={prompt} type="button" onClick={() => actions.draft(prompt)} disabled={locked}>{prompt}</button>
              ))}
            </div>
          </section>
        ) : null}
        {props.view.conversation.map((item, index) => {
          const user = isUserMessage(item.kind)
          const alert = item.kind === 'warning' || item.kind === 'failure'
          return (
            <article key={`${item.kind}-${index}`} className={`message${user ? ' message--user' : ' message--assistant'}${alert ? ' message--alert' : ''}`} data-kind={item.kind}>
              {user ? null : <div className="assistant-mark" aria-hidden="true"><Glyph name="hex" /><span>T</span></div>}
              <div>
                <div className="message-meta"><span>{user ? 'YOU' : props.view.identity}</span></div>
                <div className="message-body"><MarkdownMessage text={item.text} /></div>
              </div>
            </article>
          )
        })}
        {props.view.approvals.filter((card) => isPendingApproval(card.status)).map((card) => (
          <ApprovalCardView key={card.id} card={card} locked={locked} actions={actions} />
        ))}
        {state.activations.map((card) => (
          <ActivationCardView key={`act-${card.id}`} card={card} locked={locked} armed={state.armedActivation === card.id} abandonArmed={state.armedAbandonment === card.id} actions={actions} />
        ))}
        {state.rollback ? (
          <RollbackCardView card={state.rollback} locked={locked} deferred={state.deferredRollback === true} armed={state.armedRollback === true} actions={actions} />
        ) : null}
      </div>
      <div>
        {skillInvocationSurfaceOpen(props.view) && (props.view.skills ?? []).some((skill) => skill.userInvocable && skill.lifecycle === 'active') ? (
          <div className="composer-chips" data-skill-chips="true">
            {(props.view.skills ?? []).filter((skill) => skill.userInvocable && skill.lifecycle === 'active').map((skill) => (
              <button key={skill.id} type="button" className="button button--secondary" data-skill-chip={skill.name} disabled={locked} onClick={() => actions.pickSkill?.(skill)}>{skill.name}</button>
            ))}
          </div>
        ) : null}
        <form className="composer" aria-label="Send a message" onSubmit={(event: FormEvent) => { event.preventDefault(); actions.send() }}>
          <label className="sr-only" htmlFor="message">Message TARS-NG</label>
          <textarea
            id="message"
            rows={2}
            placeholder="Message TARS-NG…"
            value={state.draft}
            onChange={(event) => actions.draft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
              event.preventDefault()
              if (!sendDisabled) actions.send()
            }}
          />
          <button className="icon-button" type="button" aria-label="Attach file" title="Attachments are not available in this soak" disabled>
            <Glyph name="attach" /><span className="composer-button-label">ATTACH</span><small>INOP</small>
          </button>
          <button className="send-button" type="submit" aria-label="Send message" disabled={sendDisabled}>
            <Glyph name="send" /><span className="composer-button-label">{state.sending ? 'SENDING' : 'SEND'}</span>
          </button>
        </form>
        {state.error ? <p className="error" role="alert">{state.error}</p> : null}
      </div>
    </main>
  )
}
