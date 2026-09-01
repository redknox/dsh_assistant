import React from 'react'
import type { MissionControlView } from '../../src/domain/workspace/types'
import { Glyph } from './icons'

export type WorkspacePane = 'today' | 'expense-review' | 'capabilities' | 'extensions' | 'tools' | 'workflows' | 'specifications' | 'memory' | 'logs' | 'settings' | 'system-info'

export interface WorkspaceNavigationActions {
  readonly navigate: (pane: WorkspacePane) => void
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
  const buildQueueCount = new Set([
    ...(props.view.candidates ?? [])
      .filter((item) => item.approvalState !== 'active' && item.extensionLifecycle !== 'SUPERSEDED')
      .map((item) => `candidate:${item.id}`),
    ...(props.view.skills ?? [])
      .filter((item) => !item.system && !['active', 'disabled', 'uninstalled'].includes(item.lifecycle))
      .map((item) => `skill:${item.id}`),
  ]).size

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
        <span className="nav-item nav-item--idle" aria-disabled="true" title="Calendar is not connected">
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
      <div className="nav-group-label nav-group-label--system">CAPABILITIES</div>
      <nav className="secondary-nav" aria-label="Capability library">
        <button
          type="button"
          className={`nav-item${props.pane === 'capabilities' ? ' nav-item--active' : ''}`}
          data-nav="capabilities"
          aria-current={props.pane === 'capabilities' ? 'page' : undefined}
          onClick={() => props.actions.navigate('capabilities')}
        >
          <span className="control-lamp" aria-hidden="true" /><Glyph name="capabilities" /><span>ALL CAPABILITIES</span>
        </button>
        <button
          type="button"
          className={`nav-item${props.pane === 'specifications' ? ' nav-item--active' : ''}`}
          data-nav="specifications"
          aria-current={props.pane === 'specifications' ? 'page' : undefined}
          onClick={() => props.actions.navigate('specifications')}
        >
          <span className="control-lamp" aria-hidden="true" /><Glyph name="hex" /><span>BUILD QUEUE</span>
          {buildQueueCount > 0 ? <strong className="nav-item-count" aria-label={`${buildQueueCount} capability builds in queue`}>{buildQueueCount}</strong> : null}
        </button>
      </nav>
      <div className="nav-group-label nav-group-label--system">SYSTEM</div>
      <nav className="secondary-nav" aria-label="System">
        <button
          type="button"
          className={`nav-item${props.pane === 'system-info' ? ' nav-item--active' : ''}`}
          data-nav="system-info"
          aria-current={props.pane === 'system-info' ? 'page' : undefined}
          onClick={() => props.actions.navigate('system-info')}
        >
          <span className="control-lamp" aria-hidden="true" /><Glyph name="shield" /><span>SYSTEM INFO</span>
        </button>
        <button
          type="button"
          className={`nav-item${props.pane === 'settings' ? ' nav-item--active' : ''}`}
          data-nav="settings"
          aria-current={props.pane === 'settings' ? 'page' : undefined}
          onClick={() => props.actions.navigate('settings')}
        >
          <span className="control-lamp" aria-hidden="true" /><Glyph name="settings" /><span>SETTINGS</span>
        </button>
        <button
          type="button"
          className={`nav-item nav-item--diagnostic${props.pane === 'logs' ? ' nav-item--active' : ''}`}
          data-nav="logs"
          aria-current={props.pane === 'logs' ? 'page' : undefined}
          onClick={() => props.actions.navigate('logs')}
        >
          <span className="control-lamp" aria-hidden="true" /><Glyph name="terminal" /><span>LOGS</span>
        </button>
      </nav>
      <div className="panel-coordinates" aria-label="Local runtime marker">
        <span>SYS 03</span>
        <span>127.0.0.1</span>
      </div>
    </aside>
  )
}
