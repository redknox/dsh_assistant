import React, { useState } from 'react'
import type { ActivationCard, ApprovalCard, MissionControlView, SkillProjection, UserPluginView } from '../../src/domain/workspace/types'
import { ConversationWorkspace } from './ConversationWorkspace'
import { ExtensionsWorkspace } from './ExtensionsWorkspace'
import { ExecutionLogWorkspace } from './ExecutionLogWorkspace'
import { Glyph } from './icons'
import { MemoryWorkspace } from './MemoryWorkspace'
import { SettingsWorkspace } from './SettingsWorkspace'
import { ControlStripView, OperationsPanel } from './OperationalStatus'
import { RecoveryPanel, SystemHeader } from './SystemStatus'
import { WorkspaceNavigation, type WorkspacePane } from './WorkspaceNavigation'
import type { ConversationControl } from './useConversationControl'
import type { GovernanceControl } from './useGovernanceControl'
import type { MissionControlRuntime } from './useMissionControlRuntime'
import type { SkillControl } from './useSkillControl'
import type { WorkspaceControl } from './useWorkspaceControl'
import type { SettingsControl } from './useSettingsControl'
import { answerTaskQuestion, controlGoal, controlPlan } from './api'
import { CapabilitySpecificationsWorkspace } from './CapabilitySpecificationsWorkspace'
import type { CapabilitySpecificationsControl } from './useCapabilitySpecifications'
import { ExpenseReviewWorkspace } from './ExpenseReviewWorkspace'
import type { ExpenseReviewControl } from './useExpenseReview'

type CompactSurface = 'conversation' | 'navigation' | 'operations'

export interface MissionControlScreenProps {
  readonly view: MissionControlView
  readonly runtime: Pick<MissionControlRuntime, 'connected' | 'error' | 'acknowledgement' | 'dismissAcknowledgement' | 'perform'>
  readonly conversation: ConversationControl
  readonly governance: GovernanceControl
  readonly workspace: WorkspaceControl
  readonly skill: SkillControl
  readonly settings: SettingsControl
  readonly specifications: CapabilitySpecificationsControl
  readonly expenseReview: ExpenseReviewControl
  readonly navigation: {
    readonly pane: WorkspacePane
    readonly navigate: (pane: WorkspacePane) => void
  }
}

