import React from 'react'
import type { MissionControlView } from '../../src/domain/workspace/types'
import { PlateRivets } from './Faceplate'
import { recoveryActionId, type RecoveryAction } from './missionControlPresentation'

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

export function SystemHeader(props: {
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
          <span className={`status-lamp status-lamp--${lampModifier(props.systemState, props.connected)}`} aria-hidden="true" />
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

export function RecoveryPanel(props: {
  readonly systemState: MissionControlView['systemState']
  readonly recovery: NonNullable<MissionControlView['recovery']>
  readonly locked: boolean
  readonly armedRecovery?: string
  readonly error?: string
  readonly onRecovery: (action: RecoveryAction) => void
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
