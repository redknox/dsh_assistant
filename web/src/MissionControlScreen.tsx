import React, { useState } from 'react'
import type { ActivationCard, ApprovalCard, MissionControlView, RollbackCard, SkillProjection, UserPluginView } from '../../src/domain/workspace/types'
import { ConversationWorkspace } from './ConversationWorkspace'
import { ExtensionsWorkspace } from './ExtensionsWorkspace'
import { Glyph } from './icons'
import { MemoryWorkspace } from './MemoryWorkspace'
import { ControlStripView, OperationsPanel } from './OperationalStatus'
import { RecoveryPanel, SystemHeader } from './SystemStatus'
import { WorkspaceNavigation, type WorkspacePane } from './WorkspaceNavigation'

type CompactSurface = 'conversation' | 'navigation' | 'operations'

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
  readonly onAbandonActivation?: (card: ActivationCard) => void
  readonly onDeferActivation?: (card: ActivationCard) => void
  readonly deferredActivations?: readonly string[]
  readonly armedActivation?: string
  readonly armedAbandonment?: string
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
  readonly confirmingSkill?: string
  readonly armedSkill?: string
  readonly skillDependents?: { readonly id: string; readonly dependents: readonly string[] }
  readonly onSkillAction?: (action: 'approve' | 'reject' | 'activate' | 'disable' | 'reactivate' | 'uninstall' | 'rollback', skill?: SkillProjection) => void
  readonly onPickSkill?: (skill: SkillProjection) => void
}) {
  const { view } = props
  const safe = view.systemState === 'SAFE_MODE' || view.systemState === 'RECOVERY'
  const locked = !props.connected
  const pane = props.pane ?? 'today'
  const [compactSurface, setCompactSurface] = useState<CompactSurface>('conversation')
  const navigate = (next: WorkspacePane) => {
    props.onNavigate?.(next)
    setCompactSurface('conversation')
  }
  const openOperations = () => {
    setCompactSurface('operations')
    globalThis.setTimeout(() => globalThis.document?.getElementById('capabilities')?.scrollIntoView({ block: 'start' }), 0)
  }
  return (
    <div className="chassis" data-shuttle-variant="A">
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
      <nav className="compact-workspace-nav" aria-label="Compact workspace">
        <button type="button" className={compactSurface === 'navigation' ? 'is-active' : ''} aria-pressed={compactSurface === 'navigation'} onClick={() => setCompactSurface('navigation')}>
          <span className="control-lamp" aria-hidden="true" /><Glyph name="conversations" /><span>Navigate</span>
        </button>
        <button type="button" className={compactSurface === 'conversation' ? 'is-active' : ''} aria-pressed={compactSurface === 'conversation'} onClick={() => setCompactSurface('conversation')}>
          <span className="control-lamp" aria-hidden="true" /><Glyph name="today" /><span>Workspace</span>
        </button>
        <button type="button" className={compactSurface === 'operations' ? 'is-active' : ''} aria-pressed={compactSurface === 'operations'} onClick={() => setCompactSurface('operations')}>
          <span className="control-lamp" aria-hidden="true" /><Glyph name="capabilities" /><span>Status</span>
        </button>
      </nav>
      <div className="workspace-grid" data-compact-surface={compactSurface}>
        <WorkspaceNavigation
          view={view}
          pane={pane}
          actions={{
            navigate,
            openOperations,
            createConversation: props.onCreateConversation,
            switchConversation: props.onSwitchConversation,
          }}
        />
        {pane === 'extensions' ? (
          <ExtensionsWorkspace
            view={view}
            state={{
              locked,
              inspecting: props.inspectingExtension,
              confirmingPlugin: props.confirmingPlugin,
              armedActivation: props.armedActivation,
              armedAbandonment: props.armedAbandonment,
              confirmingSkill: props.confirmingSkill,
              armedSkill: props.armedSkill,
              skillDependents: props.skillDependents,
            }}
            actions={{
              inspect: props.onInspectExtension ?? (() => {}),
              approve: props.onApprove,
              reject: props.onReject,
              activate: props.onActivate,
              abandonActivation: props.onAbandonActivation,
              askUninstall: props.onAskUninstall,
              cancelUninstall: props.onCancelUninstall,
              confirmUninstall: props.onConfirmUninstall,
              skill: props.onSkillAction ?? (() => {}),
            }}
          />
        ) : pane === 'memory' ? (
          <MemoryWorkspace
            view={view}
            confirmingSession={props.confirmingSession}
            actions={{
              create: props.onCreateConversation,
              open: (id) => {
                props.onSwitchConversation?.(id)
                navigate('today')
              },
              rename: props.onRenameConversation,
              archive: props.onArchiveConversation,
              restore: props.onRestoreConversation,
              askDelete: props.onAskDeleteConversation,
              confirmDelete: props.onConfirmDeleteConversation,
            }}
          />
        ) : (
        <ConversationWorkspace
          view={view}
          state={{
            connected: props.connected,
            sending: props.sending,
            draft: props.draft,
            error: props.error,
            activations: (view.activations ?? []).filter((card) => !(props.deferredActivations ?? []).includes(card.id)),
            armedActivation: props.armedActivation,
            armedAbandonment: props.armedAbandonment,
            rollback: view.rollback,
            deferredRollback: props.deferredRollback,
            armedRollback: props.armedRollback,
          }}
          actions={{
            draft: props.onDraft,
            send: props.onSend,
            approve: props.onApprove,
            reject: props.onReject,
            activate: props.onActivate ?? (() => {}),
            abandonActivation: props.onAbandonActivation ?? (() => {}),
            deferActivation: props.onDeferActivation ?? (() => {}),
            pickSkill: props.onPickSkill,
            askRollback: props.onAskRollback,
            deferRollback: props.onDeferRollback,
          }}
        />
        )}
        <OperationsPanel
          view={view}
          connected={props.connected}
          confirmingPlugin={props.confirmingPlugin}
          actions={{
            askUninstall: props.onAskUninstall,
            cancelUninstall: props.onCancelUninstall,
            confirmUninstall: props.onConfirmUninstall,
            openExtensions: () => navigate('extensions'),
          }}
        />
      </div>
      <ControlStripView view={view} connected={props.connected} />
    </div>
    </div>
  )
}