function projectScreenControls(input: MissionControlScreenProps) {
  return {
    view: input.view,
    connected: input.runtime.connected,
    error: input.runtime.error,
    acknowledgement: input.runtime.acknowledgement,
    onDismissAcknowledgement: input.runtime.dismissAcknowledgement,
    sending: input.conversation.sending,
    executingCommand: input.conversation.executingCommand,
    draft: input.conversation.draft,
    onDraft: (value: string) => input.conversation.dispatch({ action: 'draft', value }),
    onSend: () => input.conversation.dispatch({ action: 'send' }),
    onCreateConversation: () => input.conversation.dispatch({ action: 'create' }),
    onSwitchConversation: (id: string) => input.conversation.dispatch({ action: 'switch', id }),
    onRenameConversation: (id: string, title: string) => input.conversation.dispatch({ action: 'rename', id, title }),
    onArchiveConversation: (id: string) => input.conversation.dispatch({ action: 'archive', id }),
    onRestoreConversation: (id: string) => input.conversation.dispatch({ action: 'restore', id }),
    onPickSkill: (skill: SkillProjection) => input.conversation.dispatch({ action: 'suggest-skill', name: skill.name }),
    armedRecovery: input.governance.state.armedRecovery,
    deferredActivations: input.governance.state.deferredActivations,
    armedActivation: input.governance.state.armedActivation,
    armedAbandonment: input.governance.state.armedAbandonment,
    onApprove: (card: ApprovalCard) => input.governance.dispatch({ action: 'approve', card }),
    onReject: (card: ApprovalCard) => input.governance.dispatch({ action: 'reject', card }),
    onActivate: (card: ActivationCard) => input.governance.dispatch({ action: 'activate', card }),
    onAbandonActivation: (card: ActivationCard) => input.governance.dispatch({ action: 'abandon-activation', card }),
    onDeferActivation: (card: ActivationCard) => input.governance.dispatch({ action: 'defer-activation', card }),
    onRecovery: (recovery: 'diagnostics' | 'rollback' | 'exit-safe-mode') => input.governance.dispatch({ action: 'recover', recovery }),
    pane: input.navigation.pane,
    onNavigate: input.navigation.navigate,
    confirmingSession: input.workspace.state.confirmingSession,
    inspectingExtension: input.workspace.state.inspectingExtension,
    confirmingPlugin: input.workspace.state.confirmingPlugin?.id,
    onAskDeleteConversation: (id: string) => input.workspace.dispatch({ action: 'ask-conversation-delete', id }),
    onConfirmDeleteConversation: (id: string) => input.workspace.dispatch({ action: 'confirm-conversation-delete', id }),
    onInspectExtension: (id: string) => input.workspace.dispatch({ action: 'inspect-extension', id }),
    onAskUninstall: (plugin: UserPluginView) => input.workspace.dispatch({ action: 'ask-plugin-uninstall', plugin }),
    onCancelUninstall: () => input.workspace.dispatch({ action: 'cancel-plugin-uninstall' }),
    onConfirmUninstall: (plugin: UserPluginView) => input.workspace.dispatch({ action: 'confirm-plugin-uninstall', id: plugin.id }),
    confirmingSkill: input.skill.state.confirmingSkill,
    armedSkill: input.skill.state.armedSkill,
    skillDependents: input.skill.state.dependents
      ? { id: input.skill.state.dependents.id, dependents: input.skill.state.dependents.values }
      : undefined,
    onSkillAction: input.skill.dispatch,
    onGoalAction: (action: 'pause' | 'resume', id: string, revision: number) => {
      void input.runtime.perform(() => controlGoal({ action, id, revision }), `unable to ${action} goal`)
    },
    onPlanAction: (active: boolean) => {
      void input.runtime.perform(() => controlPlan(active), `unable to ${active ? 'enter' : 'leave'} Plan Mode`)
    },
    onQuestionAnswer: (id: string, selected: string) => {
      void input.runtime.perform(() => answerTaskQuestion(id, selected), 'unable to submit answer')
    },
  }
}

export function MissionControlScreen(input: MissionControlScreenProps) {
  const props = projectScreenControls(input)
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
        ) : pane === 'logs' ? (
          <ExecutionLogWorkspace view={view} />
        ) : pane === 'settings' ? (
          <SettingsWorkspace control={input.settings} locked={locked} />
        ) : pane === 'specifications' ? (
          <CapabilitySpecificationsWorkspace control={input.specifications} locked={locked} />
        ) : pane === 'expense-review' ? (
          <ExpenseReviewWorkspace
            control={input.expenseReview}
            locked={locked}
            openSpecifications={() => navigate('specifications')}
          />
        ) : (
        <ConversationWorkspace
          view={view}
          active={compactSurface === 'conversation'}
          state={{
            connected: props.connected,
            sending: props.sending,
            executingCommand: props.executingCommand,
            draft: props.draft,
            commands: input.conversation.commands,
            error: props.error,
            activations: (view.activations ?? []).filter((card) => (
              card.eligibilityOk
              && !(props.deferredActivations ?? []).includes(card.id)
            )),
            armedActivation: props.armedActivation,
            armedAbandonment: props.armedAbandonment,
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
            openLogs: () => navigate('logs'),
            controlGoal: props.onGoalAction,
            controlPlan: props.onPlanAction,
            answerQuestion: props.onQuestionAnswer,
          }}
        />
      </div>
      <ControlStripView view={view} connected={props.connected} />
    </div>
    </div>
  )
}
