import React, { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { MissionControlView } from '../../src/domain/workspace/types'
import {
  decideApproval,
  fetchView,
  formatMarkdownLite,
  openViewStream,
  runRecovery,
  sendMessage,
  type UiEnvelope,
} from './api'

export function MissionControlScreen(props: {
  readonly view: MissionControlView
  readonly connected: boolean
  readonly sending: boolean
  readonly error?: string
  readonly draft: string
  readonly onDraft: (value: string) => void
  readonly onSend: () => void
  readonly onApprove: (id: string) => void
  readonly onReject: (id: string) => void
  readonly onRecovery: (action: 'diagnostics' | 'rollback' | 'restart-normally') => void
}) {
  const { view } = props
  const safe = view.systemState === 'SAFE_MODE' || view.systemState === 'RECOVERY'
  return (
    <div className={`shell${safe ? ' shell-safe' : ''}`} data-system-state={view.systemState} data-connected={props.connected ? 'yes' : 'no'}>
      <header>
        <strong>{view.identity}</strong>
        <span className="objective">{view.objective?.text ?? 'No active objective'}</span>
        <span className={`state state-${view.systemState}`}>{view.systemState}</span>
      </header>
      {!props.connected ? <p className="transport" role="status">Disconnected from local runtime</p> : null}
      {safe && view.recovery ? (
        <section className="recovery" data-recovery="true">
          <h1>{view.systemState}</h1>
          <p>{view.recovery.why}</p>
          <p>Disabled: {view.recovery.disabled.join(', ') || 'generated/optional capabilities'}</p>
          <div className="recovery-actions">
            {view.recovery.actions.map((action) => {
              const mapped = action === 'Diagnostics' ? 'diagnostics' : action === 'Rollback' ? 'rollback' : action === 'Restart normally' ? 'restart-normally' : undefined
              return mapped ? (
                <button key={action} type="button" onClick={() => props.onRecovery(mapped)}>{action}</button>
              ) : (
                <button key={action} type="button" disabled title="Not available from this Web UI">{action}</button>
              )
            })}
          </div>
        </section>
      ) : null}
      <div id="layout">
        <aside id="context">
          <h2>Context</h2>
          <h3>Memory</h3>
          <ul>
            {view.memory.slice(0, 8).map((item) => (
              <li key={item.id}>{item.topicKey}: {item.statement}</li>
            ))}
          </ul>
          <h3>Knowledge</h3>
          <ul>
            {view.knowledge.slice(0, 8).map((item) => (
              <li key={item.sourceUri}>{item.title ?? item.sourceUri}</li>
            ))}
          </ul>
          <h3>Capabilities</h3>
          <ul>
            {view.capabilities.map((item) => (
              <li key={`${item.area}-${item.action}`} data-status={item.status}>
                {item.area} — {item.status}
              </li>
            ))}
          </ul>
        </aside>
        <main>
          <h2>Conversation / Work</h2>
          <ol className="conversation">
            {view.conversation.map((item, index) => (
              <li key={`${item.kind}-${index}`} data-kind={item.kind} dangerouslySetInnerHTML={{ __html: formatMarkdownLite(item.text) }} />
            ))}
          </ol>
          {view.approvals.map((card) => (
            <article key={card.id} className="approval" data-approval-id={card.id} data-kind={card.kind} data-fingerprint={card.fingerprint}>
              <h3>{card.title}</h3>
              <p>Target {card.target}</p>
              <p>External side effect: {card.sideEffect}</p>
              <p>Authority change: {card.authorityChange}</p>
              <p>Fingerprint {card.fingerprint}</p>
              <ul>{card.details.map((line) => <li key={line}>{line}</li>)}</ul>
              {card.status === 'pending' || card.status === 'approval-requested' || card.status === 'unreviewed' ? (
                <div>
                  <button type="button" onClick={() => props.onApprove(card.id)}>Approve</button>
                  <button type="button" onClick={() => props.onReject(card.id)}>Reject</button>
                </div>
              ) : <p>Status {card.status}</p>}
            </article>
          ))}
          <form onSubmit={(event: FormEvent) => { event.preventDefault(); props.onSend() }}>
            <label>
              Message
              <textarea value={props.draft} onChange={(event) => props.onDraft(event.target.value)} rows={3} />
            </label>
            <button type="submit" disabled={props.sending || !props.connected || props.draft.trim() === ''}>
              {props.sending ? 'Sending' : 'Send'}
            </button>
          </form>
          {props.error ? <p className="error" role="alert">{props.error}</p> : null}
        </main>
        <aside id="activity">
          <h2>Activity</h2>
          <ul>
            {view.activity.map((item) => (
              <li key={item.id} data-activity={item.kind}>{item.kind} — {item.summary}</li>
            ))}
          </ul>
        </aside>
      </div>
      <footer>
        <span>Provider / mode {view.controlStrip.mode}</span>
        <span>Pending {view.controlStrip.pendingApprovals}</span>
        <span>Jobs {view.controlStrip.backgroundJobs}</span>
        {view.controlStrip.degradation ? <span>{view.controlStrip.degradation}</span> : null}
        <span data-control-plane="user-workspace">workspace</span>
      </footer>
    </div>
  )
}

export function App() {
  const [envelope, setEnvelope] = useState<UiEnvelope | undefined>()
  const [connected, setConnected] = useState(false)
  const [sending, setSending] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string>()

  useEffect(() => {
    let closed = false
    fetchView().then((next) => { if (!closed) setEnvelope(next) }).catch((caught: unknown) => {
      if (!closed) setError(caught instanceof Error ? caught.message : 'unable to load workspace')
    })
    const stop = openViewStream((next) => setEnvelope(next), setConnected)
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
      onDraft={setDraft}
      onSend={() => { void onSend() }}
      onApprove={(id) => { void act(() => decideApproval(id, 'approve')) }}
      onReject={(id) => { void act(() => decideApproval(id, 'deny')) }}
      onRecovery={(action) => { void act(() => runRecovery(action)) }}
    />
  )
}
