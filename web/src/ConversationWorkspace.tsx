import React, { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { formatFileMention, type FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference'
import type { ActivationCard, ApprovalCard, MissionControlView, SkillProjection, WorkObjectKind } from '../../src/domain/workspace/types'
import { Glyph } from './icons'
import { MarkdownMessage } from './MarkdownMessage'
import { formatDiff, isPendingApproval, skillInvocationSurfaceOpen } from './missionControlPresentation'
import { listFileReferences } from './api'

export interface ConversationWorkspaceState {
  readonly connected: boolean
  readonly sending: boolean
  readonly draft: string
  readonly error?: string
  readonly activations: readonly ActivationCard[]
  readonly armedActivation?: string
  readonly armedAbandonment?: string
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
        <div>
          <p className="approval-kicker">APPROVAL REQUIRED · ONE EXACT ACTION</p>
          <h2 id={`approval-title-${card.id}`}>{card.title}</h2>
        </div>
      </header>
      <p className="approval-guidance">Review the target and exact change below. Approving permits this action once.</p>
      <dl className="approval-facts">
        <div><dt>TARGET</dt><dd>{card.target}</dd></div>
        {card.details.map((line) => <div key={line}><dt>CHANGE</dt><dd>{line}</dd></div>)}
      </dl>
      <div className="effect-line">
        <Glyph name="info" className="glyph effect-icon" />
        <span><strong>WHAT WILL HAPPEN</strong> {card.sideEffect}</span>
      </div>
      <details className="approval-technical">
        <summary>TECHNICAL DETAILS</summary>
        <dl className="approval-facts approval-facts--technical">
          <div><dt>AUTHORITY</dt><dd>{card.authorityChange}</dd></div>
          <div><dt>FINGERPRINT</dt><dd>{card.fingerprint}</dd></div>
          {card.candidateId ? <div><dt>CANDIDATE</dt><dd>{card.candidateId}</dd></div> : null}
          {card.digest ? <div><dt>DIGEST</dt><dd>{card.digest}</dd></div> : null}
        </dl>
      </details>
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

export function ConversationWorkspace(props: {
  readonly view: MissionControlView
  readonly state: ConversationWorkspaceState
  readonly actions: ConversationWorkspaceActions
  readonly active?: boolean
}) {
  const { state, actions } = props
  const locked = !state.connected
  const sendDisabled = state.sending || locked || state.draft.trim() === ''
  const pendingApprovals = useMemo(() => props.view.approvals.filter((card) => isPendingApproval(card.status)), [props.view.approvals])
  const empty = props.view.conversation.length === 0
    && pendingApprovals.length === 0
    && state.activations.length === 0
    && !props.view.workBrief?.markdown
  const scrollViewport = useRef<HTMLDivElement>(null)
  const followingTail = useRef(true)
  const [referenceOpen, setReferenceOpen] = useState(false)
  const [referenceQuery, setReferenceQuery] = useState('')
  const [referenceCandidates, setReferenceCandidates] = useState<readonly FileReferenceCandidate[]>([])
  const [referenceLoading, setReferenceLoading] = useState(false)
  const [referenceError, setReferenceError] = useState<string>()
  const referencesReady = props.view.materialInput?.fileReferences === 'active'
  const tailRevision = `${props.view.conversation.length}:${props.view.conversation.at(-1)?.text.length ?? 0}:${pendingApprovals.length}:${state.activations.length}:${state.sending ? 1 : 0}`
  useEffect(() => {
    if (props.active === false || !followingTail.current) return
    const viewport = scrollViewport.current
    if (!viewport) return
    const followTail = () => {
      if (followingTail.current) viewport.scrollTop = viewport.scrollHeight
    }
    followTail()
    const frame = globalThis.requestAnimationFrame?.(followTail)
    return () => { if (frame !== undefined) globalThis.cancelAnimationFrame?.(frame) }
  }, [props.active, tailRevision])
  useEffect(() => {
    if (!referenceOpen || !referencesReady) return
    let cancelled = false
    setReferenceLoading(true)
    setReferenceError(undefined)
    const timer = globalThis.setTimeout(() => {
      void listFileReferences(referenceQuery).then((candidates) => {
        if (!cancelled) setReferenceCandidates(candidates)
      }).catch((error: unknown) => {
        if (!cancelled) setReferenceError(error instanceof Error ? error.message : 'file reference lookup failed')
      }).finally(() => {
        if (!cancelled) setReferenceLoading(false)
      })
    }, 120)
    return () => {
      cancelled = true
      globalThis.clearTimeout(timer)
    }
  }, [referenceOpen, referenceQuery, referencesReady])
  const chooseReference = (candidate: FileReferenceCandidate) => {
    if (candidate.kind === 'directory') {
      setReferenceQuery(`${candidate.path}/`)
      return
    }
    const mention = formatFileMention(candidate, false)
    if (!mention) return
    actions.draft(state.draft.trimEnd() === '' ? mention : `${state.draft.trimEnd()} ${mention}`)
    setReferenceOpen(false)
    setReferenceQuery('')
  }
  return (
    <main className="conversation-panel" id="today">
      <div
        className="conversation-scroll"
        ref={scrollViewport}
        data-follow-tail="true"
        onScroll={(event) => {
          const viewport = event.currentTarget
          followingTail.current = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 32
        }}
      >
        {props.view.workBrief?.markdown ? (
          <details className="work-brief-card" data-work-brief-status={props.view.workBrief.status} open>
            <summary>
              <span><Glyph name="today" /> DAILY WORK BRIEF</span>
              <small>{props.view.workBrief.generatedAt ? new Date(props.view.workBrief.generatedAt).toLocaleString() : 'LATEST COMPLETED RUN'}</small>
            </summary>
            <div className="work-brief-body"><MarkdownMessage text={props.view.workBrief.markdown} /></div>
          </details>
        ) : null}
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
        {pendingApprovals.map((card) => (
          <ApprovalCardView key={card.id} card={card} locked={locked} actions={actions} />
        ))}
        {state.activations.map((card) => (
          <ActivationCardView key={`act-${card.id}`} card={card} locked={locked} armed={state.armedActivation === card.id} abandonArmed={state.armedAbandonment === card.id} actions={actions} />
        ))}
      </div>
      <div>
        {skillInvocationSurfaceOpen(props.view) && (props.view.skills ?? []).some((skill) => skill.userInvocable && skill.lifecycle === 'active') ? (
          <div className="composer-chips" data-skill-chips="true">
            {(props.view.skills ?? []).filter((skill) => skill.userInvocable && skill.lifecycle === 'active').map((skill) => (
              <button key={skill.id} type="button" className="button button--secondary" data-skill-chip={skill.name} disabled={locked} onClick={() => actions.pickSkill?.(skill)}>{skill.name}</button>
            ))}
          </div>
        ) : null}
        {referenceOpen ? (
          <section className="file-reference-picker" aria-label="Reference a file">
            <header><strong>REFERENCE FILE</strong><span>PATH ONLY · CONTENT READ ON DEMAND</span></header>
            <input autoFocus value={referenceQuery} onChange={(event) => setReferenceQuery(event.target.value)} placeholder="Search the governed Files sandbox" />
            <div className="file-reference-results">
              {referenceLoading ? <p>SCANNING…</p> : null}
              {referenceError ? <p className="error" role="alert">{referenceError}</p> : null}
              {!referenceLoading && !referenceError && referenceCandidates.length === 0 ? <p>NO MATCHES</p> : null}
              {referenceCandidates.map((candidate) => (
                <button key={`${candidate.kind}:${candidate.path}`} type="button" onClick={() => chooseReference(candidate)}>
                  <Glyph name={candidate.kind === 'directory' ? 'folder' : 'files'} />
                  <span>{candidate.path}{candidate.kind === 'directory' ? '/' : ''}</span>
                  <small>{candidate.kind.toUpperCase()}</small>
                </button>
              ))}
            </div>
          </section>
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
          <button className="icon-button" type="button" aria-label="Reference file" title="Reference a file from the governed Files sandbox" aria-expanded={referenceOpen} disabled={locked || !referencesReady} onClick={() => setReferenceOpen((open) => !open)}>
            <Glyph name="attach" /><span className="composer-button-label">REFERENCE</span><small>{referencesReady ? '@FILE' : 'INOP'}</small>
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
