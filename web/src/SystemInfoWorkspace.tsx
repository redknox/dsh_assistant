import React, { useMemo } from 'react'
import { projectSystemInfo, type SystemSurfaceAction } from '../../src/domain/system-info/index'
import type { MissionControlView } from '../../src/domain/workspace/types'
import { Glyph } from './icons'

export function SystemInfoWorkspace(props: {
  readonly view: Pick<MissionControlView, 'capabilities' | 'contextEndurance' | 'materialInput' | 'runtimeContext' | 'systemState'>
  readonly openSettings: () => void
}) {
  const info = useMemo(() => projectSystemInfo(props.view), [props.view])
  const runtime = props.view.runtimeContext

  return (
    <main className="conversation-panel instrument-panel system-info-workspace" aria-label="System Info">
      <header className="workspace-title system-info-title">
        <div>
          <span className="eyebrow">BUILT-IN SURFACES / RUNTIME DIAGNOSTICS</span>
          <h1>SYSTEM INFO</h1>
          <p>Product-native surfaces, connection health, and runtime context. These are system facts—not capabilities you installed—and cannot be unplugged here.</p>
        </div>
        <button type="button" className="button button--secondary" onClick={props.openSettings}>OPEN SETTINGS</button>
      </header>

      <section className="capability-center-summary" aria-label="System summary">
        <Summary label="BUILT-IN" value={info.summary.builtIn} />
        <Summary label="AVAILABLE" value={info.summary.available} />
        <Summary label="NEEDS CONNECTION" value={info.summary.needsConnection} />
        <Summary label="SYSTEM MODE" value={info.summary.mode.replaceAll('_', ' ')} text />
      </section>

      <section className="system-info-body">
        <section className="system-info-runtime" aria-labelledby="runtime-context-title">
          <div className="system-info-section-title"><span>01</span><h2 id="runtime-context-title">RUNTIME CONTEXT</h2></div>
          <dl>
            <Fact label="PROFILE" value={runtime?.profile ?? 'Unknown'} />
            <Fact label="WORKSPACE" value={runtime?.workspaceLabel ?? 'Unknown'} />
            <Fact label="SESSION" value={runtime?.sessionId ?? 'Unknown'} />
            <Fact label="PERSISTENCE" value={runtime?.sessionPersistence ?? 'Unknown'} />
            <Fact label="COMPACTION" value={props.view.contextEndurance?.compaction ?? 'Unavailable'} />
            <Fact label="CHECKPOINT" value={props.view.contextEndurance?.checkpoint ?? 'Unavailable'} />
            <Fact label="OUTPUT SPILL" value={props.view.contextEndurance?.outputRetention?.spill ?? 'Unavailable'} />
            <Fact label="FILE REFERENCES" value={props.view.materialInput?.fileReferences ?? 'Unavailable'} />
          </dl>
        </section>

        <section className="system-info-surfaces" aria-labelledby="built-in-surfaces-title">
          <div className="system-info-section-title"><span>02</span><h2 id="built-in-surfaces-title">BUILT-IN SURFACES</h2></div>
          <div className="system-surface-grid">
            {info.surfaces.map((surface) => (
              <article className="system-surface-card" key={surface.id} data-system-surface={surface.id} data-availability={surface.availability}>
                <header>
                  <span className="system-surface-lamp" aria-hidden="true" />
                  <div><h3>{surface.name}</h3><small>{surface.provider ? `PROVIDER · ${surface.provider}` : 'PRODUCT NATIVE'}</small></div>
                  <strong>{availabilityLabel(surface.availability)}</strong>
                </header>
                <ul>
                  {surface.actions.map((action) => <li key={action.name}><span>{action.name}</span><em>{actionLabel(action.state)}</em></li>)}
                </ul>
              </article>
            ))}
          </div>
        </section>
      </section>

      <footer className="capability-center-footer">
        <Glyph name="settings" />
        <p><strong>SYSTEM FACTS, NOT USER INSTALLATIONS</strong><span>Configure connections in Settings. Inspect execution evidence in Logs. Installed capabilities remain in Capability Center.</span></p>
      </footer>
    </main>
  )
}

function Summary(props: { readonly label: string; readonly value: string | number; readonly text?: boolean }) {
  return <div><span>{props.label}</span><strong className={props.text ? 'system-summary-text' : undefined}>{props.value}</strong></div>
}

function Fact(props: { readonly label: string; readonly value: string }) {
  return <div><dt>{props.label}</dt><dd>{props.value.replaceAll('-', ' ').toUpperCase()}</dd></div>
}

function availabilityLabel(value: 'available' | 'not-connected' | 'unavailable' | 'withheld'): string {
  return value.replaceAll('-', ' ').toUpperCase()
}

function actionLabel(value: SystemSurfaceAction['state']): string {
  if (value === 'approval-on-use') return 'APPROVAL ON USE'
  return value.replaceAll('-', ' ').toUpperCase()
}
