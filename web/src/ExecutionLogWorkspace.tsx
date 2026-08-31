import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ExecutionLogEntry, ExecutionLogKind, MissionControlView } from '../../src/domain/workspace/types'
import { Glyph } from './icons'

type LogFilter = 'all' | 'calls' | 'results' | 'notes'

function logCode(kind: ExecutionLogKind): string {
  if (kind === 'agent-note') return 'NOTE'
  if (kind === 'tool-call' || kind === 'command-run') return 'CALL'
  return 'RETURN'
}

function compactDetail(detail: string): string {
  return detail.replace(/\s+/g, ' ').trim() || '—'
}

function formattedDetail(detail: string): string {
  const trimmed = detail.trim()
  if (!trimmed) return '—'
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return detail
  }
}

function matchesFilter(entry: ExecutionLogEntry, filter: LogFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'notes') return entry.kind === 'agent-note'
  if (filter === 'calls') return entry.kind === 'tool-call' || entry.kind === 'command-run'
  return entry.kind === 'tool-result' || entry.kind === 'command-result'
}

export function LiveExecutionLog(props: {
  readonly entries: readonly ExecutionLogEntry[]
  readonly open: () => void
}) {
  const viewport = useRef<HTMLOListElement>(null)
  const visible = props.entries.slice(-14)
  useEffect(() => {
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
  }, [props.entries.length])
  return (
    <section className="live-log-section" aria-labelledby="live-log-title">
      <div className="ops-section-heading live-log-heading">
        <h2 id="live-log-title">LIVE EXECUTION LOG</h2>
        <span><i className="status-lamp status-lamp--working" aria-hidden="true" /> {props.entries.length} EVENTS</span>
      </div>
      <ol className="telemetry-stream" ref={viewport} role="log" aria-live="off">
        {visible.length === 0 ? <li className="telemetry-empty">SYS · AWAITING EXECUTION DATA</li> : visible.map((entry) => (
          <li key={entry.id} data-log-kind={entry.kind} data-log-error={entry.isError ? 'true' : undefined}>
            <span className="telemetry-seq">{String(entry.seq).padStart(4, '0')}</span>
            <strong>{logCode(entry.kind)}</strong>
            <span className="telemetry-label">{entry.label}</span>
            <code>{compactDetail(entry.detail)}</code>
          </li>
        ))}
      </ol>
      <button type="button" className="button button--secondary live-log-open" data-open-log="true" onClick={props.open}><Glyph name="terminal" /> OPEN FULL LOG</button>
    </section>
  )
}

export function ExecutionLogWorkspace(props: { readonly view: MissionControlView }) {
  const [filter, setFilter] = useState<LogFilter>('all')
  const entries = useMemo(() => (props.view.executionLog ?? []).filter((entry) => matchesFilter(entry, filter)), [props.view.executionLog, filter])
  return (
    <main className="conversation-panel execution-log-panel" id="logs" data-workspace-pane="logs">
      <header className="execution-log-header">
        <div>
          <p className="empty-kicker">SESSION TELEMETRY · READ ONLY</p>
          <h1>Execution Log</h1>
          <p>Visible agent notes, tool calls, arguments, results, and failures. Hidden model reasoning is never recorded here.</p>
        </div>
        <div className="execution-log-counter"><strong>{props.view.executionLog?.length ?? 0}</strong><span>EVENTS</span></div>
      </header>
      <nav className="execution-log-filters" aria-label="Execution log filters">
        {(['all', 'calls', 'results', 'notes'] as const).map((item) => <button key={item} type="button" className={filter === item ? 'is-active' : ''} aria-pressed={filter === item} onClick={() => setFilter(item)}>{item.toUpperCase()}</button>)}
      </nav>
      <ol className="execution-log-list">
        {entries.length === 0 ? <li className="execution-log-empty">NO EVENTS IN THIS CHANNEL</li> : entries.map((entry) => (
          <li key={entry.id} data-log-kind={entry.kind} data-log-error={entry.isError ? 'true' : undefined}>
            <header>
              <span className="execution-log-seq">SEQ {String(entry.seq).padStart(4, '0')}</span>
              <strong>{logCode(entry.kind)}</strong>
              <span>{entry.label}</span>
              {entry.callId ? <small>CALL {entry.callId}</small> : null}
            </header>
            <pre>{formattedDetail(entry.detail)}</pre>
          </li>
        ))}
      </ol>
    </main>
  )
}
