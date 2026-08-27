import React from 'react'
import type { MissionControlView } from '../../src/domain/workspace/types'
import { Glyph } from './icons'

export type WorkspacePane = 'today' | 'extensions' | 'memory'

export interface WorkspaceNavigationActions {
  readonly navigate: (pane: WorkspacePane) => void
  readonly openOperations: () => void
  readonly createConversation?: () => void
  readonly switchConversation?: (id: string) => void
}

export function WorkspaceNavigation(props: {
  readonly view: MissionControlView
  readonly pane: WorkspacePane
  readonly actions: WorkspaceNavigationActions
}) {
  const recentSessions = (props.view.sessions?.sessions ?? [])
    .filter((item) => item.lifecycle === 'active')
    .slice()
    .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))
    .slice(0, 4)

  return (
    <aside className="nav-panel instrument-panel" aria-label="Workspace navigation">
      <div className="panel-code">
        <span>NAV 01</span>
        <span>LOCAL / PRIMARY</span>
      </div>
      <div className="nav-group-label">WORKSPACE</div>
      <nav className="primary-nav" aria-label="Workspace">
        <button
          type="button"
          className={`nav-item${props.pane === 'today' ? ' nav-item--active' : ''}`}
          data-nav="today"
          aria-current={props.pane === 'today' ? 'page' : undefined}
          onClick={() => props.actions.navigate('today')}
        >
          <span className="control-lamp" aria-hidden="true" /><Glyph name="today" /><span>TODAY</span>
        </button>
        <span className="nav-item nav-item--idle" aria-disabled="true" title="Calendar management is not available in this soak">
          <span className="control-lamp" aria-hidden="true" /><Glyph name="calendar" /><span>CALENDAR</span>
        </span>
        <button
          type="button"
          className={`nav-item${props.pane === 'memory' ? ' nav-item--active' : ''}`}
          data-nav="memory"
          aria-current={props.pane === 'memory' ? 'page' : undefined}
          onClick={() => props.actions.navigate('memory')}
        >
          <span className="control-lamp" aria-hidden="true" /><Glyph name="memory" /><span>MEMORY</span>
        </button>
      </nav>
      <section className="nav-conversations" aria-labelledby="recent-conversations-title">
        <div className="nav-section-heading">
          <span id="recent-conversations-title">RECENT CONVERSATIONS</span>
          <button type="button" aria-label="New conversation" title="New conversation" onClick={props.actions.createConversation}>+</button>
        </div>
        <div className="conversation-shortcuts">
          {recentSessions.length === 0 ? <p className="nav-empty">No conversations yet</p> : recentSessions.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`conversation-shortcut${item.current ? ' conversation-shortcut--current' : ''}`}
              data-session-id={item.id}
              onClick={() => props.actions.switchConversation?.(item.id)}
            >
              <span className="control-lamp" aria-hidden="true" />
              <span>{item.title}</span>
              <small>{item.preview || 'No preview yet'}</small>
            </button>
          ))}
        </div>
        <button type="button" className="view-all-conversations" onClick={() => props.actions.navigate('memory')}>View all in Memory <span aria-hidden="true">→</span></button>
      </section>
      <div className="nav-group-label nav-group-label--system">SYSTEM</div>
      <nav className="secondary-nav" aria-label="System">
        <button
          type="button"
          className={`nav-item${props.pane === 'extensions' ? ' nav-item--active' : ''}`}
          data-nav="extensions"
          aria-current={props.pane === 'extensions' ? 'page' : undefined}
          onClick={() => props.actions.navigate('extensions')}
        >
          <span className="control-lamp" aria-hidden="true" /><Glyph name="capabilities" /><span>EXTENSIONS</span>
        </button>
        <button type="button" className="nav-item" data-nav="capabilities" onClick={props.actions.openOperations}>
          <span className="control-lamp" aria-hidden="true" /><Glyph name="capabilities" /><span>CAPABILITIES</span>
        </button>
      </nav>
      <div className="panel-coordinates" aria-label="Local runtime marker">
        <span>SYS 03</span>
        <span>127.0.0.1</span>
      </div>
    </aside>
  )
}
