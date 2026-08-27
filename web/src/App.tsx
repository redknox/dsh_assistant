import React, { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { ActivationCard, ApprovalCard, MissionControlView, RollbackCard, SkillProjection, UserCapabilityStatus, UserPluginView, WorkObjectKind, WorkbenchProjection } from '../../src/domain/workspace/types'
import {
  abandonCandidateActivation,
  activateCandidate,
  decideApproval,
  establishSession,
  fetchView,
  openViewStream,
  recoveryActionId,
  rollbackSystemState,
  runConversation,
  runRecovery,
  runSkillAction,
  sendMessage,
  uninstallPlugin,
  type UiEnvelope,
} from './api'
import { Glyph } from './icons'
import { MarkdownMessage } from './MarkdownMessage'
import { MemoryWorkspace } from './MemoryWorkspace'
import { WorkspaceNavigation, type WorkspacePane } from './WorkspaceNavigation'

function isPendingApproval(status: string): boolean {
  return status === 'pending' || status === 'approval-requested' || status === 'unreviewed'
}

function isUserMessage(kind: WorkObjectKind): boolean {
  return kind === 'user-message'
}

function skillInvocationSurfaceOpen(view: MissionControlView): boolean {
  if (view.systemState === 'SAFE_MODE' || view.runtimeContext?.safeMode === true) return false
  const state = view.skillCatalog?.state
  return state === undefined || state === 'ok' || state === 'empty'
}

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

function capabilitySignal(status: UserCapabilityStatus): 'active' | 'governed' | 'unavailable' {
  if (status === 'active') return 'active'
  if (status === 'approval-required') return 'governed'
  return 'unavailable'
}

function activityModifier(kind: string): string {
  if (kind === 'APPROVAL_REQUIRED') return ' activity-item--approval'
  if (kind === 'COMPLETED' || kind === 'RECOVERED') return ' activity-item--done'
  if (kind === 'BLOCKED' || kind === 'FAILED') return ' activity-item--fault'
  if (kind === 'WAITING' || kind === 'PLANNED') return ''
  return ''
}

type CompactSurface = 'conversation' | 'navigation' | 'operations'

function paneFromHash(): WorkspacePane {
  if (globalThis.location?.hash === '#extensions') return 'extensions'
  if (globalThis.location?.hash === '#conversations') return 'memory'
  if (globalThis.location?.hash === '#memory') return 'memory'
  return 'today'
}

function PlateRivets() {
  return (
    <>
      <span className="rivet rivet--tl" aria-hidden="true" />
      <span className="rivet rivet--tr" aria-hidden="true" />
      <span className="rivet rivet--bl" aria-hidden="true" />
      <span className="rivet rivet--br" aria-hidden="true" />
    </>
  )
}

function SystemHeader(props: {
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
          <span className={`status-lamp status-lamp--${lampModifier(props.systemState, props.connected)}`} aria-hidden="true"></span>
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

function ApprovalCardView(props: {
  readonly card: ApprovalCard
  readonly locked: boolean
  readonly onApprove: (card: ApprovalCard) => void
  readonly onReject: (card: ApprovalCard) => void
}) {
  const { card } = props
  const pending = isPendingApproval(card.status)
  return (
    <article
      className="approval-card"
      data-approval-id={card.id}
      data-kind={card.kind}
      data-fingerprint={card.fingerprint}
      data-candidate-id={card.candidateId ?? ''}
      aria-labelledby={`approval-title-${card.id}`}
    >
      <header className="approval-header">
        <Glyph name="calendar" className="glyph approval-symbol" />
        <h2 id={`approval-title-${card.id}`}>{card.title}</h2>
      </header>
      <dl className="approval-facts">
        <div><dt>TARGET</dt><dd>Target {card.target}</dd></div>
        <div><dt>AUTHORITY</dt><dd>{card.authorityChange}</dd></div>
        <div><dt>FINGERPRINT</dt><dd>Fingerprint {card.fingerprint}</dd></div>
        {card.candidateId ? <div><dt>CANDIDATE</dt><dd>{card.candidateId}</dd></div> : null}
        {card.digest ? <div><dt>DIGEST</dt><dd>{card.digest}</dd></div> : null}
        {card.details.map((line) => (
          <div key={line}><dt>DETAIL</dt><dd>{line}</dd></div>
        ))}
      </dl>
      <div className="effect-line">
        <Glyph name="info" className="glyph effect-icon" />
        <span><strong>EFFECT</strong> External side effect: {card.sideEffect}</span>
      </div>
      {pending ? (
        <div className="approval-actions">
          <button type="button" className="button button--secondary" data-approval-action="reject" disabled={props.locked} onClick={() => props.onReject(card)}>REJECT</button>
          <button type="button" className="button button--approval" data-approval-action="approve" disabled={props.locked} onClick={() => props.onApprove(card)}>APPROVE</button>
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
  readonly onActivate: (card: ActivationCard) => void
  readonly onAbandon: (card: ActivationCard) => void
  readonly onDefer: (card: ActivationCard) => void
}) {
  const { card } = props
  const actionable = (card.status === 'APPROVED_NOT_ACTIVE' || card.status === 'DISABLED_REACTIVATABLE' || card.status === 'ACTIVATION_FAILED') && card.eligibilityOk
  return (
    <article
      className="approval-card"
      data-activation-id={card.id}
      data-kind={card.kind}
      data-fingerprint={card.fingerprint}
      data-candidate-id={card.candidateId}
      data-digest={card.digest}
      data-activation-status={card.status}
      aria-labelledby={`activation-title-${card.id}`}
    >
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
        {card.details.map((line) => (
          <div key={line}><dt>DETAIL</dt><dd>{line}</dd></div>
        ))}
      </dl>
      {actionable ? (
        <div className="approval-actions">
          <button type="button" className="button button--secondary" data-activation-action="defer" disabled={props.locked} onClick={() => props.onDefer(card)}>NOT NOW</button>
          {card.status === 'ACTIVATION_FAILED' ? (
            <button type="button" className="button button--fault" data-activation-action="abandon" disabled={props.locked} onClick={() => props.onAbandon(card)}>
              {props.abandonArmed ? 'CONFIRM ABANDON' : 'ABANDON'}
            </button>
          ) : null}
          <button
            type="button"
            className="button button--approval"
            data-activation-action="activate"
            disabled={props.locked}
            onClick={() => props.onActivate(card)}
          >
            {props.armed
              ? (card.status === 'DISABLED_REACTIVATABLE' ? 'CONFIRM REACTIVATE' : card.status === 'ACTIVATION_FAILED' ? 'CONFIRM RETRY' : 'CONFIRM ACTIVATE')
              : (card.status === 'DISABLED_REACTIVATABLE' ? 'REACTIVATE' : card.status === 'ACTIVATION_FAILED' ? 'RETRY' : 'ACTIVATE')}
          </button>
        </div>
      ) : <p className="approval-status">Status {card.status}</p>}
    </article>
  )
}

function RecoveryPanel(props: {
  readonly systemState: MissionControlView['systemState']
  readonly recovery: NonNullable<MissionControlView['recovery']>
  readonly locked: boolean
  readonly armedRecovery?: string
  readonly error?: string
  readonly onRecovery: (action: 'diagnostics' | 'rollback' | 'exit-safe-mode') => void
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

function RollbackCardView(props: {
  readonly card: RollbackCard
  readonly locked: boolean
  readonly deferred: boolean
  readonly armed: boolean
  readonly onAsk: (card: RollbackCard) => void
  readonly onDefer: (card: RollbackCard) => void
}) {
  const { card } = props
  if (props.deferred) return null
  return (
    <article
      className="approval-card"
      data-rollback-id={card.id}
      data-kind={card.kind}
      data-fingerprint={card.fingerprint}
      data-current-generation={card.currentGeneration}
      data-target-generation={card.targetGeneration}
      aria-labelledby={`rollback-title-${card.id}`}
    >
      <header className="approval-header">
        <Glyph name="shield" className="glyph approval-symbol" />
        <h2 id={`rollback-title-${card.id}`}>{card.title}</h2>
      </header>
      <dl className="approval-facts">
        <div><dt>CURRENT</dt><dd>generation {card.currentGeneration}</dd></div>
        <div><dt>TARGET</dt><dd>generation {card.targetGeneration}</dd></div>
        <div><dt>FINGERPRINT</dt><dd>{card.fingerprint}</dd></div>
        <div><dt>WHY</dt><dd>{card.reason}</dd></div>
        <div><dt>OWNERS</dt><dd>{card.ownerChanges.map((item) => `${item.change} ${item.owner}${item.from ? ` ${item.from}` : ''}${item.to ? `→${item.to}` : ''}`).join('; ') || 'none'}</dd></div>
        <div><dt>CAPABILITIES</dt><dd>added {card.capabilitiesAdded.join(', ') || 'none'}; removed {card.capabilitiesRemoved.join(', ') || 'none'}</dd></div>
        <div><dt>TOOLS</dt><dd>added {card.toolsAdded.join(', ') || 'none'}; removed {card.toolsRemoved.join(', ') || 'none'}</dd></div>
        <div><dt>MOUNTS</dt><dd>added {card.mountsAdded.length}; removed {card.mountsRemoved.length}</dd></div>
        <div><dt>RECOVERY REQUIRED</dt><dd>{card.recoveryRequired ? 'yes' : 'no'}</dd></div>
        <div><dt>WARNING</dt><dd>This is a system-state rollback, not a single-plugin uninstall. Candidate, approval, review, and audit history are retained.</dd></div>
      </dl>
      {props.armed ? (
        <div className="approval-actions">
          <button type="button" className="button button--secondary" data-rollback-action="cancel" disabled={props.locked} onClick={() => props.onDefer(card)}>Not now</button>
          <button type="button" className="button button--fault" data-rollback-action="confirm" disabled={props.locked} onClick={() => props.onAsk(card)}>Confirm Rollback system state</button>
        </div>
      ) : (
        <div className="approval-actions">
          <button type="button" className="button button--secondary" data-rollback-action="defer" disabled={props.locked} onClick={() => props.onDefer(card)}>Not now</button>
          <button type="button" className="button button--approval" data-rollback-action="ask" disabled={props.locked} onClick={() => props.onAsk(card)}>Rollback system state</button>
        </div>
      )}
    </article>
  )
}

function ConversationWorkspace(props: {
  readonly view: MissionControlView
  readonly connected: boolean
  readonly sending: boolean
  readonly draft: string
  readonly error?: string
  readonly onDraft: (value: string) => void
  readonly onSend: () => void
  readonly onApprove: (card: ApprovalCard) => void
  readonly onReject: (card: ApprovalCard) => void
  readonly activations: readonly ActivationCard[]
  readonly armedActivation?: string
  readonly armedAbandonment?: string
  readonly onActivate: (card: ActivationCard) => void
  readonly onAbandonActivation: (card: ActivationCard) => void
  readonly onDefer: (card: ActivationCard) => void
  readonly rollback?: RollbackCard
  readonly deferredRollback?: boolean
  readonly armedRollback?: boolean
  readonly onAskRollback?: (card: RollbackCard) => void
  readonly onDeferRollback?: (card: RollbackCard) => void
  readonly onPickSkill?: (skill: SkillProjection) => void
}) {
  const locked = !props.connected
  const sendDisabled = props.sending || locked || props.draft.trim() === ''
  const empty = props.view.conversation.length === 0
    && props.view.approvals.filter((card) => isPendingApproval(card.status)).length === 0
    && props.activations.length === 0
    && props.rollback === undefined
  return (
    <main className="conversation-panel" id="today">
      <div className="conversation-scroll">
        {empty ? (
          <section className="conversation-empty" aria-labelledby="conversation-empty-title">
            <div className="empty-mark" aria-hidden="true"><Glyph name="hex" /><span>T</span></div>
            <p className="empty-kicker">LOCAL ASSISTANT · READY</p>
            <h1 id="conversation-empty-title">What are we working on?</h1>
            <p className="empty-copy">Start with a question, a decision, or a concrete outcome. TARS-NG keeps the work inside this local workspace.</p>
            <div className="empty-prompts" aria-label="Suggested prompts">
              {[
                'Help me understand this project',
                'Review the latest changes',
                'Plan the next product milestone',
              ].map((prompt) => (
                <button key={prompt} type="button" onClick={() => props.onDraft(prompt)} disabled={locked}>{prompt}</button>
              ))}
            </div>
          </section>
        ) : null}
        {props.view.conversation.map((item, index) => {
          const user = isUserMessage(item.kind)
          const alert = item.kind === 'warning' || item.kind === 'failure'
          return (
            <article key={`${item.kind}-${index}`} className={`message${user ? ' message--user' : ' message--assistant'}${alert ? ' message--alert' : ''}`} data-kind={item.kind}>
              {user ? null : (
                <div className="assistant-mark" aria-hidden="true">
                  <Glyph name="hex" />
                  <span>T</span>
                </div>
              )}
              <div>
                <div className="message-meta">
                  <span>{user ? 'YOU' : props.view.identity}</span>
                </div>
                <div className="message-body"><MarkdownMessage text={item.text} /></div>
              </div>
            </article>
          )
        })}
        {props.view.approvals.filter((card) => isPendingApproval(card.status)).map((card) => (
          <ApprovalCardView key={card.id} card={card} locked={locked} onApprove={props.onApprove} onReject={props.onReject} />
        ))}
        {props.activations.map((card) => (
          <ActivationCardView
            key={`act-${card.id}`}
            card={card}
            locked={locked}
            armed={props.armedActivation === card.id}
            abandonArmed={props.armedAbandonment === card.id}
            onActivate={props.onActivate}
            onAbandon={props.onAbandonActivation}
            onDefer={props.onDefer}
          />
        ))}
        {props.rollback ? (
          <RollbackCardView
            card={props.rollback}
            locked={locked}
            deferred={props.deferredRollback === true}
            armed={props.armedRollback === true}
            onAsk={props.onAskRollback ?? (() => {})}
            onDefer={props.onDeferRollback ?? (() => {})}
          />
        ) : null}
      </div>
      <div>
        {skillInvocationSurfaceOpen(props.view) && (props.view.skills ?? []).some((skill) => skill.userInvocable && skill.lifecycle === 'active') ? (
          <div className="composer-chips" data-skill-chips="true">
            {(props.view.skills ?? []).filter((skill) => skill.userInvocable && skill.lifecycle === 'active').map((skill) => (
              <button
                key={skill.id}
                type="button"
                className="button button--secondary"
                data-skill-chip={skill.name}
                disabled={locked}
                onClick={() => props.onPickSkill?.(skill)}
              >
                {skill.name}
              </button>
            ))}
          </div>
        ) : null}
        <form className="composer" aria-label="Send a message" onSubmit={(event: FormEvent) => { event.preventDefault(); props.onSend() }}>
          <label className="sr-only" htmlFor="message">Message TARS-NG</label>
          <textarea
            id="message"
            rows={2}
            placeholder="Message TARS-NG…"
            value={props.draft}
            onChange={(event) => props.onDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
              event.preventDefault()
              if (!sendDisabled) props.onSend()
            }}
          />
          <button
            className="icon-button"
            type="button"
            aria-label="Attach file"
            title="Attachments are not available in this soak"
            disabled
          >
            <Glyph name="attach" />
            <span className="composer-button-label">ATTACH</span>
            <small>INOP</small>
          </button>
          <button
            className="send-button"
            type="submit"
            aria-label="Send message"
            disabled={sendDisabled}
          >
            <Glyph name="send" />
            <span className="composer-button-label">{props.sending ? 'SENDING' : 'SEND'}</span>
          </button>
        </form>
        {props.error ? <p className="error" role="alert">{props.error}</p> : null}
      </div>
    </main>
  )
}

function PluginRow(props: {
  readonly plugin: UserPluginView
  readonly locked: boolean
  readonly confirming: boolean
  readonly onAsk: (plugin: UserPluginView) => void
  readonly onCancel: () => void
  readonly onConfirm: (plugin: UserPluginView) => void
}) {
  const { plugin } = props
  const blocked = plugin.dependency.severity === 'hard' || plugin.dependency.severity === 'unresolved'
  const hard = plugin.dependency.dependents.filter((item) => item.kind === 'hard')
  const optional = plugin.dependency.dependents.filter((item) => item.kind === 'optional')
  const historical = plugin.dependency.dependents.filter((item) => item.kind === 'historical')
  return (
    <div
      className="plugin-row"
      data-plugin-id={plugin.id}
      data-owner={plugin.owner}
      data-version={plugin.version}
      data-uninstallable={plugin.uninstallable ? 'yes' : 'no'}
    >
      <dt>
        <span className="capability-area">{plugin.owner}@{plugin.version}</span>
        <span className="capability-action">{plugin.capabilities.join(', ') || 'user plugin'}</span>
      </dt>
      <dd>
        {props.confirming ? (
          <div className="uninstall-dialog" role="dialog" aria-labelledby={`uninstall-title-${plugin.id}`} aria-describedby={`uninstall-body-${plugin.id}`}>
            <h3 id={`uninstall-title-${plugin.id}`}>Uninstall {plugin.owner}@{plugin.version}</h3>
            <p id={`uninstall-body-${plugin.id}`}>
              Will remove:
              {plugin.capabilities.length > 0 ? ` Capability: ${plugin.capabilities.join(', ')}.` : ''}
              {plugin.tools.length > 0 ? ` Tool: ${plugin.tools.join(', ')}.` : ''}
              {` Runtime mount: ${plugin.mounted ? 1 : 0}.`}
              {plugin.candidateId ? ` Candidate: ${plugin.candidateId}.` : ''}
              {plugin.digest ? ` Digest: ${plugin.digest}.` : ''}
            </p>
            <p>
              Dependency check: {plugin.dependency.severity === 'none' ? 'no active dependents' : plugin.dependency.severity}
              {hard.length > 0 ? ` — ${hard.map((item) => `${item.owner}@${item.version} requires ${item.requiredCapability}`).join('; ')}` : ''}
              {optional.length > 0 ? ` Optional dependents will degrade: ${optional.map((item) => `${item.owner}@${item.version}`).join(', ')}.` : ''}
              {historical.length > 0 ? ` Historical dependents: ${historical.map((item) => `${item.owner}@${item.version} required ${item.requiredCapability}`).join(', ')}.` : ''}
            </p>
            <p>Candidate files and audit history will be retained.</p>
            <div className="approval-actions">
              <button type="button" className="button button--secondary" data-uninstall-action="cancel" onClick={props.onCancel}>Cancel</button>
              <button
                type="button"
                className="button button--approval"
                data-uninstall-action="confirm"
                disabled={props.locked || blocked}
                onClick={() => props.onConfirm(plugin)}
              >
                Confirm uninstall
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="plugin-uninstall"
            data-uninstall-action="ask"
            aria-label="Uninstall plugin"
            title="Uninstall plugin"
            disabled={props.locked}
            onClick={() => props.onAsk(plugin)}
          >
            <Glyph name="trash" />
          </button>
        )}
      </dd>
    </div>
  )
}

function ExtensionsWorkspace(props: {
  readonly view: MissionControlView
  readonly locked: boolean
  readonly inspecting?: string
  readonly confirmingPlugin?: string
  readonly armedActivation?: string
  readonly armedAbandonment?: string
  readonly onInspect: (id: string) => void
  readonly onApprove: (card: ApprovalCard) => void
  readonly onReject: (card: ApprovalCard) => void
  readonly onActivate?: (card: ActivationCard) => void
  readonly onAbandonActivation?: (card: ActivationCard) => void
  readonly onAskUninstall?: (plugin: UserPluginView) => void
  readonly onCancelUninstall?: () => void
  readonly onConfirmUninstall?: (plugin: UserPluginView) => void
  readonly confirmingSkill?: string
  readonly armedSkill?: string
  readonly onSkillAction?: (action: 'approve' | 'reject' | 'activate' | 'disable' | 'reactivate' | 'uninstall' | 'rollback', skill?: SkillProjection) => void
  readonly skillDependents?: { readonly id: string; readonly dependents: readonly string[] }
}) {
  return (
    <main className="conversation-panel extensions-panel" id="extensions" data-workspace-pane="extensions">
      <div className="conversation-scroll">
        <section className="capability-section" aria-labelledby="extensions-title">
          <h2 id="extensions-title">EXTENSIONS</h2>
          <ul className="workbench-list" data-extensions="true">
            {(props.view.extensions ?? []).length === 0 ? (
              <li className="workbench-item">No generated or third-party extensions in this home.</li>
            ) : (props.view.extensions ?? []).map((item) => {
              const approval = (props.view.approvals ?? []).find((card) => card.candidateId === item.candidateId)
              const card = (props.view.activations ?? []).find((activation) => activation.candidateId === item.candidateId)
              const plugin = (props.view.plugins ?? []).find((row) => row.owner === item.owner && row.version === item.version)
              const failure = props.view.activationFailure?.candidateId === item.candidateId ? props.view.activationFailure : undefined
              const open = props.inspecting === item.id
              const pending = approval !== undefined && isPendingApproval(approval.status)
              const canActivate = (item.lifecycle === 'DISABLED_REACTIVATABLE' || item.lifecycle === 'APPROVED_NOT_ACTIVE' || item.lifecycle === 'ACTIVATION_FAILED')
                && card !== undefined
                && item.eligibilityOk
              return (
                <li
                  key={item.id}
                  className="workbench-item"
                  data-extension-id={item.id}
                  data-extension-lifecycle={item.lifecycle}
                  data-registry-status={item.registryStatus}
                  data-extension-inspect={open ? 'open' : 'closed'}
                >
                  <div className="workbench-identity">{item.owner}@{item.version}</div>
                  <div className="workbench-meta">lifecycle {item.lifecycle.replaceAll('_', ' ')}</div>
                  <div className="workbench-meta">registry {item.registryStatus} · {item.mounted ? 'mounted' : 'unmounted'}</div>
                  <div className="workbench-meta" data-extension-provenance={item.provenance}>
                    provenance {item.provenance === 'third-party' || item.provenanceOrigin === 'import' ? 'Third-party' : item.provenance}
                    {item.provenanceOrigin ? ` / ${item.provenanceOrigin}` : ''}
                  </div>
                  <div className="workbench-meta">capabilities {item.capabilities.join(', ') || 'none'}</div>
                  {item.candidateId ? <div className="workbench-meta">candidate {item.candidateId}</div> : null}
                  {item.digest ? <div className="workbench-meta">digest {item.digest}</div> : null}
                  <div className="workbench-meta">
                    {item.eligibilityOk ? 'eligible' : `not eligible${item.eligibilityDenials.length ? `: ${item.eligibilityDenials.join(', ')}` : ''}`}
                  </div>
                  {item.newerAuthoritative ? <div className="workbench-meta">newer authoritative revision exists</div> : null}
                  {open ? (
                    <div className="workbench-meta" data-extension-details="true">
                      review {item.reviewState ?? 'unknown'} · validation {item.validationPassed === true ? 'passed' : 'not passed'} · approval {item.approvalDecision ?? 'none'}
                      {failure ? ` · failed ${failure.phase}: ${failure.summary}` : ''}
                    </div>
                  ) : null}
                  <div className="approval-actions">
                    <button
                      type="button"
                      className="button button--secondary"
                      data-extension-action={
                        item.lifecycle === 'DISABLED_BLOCKED' ? 'inspect-denials'
                          : item.lifecycle === 'ACTIVATION_FAILED' ? 'diagnostics'
                            : item.lifecycle === 'SUPERSEDED' ? 'view-history'
                              : 'inspect'
                      }
                      disabled={props.locked}
                      onClick={() => props.onInspect(item.id)}
                    >
                      {item.lifecycle === 'DISABLED_BLOCKED' ? (open ? 'HIDE DENIALS' : 'INSPECT DENIALS')
                        : item.lifecycle === 'ACTIVATION_FAILED' ? (open ? 'HIDE DIAGNOSTICS' : 'DIAGNOSTICS')
                          : item.lifecycle === 'SUPERSEDED' ? (open ? 'HIDE HISTORY' : 'VIEW HISTORY')
                            : (open ? 'HIDE' : 'INSPECT')}
                    </button>
                    {item.lifecycle === 'APPROVAL_REQUIRED' && pending && approval ? (
                      <>
                        <button type="button" className="button button--secondary" data-extension-action="reject" disabled={props.locked} onClick={() => props.onReject(approval)}>REJECT</button>
                        <button type="button" className="button button--approval" data-extension-action="approve" disabled={props.locked} onClick={() => props.onApprove(approval)}>APPROVE</button>
                      </>
                    ) : null}
                    {canActivate && card ? (
                      <>
                        {item.lifecycle === 'ACTIVATION_FAILED' ? (
                          <button
                            type="button"
                            className="button button--fault"
                            data-extension-action="abandon"
                            disabled={props.locked}
                            onClick={() => props.onAbandonActivation?.(card)}
                          >
                            {props.armedAbandonment === card.id ? 'CONFIRM ABANDON' : 'ABANDON'}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="button button--approval"
                          data-extension-action={item.lifecycle === 'DISABLED_REACTIVATABLE' ? 'reactivate' : item.lifecycle === 'ACTIVATION_FAILED' ? 'retry' : 'activate'}
                          disabled={props.locked}
                          onClick={() => props.onActivate?.(card)}
                        >
                          {props.armedActivation === card.id
                            ? (item.lifecycle === 'DISABLED_REACTIVATABLE' ? 'CONFIRM REACTIVATE' : item.lifecycle === 'ACTIVATION_FAILED' ? 'CONFIRM RETRY' : 'CONFIRM ACTIVATE')
                            : (item.lifecycle === 'DISABLED_REACTIVATABLE' ? 'REACTIVATE' : item.lifecycle === 'ACTIVATION_FAILED' ? 'RETRY' : 'ACTIVATE')}
                        </button>
                      </>
                    ) : null}
                    {item.lifecycle === 'ACTIVE' && plugin ? (
                      <PluginRow
                        plugin={plugin}
                        locked={props.locked}
                        confirming={props.confirmingPlugin === plugin.id}
                        onAsk={props.onAskUninstall ?? (() => {})}
                        onCancel={props.onCancelUninstall ?? (() => {})}
                        onConfirm={props.onConfirmUninstall ?? (() => {})}
                      />
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
        <SkillsCenter
          view={props.view}
          locked={props.locked}
            confirmingSkill={props.confirmingSkill}
            armedSkill={props.armedSkill}
            skillDependents={props.skillDependents}
            onSkillAction={props.onSkillAction ?? (() => {})}
        />
      </div>
    </main>
  )
}

function SkillsCenter(props: {
  readonly view: MissionControlView
  readonly locked: boolean
  readonly confirmingSkill?: string
  readonly armedSkill?: string
  readonly skillDependents?: { readonly id: string; readonly dependents: readonly string[] }
  readonly onSkillAction: (action: 'approve' | 'reject' | 'activate' | 'disable' | 'reactivate' | 'uninstall' | 'rollback', skill?: SkillProjection) => void
}) {
  const skills = props.view.skills ?? []
  const catalogOpen = skillInvocationSurfaceOpen(props.view)
  return (
    <section className="capability-section" aria-labelledby="skills-title">
      <h2 id="skills-title">SKILLS</h2>
      {props.view.skillCatalog?.state === 'degraded' || props.view.skillCatalog?.state === 'withheld' ? (
        <p className="workbench-meta" data-skill-catalog={props.view.skillCatalog.state}>
          {props.view.skillCatalog.state === 'withheld'
            ? 'catalog withheld'
            : `catalog degraded${props.view.skillCatalog.failed.length > 0 ? ` · failed ${props.view.skillCatalog.failed.join(', ')}` : ''}`}
          {props.view.skillCatalog.detail ? ` · ${props.view.skillCatalog.detail}` : ''}
        </p>
      ) : null}
      <ul className="workbench-list" data-skills="true">
        {skills.length === 0 ? (
          <li className="workbench-item">No Skills in this Profile catalog.</li>
        ) : skills.map((skill) => (
          <li
            key={skill.id}
            className="workbench-item"
            data-skill-id={skill.id}
            data-skill-lifecycle={skill.lifecycle}
            data-skill-system={skill.system ? 'yes' : 'no'}
          >
            <div className="workbench-identity">{skill.name}@{skill.version}</div>
            <div className="workbench-meta">profile {skill.profile} · digest {skill.digest}</div>
            <div className="workbench-meta">lifecycle {skill.lifecycle} · {skill.provenance}</div>
            <div className="workbench-meta">{skill.description}</div>
            {skill.whenToUse ? <div className="workbench-meta">when {skill.whenToUse}</div> : null}
            <div className="workbench-meta">
              invocation model {skill.modelInvocable ? 'yes' : 'no'} · user {skill.userInvocable ? 'yes' : 'no'}
            </div>
            <div className="workbench-meta">resources {skill.resources.join(', ') || 'none'}</div>
            <div className="workbench-meta">
              validation {skill.validationPassed ? 'passed' : 'not passed'} · review {skill.reviewComplete ? 'complete' : 'not complete'}
            </div>
            {skill.dependsOn.length > 0 ? <div className="workbench-meta">depends on {skill.dependsOn.join(', ')}</div> : null}
            {skill.dependents.length > 0 ? <div className="workbench-meta" data-skill-dependents="true">dependents {skill.dependents.join(', ')}</div> : null}
            {skill.lastFailure ? (
              <div className="workbench-meta" data-skill-failed="true">failed {skill.lastFailure.phase} · {skill.lastFailure.detail}</div>
            ) : null}
            {skill.revisionDiff ? (
              <div className="workbench-meta" data-skill-diff="true">
                instruction {skill.revisionDiff.instructionChanged ? 'changed' : 'unchanged'}
                {' '}({skill.revisionDiff.instructionBeforeChars}→{skill.revisionDiff.instructionAfterChars} chars)
                {skill.revisionDiff.resources.added.length ? ` · resources +${skill.revisionDiff.resources.added.join(',')}` : ''}
                {skill.revisionDiff.resources.removed.length ? ` · resources -${skill.revisionDiff.resources.removed.join(',')}` : ''}
                {` · invocation ${skill.revisionDiff.invocation.before.modelInvocable ? 'model' : 'no-model'}/${skill.revisionDiff.invocation.before.userInvocable ? 'user' : 'no-user'}→${skill.revisionDiff.invocation.after.modelInvocable ? 'model' : 'no-model'}/${skill.revisionDiff.invocation.after.userInvocable ? 'user' : 'no-user'}`}
                {skill.revisionDiff.dependsOn.added.length ? ` · depends +${skill.revisionDiff.dependsOn.added.join(',')}` : ''}
                {skill.revisionDiff.dependsOn.removed.length ? ` · depends -${skill.revisionDiff.dependsOn.removed.join(',')}` : ''}
              </div>
            ) : null}
            {skill.resolutionHandoff ? (
              <div className="workbench-meta" data-skill-handoff="capability-resolution">
                missing tools {skill.resolutionHandoff.missingTools.join(', ')} · next Capability Resolution
              </div>
            ) : null}
            {props.skillDependents?.id === skill.id ? (
              <div className="workbench-meta" data-skill-dependent-warning="true">
                hard dependents {props.skillDependents.dependents.join(', ')}
              </div>
            ) : null}
            <div className="approval-actions">
              {skill.lifecycle === 'approval-requested' ? (
                <>
                  <button type="button" className="button button--secondary" data-skill-action="reject" disabled={props.locked} onClick={() => props.onSkillAction('reject', skill)}>
                    {props.armedSkill === `reject:${skill.id}` ? 'CONFIRM REJECT' : 'REJECT'}
                  </button>
                  <button type="button" className="button button--approval" data-skill-action="approve" disabled={props.locked} onClick={() => props.onSkillAction('approve', skill)}>
                    {props.armedSkill === `approve:${skill.id}` ? 'CONFIRM APPROVE' : 'APPROVE'}
                  </button>
                </>
              ) : null}
              {catalogOpen && skill.lifecycle === 'approved' ? (
                <button type="button" className="button button--approval" data-skill-action="activate" disabled={props.locked} onClick={() => props.onSkillAction('activate', skill)}>
                  {props.armedSkill === `activate:${skill.id}` ? 'CONFIRM ACTIVATE' : 'ACTIVATE'}
                </button>
              ) : null}
              {catalogOpen && skill.lifecycle === 'disabled' ? (
                <button type="button" className="button button--approval" data-skill-action="reactivate" disabled={props.locked} onClick={() => props.onSkillAction('reactivate', skill)}>
                  {props.armedSkill === `reactivate:${skill.id}` ? 'CONFIRM REACTIVATE' : 'REACTIVATE'}
                </button>
              ) : null}
              {skill.lifecycle === 'active' && !skill.system ? (
                <button type="button" className="button button--secondary" data-skill-action="disable" disabled={props.locked} onClick={() => props.onSkillAction('disable', skill)}>
                  {props.skillDependents?.id === skill.id ? 'CONFIRM DEPENDENTS'
                    : props.armedSkill === `disable:${skill.id}` ? 'CONFIRM DISABLE' : 'DISABLE'}
                </button>
              ) : null}
              {!skill.system && skill.lifecycle !== 'uninstalled' ? (
                props.confirmingSkill === skill.id ? (
                  <>
                    <button type="button" className="button button--secondary" data-skill-action="cancel-uninstall" disabled={props.locked} onClick={() => props.onSkillAction('uninstall')}>CANCEL</button>
                    <button type="button" className="button button--approval" data-skill-action="confirm-uninstall" disabled={props.locked} onClick={() => props.onSkillAction('uninstall', skill)}>
                      {props.skillDependents?.id === skill.id ? 'CONFIRM DEPENDENTS' : 'CONFIRM UNINSTALL'}
                    </button>
                  </>
                ) : (
                  <button type="button" className="button button--secondary" data-skill-action="uninstall" disabled={props.locked} onClick={() => props.onSkillAction('uninstall', skill)}>UNINSTALL</button>
                )
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {props.view.skillRollback ? (
        <button type="button" className="button button--secondary" data-skill-action="rollback" disabled={props.locked} onClick={() => props.onSkillAction('rollback')}>
          {props.armedSkill === 'rollback' ? 'CONFIRM ROLLBACK' : `ROLLBACK ${props.view.skillRollback.name}@${props.view.skillRollback.version}`}
        </button>
      ) : null}
    </section>
  )
}

function OperationsPanel(props: {
  readonly view: MissionControlView
  readonly locked?: boolean
  readonly confirmingPlugin?: string
  readonly onAskUninstall?: (plugin: UserPluginView) => void
  readonly onCancelUninstall?: () => void
  readonly onConfirmUninstall?: (plugin: UserPluginView) => void
  readonly onOpenExtensions?: () => void
}) {
  const activeCapabilities = props.view.capabilities.filter((item) => item.status === 'active').length
  const governedCapabilities = props.view.capabilities.filter((item) => item.status === 'approval-required').length
  const unavailableCapabilities = props.view.capabilities.length - activeCapabilities - governedCapabilities
  const recentActivity = props.view.activity.slice(-3).reverse()
  const degradation = props.view.controlStrip.degradation
  const pendingApprovals = props.view.controlStrip.pendingApprovals
  return (
    <aside className="ops-panel instrument-panel" id="activity" aria-label="Operational state">
      <div className="panel-code"><span>OPS 04</span><span>LIVE STATUS</span></div>
      <section className="ops-overview" aria-labelledby="ops-overview-title">
        <div className="ops-section-heading">
          <h2 id="ops-overview-title">OPERATIONS</h2>
          <span className={`status-lamp status-lamp--${lampModifier(props.view.systemState, props.locked !== true)}`} aria-hidden="true" />
        </div>
        <strong className="ops-mode">{props.view.systemState.replaceAll('_', ' ')}</strong>
        <p className="ops-detail">{props.locked ? 'CONTROL LINK OFFLINE' : degradation ?? 'ALL CORE SYSTEMS NOMINAL'}</p>
        <div className="ops-counters" aria-label="Operational counters">
          <span><small>APPROVALS</small><strong className={pendingApprovals > 0 ? 'amber' : undefined}>{pendingApprovals}</strong></span>
          <span><small>JOBS</small><strong>{props.view.controlStrip.backgroundJobs}</strong></span>
        </div>
        {pendingApprovals > 0 ? <p className="ops-alert"><Glyph name="warn" /> HUMAN DECISION REQUIRED</p> : null}
      </section>
      <WorkbenchPanel candidates={props.view.candidates ?? []} />
      <section className="capability-section" id="capabilities" aria-labelledby="capability-title">
        <div className="ops-section-heading capability-heading">
          <h2 id="capability-title">CAPABILITIES</h2>
          <span>{props.view.capabilities.length} CHANNELS</span>
        </div>
        <div className="capability-summary" aria-label="Capability summary">
          <span data-capability-state="active"><strong>{activeCapabilities}</strong> ACTIVE</span>
          <span data-capability-state="governed"><strong>{governedCapabilities}</strong> GOVERNED</span>
          <span data-capability-state="unavailable"><strong>{unavailableCapabilities}</strong> INOP</span>
        </div>
        <dl className="capability-list">
          {(props.view.plugins ?? []).map((plugin) => (
            <PluginRow
              key={plugin.id}
              plugin={plugin}
              locked={props.locked === true}
              confirming={props.confirmingPlugin === plugin.id}
              onAsk={props.onAskUninstall ?? (() => {})}
              onCancel={props.onCancelUninstall ?? (() => {})}
              onConfirm={props.onConfirmUninstall ?? (() => {})}
            />
          ))}
          {props.view.capabilities.map((item) => (
            <div key={`${item.area}-${item.action}`}>
              <dt>
                <span className="capability-area">{item.area}</span>
                <span className="capability-action">{item.action}</span>
              </dt>
              <dd data-status={item.status} data-capability-state={capabilitySignal(item.status)}>
                {item.status === 'approval-required' ? 'APPROVAL'
                  : item.status === 'safe-mode-disabled' ? 'SAFE OFF'
                    : item.status === 'unavailable' ? 'INOP' : 'ACTIVE'}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="activity-section activity-section--recent" aria-labelledby="activity-title">
        <div className="ops-section-heading">
          <h2 id="activity-title">RECENT EVENTS</h2>
          <span>LAST {recentActivity.length}</span>
        </div>
        {recentActivity.length === 0 ? <p className="ops-empty">NO RECENT EVENTS</p> : (
          <ol className="activity-list">
            {recentActivity.map((item) => (
              <li key={item.id} className={`activity-item${activityModifier(item.kind)}`} data-activity={item.kind}>
                <span className="activity-node">{item.kind === 'APPROVAL_REQUIRED' ? <Glyph name="warn" /> : null}</span>
                <span>{item.kind.replaceAll('_', ' ')}</span>
                <span className="activity-summary">{item.summary}</span>
              </li>
            ))}
          </ol>
        )}
        {(props.view.approvalResolutions ?? []).length > 0 ? (
          <ul className="ops-decisions" data-actions-history="true" aria-label="Recent human decisions">
            {(props.view.approvalResolutions ?? []).slice(-3).reverse().map((item) => (
              <li
                key={item.confirmationId}
                data-approval-resolution={item.confirmationId}
                data-approval-outcome={item.outcome}
              >
                <span>{item.capability ?? 'action'}.{item.operation ?? item.decision}</span>
                <strong>{item.decision.toUpperCase()}</strong>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <div className="ops-footer">
        <span><strong>{(props.view.extensions ?? []).length}</strong> USER EXTENSIONS</span>
        <button type="button" className="button button--secondary" data-open-extensions="true" onClick={() => props.onOpenExtensions?.()}>OPEN</button>
      </div>
    </aside>
  )
}

function formatDiff(added: readonly string[], removed: readonly string[], changed: readonly string[] = []): string {
  const plus = added.map((item) => `+${item}`).join(' ')
  const minus = removed.map((item) => `-${item}`).join(' ')
  const tilde = changed.map((item) => `~${item}`).join(' ')
  return [plus, minus, tilde].filter((item) => item !== '').join(' ') || 'none'
}

function WorkbenchPanel(props: { readonly candidates: readonly WorkbenchProjection[] }) {
  if (props.candidates.length === 0) return null
  return (
    <section className="workbench-section" data-workbench="true" aria-labelledby="workbench-title">
      <h2 id="workbench-title">CANDIDATE WORKBENCH</h2>
      <ul className="workbench-list">
        {props.candidates.map((item) => (
          <li
            key={item.id}
            className="workbench-item"
            data-candidate-id={item.id}
            data-can-request={item.canRequestApproval ? 'yes' : 'no'}
            data-review-state={item.reviewState ?? 'not-reviewed'}
          >
            <div className="workbench-identity">{item.owner}@{item.version}</div>
            <div className="workbench-meta">
              {item.resolutionKind ?? 'unresolved'} {item.resolutionCapability ?? ''}
            </div>
            <div className="workbench-meta" data-current-step={item.currentStep ?? 'author'}>
              step {item.currentStep ?? item.lifecycle}
              {item.parentId ? ` · repair of ${item.parentId}` : ''}
              {item.leftover ? ' · leftover repair' : ''}
            </div>
            <div className="workbench-meta">
              validation {item.validationPassed === true ? 'passed' : item.validationFailureSummary || item.validationFailed?.join(', ') || item.lifecycle}
            </div>
            <div className="workbench-meta">
              review {item.reviewState ?? 'not-reviewed'}
              {item.blockingFindings ? ` · ${item.blockingFindings} blockers` : ''}
              {item.blockerClaims?.length ? ` (${item.blockerClaims.join(', ')})` : ''}
            </div>
            <div className="workbench-meta" data-review-state={item.reviewState ?? 'not-reviewed'}>
              reviewState {item.reviewState ?? 'not-reviewed'}
            </div>
            <div className="workbench-meta" data-governance-approval={item.governanceApproval ?? 'none'}>
              governanceApproval {item.governanceApproval ?? 'none'}
            </div>
            <div className="workbench-meta" data-activation-state={item.activationState ?? 'inactive'}>
              activationState {item.activationState ?? 'inactive'}
              {item.activationFailureSummary ? ` · ${item.activationFailureSummary}` : ''}
            </div>
            <div className="workbench-meta" data-approval-state={item.approvalState ?? 'not-ready'} data-extension-lifecycle={item.extensionLifecycle ?? 'APPROVAL_REQUIRED'}>
              {item.extensionLifecycle === 'ACTIVE' ? 'approved and active'
                : item.extensionLifecycle === 'APPROVED_NOT_ACTIVE' ? 'approved, not active'
                  : item.extensionLifecycle === 'ACTIVATING' ? 'activating'
                    : item.extensionLifecycle === 'ACTIVATION_FAILED' ? 'activation failed'
                      : item.extensionLifecycle === 'DISABLED_REACTIVATABLE' ? 'disabled, reactivatable'
                        : item.extensionLifecycle === 'DISABLED_BLOCKED' ? 'disabled, blocked'
                          : item.extensionLifecycle === 'SUPERSEDED' ? 'superseded'
                            : item.approvalState === 'approval-requested' || item.canRequestApproval ? 'ready for approval'
                              : 'not ready for approval'}
            </div>
            <div className="workbench-diff">
              capabilities {formatDiff(item.diff?.capabilities.added ?? [], item.diff?.capabilities.removed ?? [], item.diff?.capabilities.changed ?? [])}
            </div>
            <div className="workbench-diff">
              permissions {formatDiff(item.diff?.permissions.added ?? [], item.diff?.permissions.removed ?? [], item.diff?.permissions.changed ?? [])}
            </div>
            <div className="workbench-diff">
              effects {item.effectSummary?.length ? item.effectSummary.join('; ') : 'none'}
            </div>
            <div className="workbench-request" data-can-request={item.canRequestApproval ? 'yes' : 'no'}>
              {item.canRequestApproval ? 'can request approval' : `cannot request${item.requestDenials?.length ? `: ${item.requestDenials.join(', ')}` : ''}`}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function ControlStripView(props: {
  readonly view: MissionControlView
  readonly connected: boolean
}) {
  const strip = props.view.controlStrip
  const safe = props.view.systemState === 'SAFE_MODE' || props.view.systemState === 'RECOVERY'
  return (
    <footer className="faceplate control-strip" aria-label="Runtime status" data-control-plane="user-workspace">
      <PlateRivets />
      <div className="control-strip-row">
        <div>
          <Glyph name="chip" />
          <span className="strip-copy">
            <span className="strip-label">MODE</span>
            <strong>{strip.mode}</strong>
            {strip.degradation ? <span className="sr-only">{strip.degradation}</span> : null}
          </span>
        </div>
        <div>
          <Glyph name="shield" />
          <span className="strip-copy"><span className="strip-label">SAFE MODE</span><strong>{safe ? 'ON' : 'OFF'}</strong></span>
        </div>
        <div>
          <Glyph name="check" />
          <span className="strip-copy">
            <span className="strip-label">APPROVALS</span>
            <strong className={strip.pendingApprovals > 0 ? 'amber' : undefined}>{strip.pendingApprovals}</strong>
          </span>
        </div>
        <div>
          <Glyph name="terminal" />
          <span className="strip-copy">
            <span className="strip-label">{props.connected ? 'LOCAL' : 'TRANSPORT'}</span>
            <strong>{props.connected ? '127.0.0.1' : 'DISCONNECTED'}</strong>
            {strip.backgroundJobs > 0 ? <span className="sr-only">JOBS {strip.backgroundJobs}</span> : null}
          </span>
        </div>
      </div>
    </footer>
  )
}

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
            locked={locked}
            inspecting={props.inspectingExtension}
            confirmingPlugin={props.confirmingPlugin}
            armedActivation={props.armedActivation}
            armedAbandonment={props.armedAbandonment}
            onInspect={props.onInspectExtension ?? (() => {})}
            onApprove={props.onApprove}
            onReject={props.onReject}
            onActivate={props.onActivate}
            onAbandonActivation={props.onAbandonActivation}
            onAskUninstall={props.onAskUninstall}
            onCancelUninstall={props.onCancelUninstall}
            onConfirmUninstall={props.onConfirmUninstall}
            confirmingSkill={props.confirmingSkill}
            armedSkill={props.armedSkill}
            skillDependents={props.skillDependents}
            onSkillAction={props.onSkillAction}
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
          connected={props.connected}
          sending={props.sending}
          draft={props.draft}
          error={props.error}
          onDraft={props.onDraft}
          onSend={props.onSend}
          onApprove={props.onApprove}
          onReject={props.onReject}
          activations={(view.activations ?? []).filter((card) => !(props.deferredActivations ?? []).includes(card.id))}
          armedActivation={props.armedActivation}
          armedAbandonment={props.armedAbandonment}
          onActivate={props.onActivate ?? (() => {})}
          onAbandonActivation={props.onAbandonActivation ?? (() => {})}
          onDefer={props.onDeferActivation ?? (() => {})}
          onPickSkill={props.onPickSkill}
          rollback={view.rollback}
          deferredRollback={props.deferredRollback}
          armedRollback={props.armedRollback}
          onAskRollback={props.onAskRollback}
          onDeferRollback={props.onDeferRollback}
        />
        )}
        <OperationsPanel
          view={view}
          locked={locked}
          confirmingPlugin={props.confirmingPlugin}
          onAskUninstall={props.onAskUninstall}
          onCancelUninstall={props.onCancelUninstall}
          onConfirmUninstall={props.onConfirmUninstall}
          onOpenExtensions={() => navigate('extensions')}
        />
      </div>
      <ControlStripView view={view} connected={props.connected} />
    </div>
    </div>
  )
}

export function App() {
  const [envelope, setEnvelope] = useState<UiEnvelope | undefined>()
  const [connected, setConnected] = useState(false)
  const [sending, setSending] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string>()
  const [armedRecovery, setArmedRecovery] = useState<string>()
  const [armedActivation, setArmedActivation] = useState<string>()
  const [armedAbandonment, setArmedAbandonment] = useState<string>()
  const [deferredActivations, setDeferredActivations] = useState<string[]>([])
  const [confirmingPlugin, setConfirmingPlugin] = useState<string>()
  const [deferredRollback, setDeferredRollback] = useState(false)
  const [armedRollback, setArmedRollback] = useState(false)
  const [pane, setPane] = useState<WorkspacePane>(paneFromHash)
  const [confirmingSession, setConfirmingSession] = useState<string>()
  const [inspectingExtension, setInspectingExtension] = useState<string>()
  const [confirmingSkill, setConfirmingSkill] = useState<string>()
  const [armedSkill, setArmedSkill] = useState<string>()
  const [skillDependents, setSkillDependents] = useState<{ readonly id: string; readonly dependents: readonly string[] }>()
  const [acknowledgement, setAcknowledgement] = useState<{ readonly text: string }>()

  useEffect(() => {
    const sync = () => { setPane(paneFromHash()) }
    globalThis.addEventListener?.('hashchange', sync)
    return () => globalThis.removeEventListener?.('hashchange', sync)
  }, [])

  useEffect(() => {
    if (!acknowledgement) return
    const timer = globalThis.setTimeout(() => setAcknowledgement(undefined), 4000)
    return () => globalThis.clearTimeout(timer)
  }, [acknowledgement])

  const navigate = (next: WorkspacePane) => {
    setPane(next)
    if (globalThis.location) {
      globalThis.location.hash = next
    }
  }

  useEffect(() => {
    let closed = false
    let stop = () => {}
    void (async () => {
      try {
        await establishSession()
        if (closed) return
        const next = await fetchView()
        if (!closed) setEnvelope(next)
      } catch (caught: unknown) {
        if (!closed) setError(caught instanceof Error ? caught.message : 'unable to load workspace')
      }
      if (closed) return
      stop = openViewStream((next) => setEnvelope(next), setConnected)
    })()
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
      const sessionId = view?.runtimeContext?.sessionId ?? view?.sessions?.currentSessionId
      if (!sessionId) throw new Error('current session is unknown')
      setEnvelope(await sendMessage(draft.trim(), sessionId))
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
      const next = await run()
      setEnvelope(next)
      if (next.acknowledgement) setAcknowledgement(next.acknowledgement)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'action failed')
    }
  }

  const catalogRef = () => ({
    sessionId: envelope?.view.runtimeContext?.sessionId ?? envelope?.view.sessions?.currentSessionId ?? 'main',
    revision: envelope?.view.sessions?.revision ?? 0,
  })

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
      armedRecovery={armedRecovery}
      onDraft={setDraft}
      onSend={() => { void onSend() }}
      acknowledgement={acknowledgement}
      onDismissAcknowledgement={() => setAcknowledgement(undefined)}
      onApprove={(card) => { void act(() => decideApproval(card, 'approve')) }}
      onReject={(card) => { void act(() => decideApproval(card, 'deny')) }}
      deferredActivations={deferredActivations}
      armedActivation={armedActivation}
      armedAbandonment={armedAbandonment}
      onDeferActivation={(card) => {
        setDeferredActivations((current) => current.includes(card.id) ? current : [...current, card.id])
      }}
      onActivate={(card) => {
        if (armedActivation !== card.id) {
          setArmedAbandonment(undefined)
          setArmedActivation(card.id)
          return
        }
        setArmedActivation(undefined)
        void act(() => activateCandidate(card, true))
      }}
      onAbandonActivation={(card) => {
        if (armedAbandonment !== card.id) {
          setArmedActivation(undefined)
          setArmedAbandonment(card.id)
          return
        }
        setArmedAbandonment(undefined)
        void act(() => abandonCandidateActivation(card, true))
      }}
      pane={pane}
      onNavigate={navigate}
      confirmingSession={confirmingSession}
      onCreateConversation={() => { void act(() => runConversation('create', catalogRef())) }}
      onSwitchConversation={(id) => { void act(() => runConversation('switch', { ...catalogRef(), id })) }}
      onRenameConversation={(id, title) => { void act(() => runConversation('rename', { ...catalogRef(), id, title })) }}
      onArchiveConversation={(id) => { void act(() => runConversation('archive', { ...catalogRef(), id })) }}
      onRestoreConversation={(id) => { void act(() => runConversation('restore', { ...catalogRef(), id })) }}
      onAskDeleteConversation={(id) => { setConfirmingSession(id) }}
      onConfirmDeleteConversation={(id) => {
        setConfirmingSession(undefined)
        void act(() => runConversation('delete', { ...catalogRef(), id, confirm: true }))
      }}
      inspectingExtension={inspectingExtension}
      onInspectExtension={(id) => { setInspectingExtension((current) => current === id ? undefined : id) }}
      confirmingSkill={confirmingSkill}
      armedSkill={armedSkill}
      skillDependents={skillDependents}
      onPickSkill={(skill) => {
        setDraft((current) => current.trim() === '' ? `Use the ${skill.name} skill.` : `${current.trim()} ${skill.name}`)
      }}
      onSkillAction={(action, skill) => {
        if (action === 'uninstall' || action === 'disable') {
          if (action === 'uninstall') {
            if (skill === undefined) {
              setConfirmingSkill(undefined)
              setSkillDependents(undefined)
              return
            }
            if (confirmingSkill !== skill.id) {
              setConfirmingSkill(skill.id)
              setSkillDependents(undefined)
              return
            }
          } else {
            if (skill === undefined) return
            const key = `disable:${skill.id}`
            if (armedSkill !== key && skillDependents?.id !== skill.id) {
              setArmedSkill(key)
              setSkillDependents(undefined)
              return
            }
            setArmedSkill(undefined)
          }
          void act(async () => {
            try {
              const next = await runSkillAction({
                action,
                skill,
                confirm: true,
                acknowledgeDependents: skillDependents?.id === skill.id,
                dependents: skillDependents?.id === skill.id ? skillDependents.dependents : [],
              })
              setConfirmingSkill(undefined)
              setSkillDependents(undefined)
              return next
            } catch (caught) {
              const error = caught as Error & { code?: string; dependents?: readonly string[] }
              if (error.code === 'dependents-required' && error.dependents && skill) {
                setSkillDependents({ id: skill.id, dependents: error.dependents })
                if (action === 'disable') setArmedSkill(`disable:${skill.id}`)
              }
              throw caught
            }
          })
          return
        }
        if (action === 'approve' || action === 'reject' || action === 'activate' || action === 'reactivate' || action === 'rollback') {
          const key = action === 'rollback' ? 'rollback' : `${action}:${skill?.id ?? ''}`
          if (armedSkill !== key) {
            setArmedSkill(key)
            return
          }
          setArmedSkill(undefined)
          void act(() => runSkillAction({
            action,
            skill,
            confirm: true,
            rollback: empty.skillRollback,
          }))
          return
        }
      }}
      confirmingPlugin={confirmingPlugin}
      onAskUninstall={(plugin) => { setConfirmingPlugin(plugin.id) }}
      onCancelUninstall={() => { setConfirmingPlugin(undefined) }}
      onConfirmUninstall={(plugin) => {
        setConfirmingPlugin(undefined)
        void act(() => uninstallPlugin(plugin, true))
      }}
      deferredRollback={deferredRollback}
      armedRollback={armedRollback}
      onDeferRollback={() => {
        setArmedRollback(false)
        setDeferredRollback(true)
      }}
      onAskRollback={(card) => {
        if (!armedRollback) {
          setArmedRollback(true)
          return
        }
        setArmedRollback(false)
        void act(() => rollbackSystemState(card, true))
      }}
      onRecovery={(action) => {
        if (action !== 'diagnostics' && armedRecovery !== action) {
          setArmedRecovery(action)
          return
        }
        setArmedRecovery(undefined)
        void act(() => runRecovery(action, true))
      }}
    />
  )
}
