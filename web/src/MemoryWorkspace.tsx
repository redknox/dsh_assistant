import React from 'react'
import type { MissionControlView } from '../../src/domain/workspace/types'

export interface MemoryWorkspaceActions {
  readonly create?: () => void
  readonly open?: (id: string) => void
  readonly rename?: (id: string, title: string) => void
  readonly archive?: (id: string) => void
  readonly restore?: (id: string) => void
  readonly askDelete?: (id: string) => void
  readonly confirmDelete?: (id: string) => void
}

function formatMemoryDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown activity'
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date)
}

export function MemoryWorkspace(props: {
  readonly view: MissionControlView
  readonly confirmingSession?: string
  readonly actions: MemoryWorkspaceActions
}) {
  const sessions = (props.view.sessions?.sessions ?? [])
    .slice()
    .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))
  return (
    <main className="conversation-panel memory-panel" id="memory" data-workspace-pane="memory">
      <div className="memory-scroll">
        <header className="workspace-heading">
          <div>
            <p className="workspace-kicker">PERSONAL CONTEXT</p>
            <h1>Memory</h1>
            <p>Conversation history, remembered facts, and local knowledge are related—but they are not the same thing.</p>
          </div>
          <dl className="memory-summary" aria-label="Memory summary">
            <div><dt>Conversations</dt><dd>{sessions.length}</dd></div>
            <div><dt>Remembered facts</dt><dd>{props.view.memory.length}</dd></div>
            <div><dt>Knowledge sources</dt><dd>{props.view.knowledge.length}</dd></div>
          </dl>
        </header>

        <section className="memory-section" aria-labelledby="memory-conversations-title">
          <div className="memory-section-heading">
            <div><p>SESSION HISTORY</p><h2 id="memory-conversations-title">Conversations</h2></div>
            <button type="button" className="memory-primary-action" onClick={props.actions.create}>New conversation</button>
          </div>
          <div className="memory-card-grid" data-memory-cards="conversations">
            {sessions.length === 0 ? <p className="memory-empty">No conversations yet.</p> : sessions.map((session) => (
              <article key={session.id} className={`memory-card conversation-card${session.current ? ' conversation-card--current' : ''}`} data-session-id={session.id}>
                <div className="memory-card-topline">
                  <span className={`memory-badge${session.current ? ' memory-badge--current' : ''}`}>{session.current ? 'Current' : session.lifecycle}</span>
                  <span>{formatMemoryDate(session.lastActivityAt)}</span>
                </div>
                <h3>{session.title}</h3>
                <p>{session.preview || 'No conversation preview yet.'}</p>
                <div className="memory-card-actions">
                  {session.lifecycle === 'archived' ? (
                    <button type="button" onClick={() => props.actions.restore?.(session.id)}>Restore</button>
                  ) : (
                    <button type="button" className="memory-card-open" onClick={() => props.actions.open?.(session.id)}>{session.current ? 'Continue' : 'Open'}</button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      const next = globalThis.prompt?.('Rename conversation', session.title)
                      if (next && next.trim() !== '' && next !== session.title) props.actions.rename?.(session.id, next.trim())
                    }}
                  >
                    Rename
                  </button>
                  {session.lifecycle === 'active' ? <button type="button" onClick={() => props.actions.archive?.(session.id)}>Archive</button> : null}
                  {props.confirmingSession === session.id ? (
                    <button type="button" className="memory-card-danger" onClick={() => props.actions.confirmDelete?.(session.id)}>Confirm delete</button>
                  ) : (
                    <button type="button" onClick={() => props.actions.askDelete?.(session.id)}>Delete</button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="memory-section" aria-labelledby="remembered-facts-title">
          <div className="memory-section-heading"><div><p>DURABLE MEMORY</p><h2 id="remembered-facts-title">Remembered facts</h2></div></div>
          <div className="memory-card-grid" data-memory-cards="facts">
            {props.view.memory.length === 0 ? <p className="memory-empty">Nothing has been committed to long-term memory yet.</p> : props.view.memory.map((item) => (
              <article key={item.id} className="memory-card fact-card">
                <div className="memory-card-topline"><span className="memory-badge">{item.topicKey}</span><span>{item.status}</span></div>
                <p>{item.statement}</p>
                <small>Origin · {item.origin}</small>
              </article>
            ))}
          </div>
        </section>

        <section className="memory-section" aria-labelledby="knowledge-sources-title">
          <div className="memory-section-heading"><div><p>LOCAL REFERENCES</p><h2 id="knowledge-sources-title">Knowledge sources</h2></div></div>
          <div className="memory-card-grid" data-memory-cards="knowledge">
            {props.view.knowledge.length === 0 ? <p className="memory-empty">No local knowledge sources are indexed.</p> : props.view.knowledge.map((item) => (
              <article key={item.sourceUri} className="memory-card knowledge-card">
                <div className="memory-card-topline"><span className="memory-badge">Source</span></div>
                <h3>{item.title ?? 'Untitled source'}</h3>
                <p>{item.excerpt ?? item.sourceUri}</p>
                <small>{item.sourceUri}</small>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  )
}
