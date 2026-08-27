import React from 'react'
import type { ActivationCard, ApprovalCard, MissionControlView, SkillProjection, UserPluginView } from '../../src/domain/workspace/types'
import { Glyph } from './icons'
import { isPendingApproval, skillInvocationSurfaceOpen } from './missionControlPresentation'

type SkillAction = 'approve' | 'reject' | 'activate' | 'disable' | 'reactivate' | 'uninstall' | 'rollback'

export interface ExtensionsWorkspaceState {
  readonly locked: boolean
  readonly inspecting?: string
  readonly confirmingPlugin?: string
  readonly armedActivation?: string
  readonly armedAbandonment?: string
  readonly confirmingSkill?: string
  readonly armedSkill?: string
  readonly skillDependents?: { readonly id: string; readonly dependents: readonly string[] }
}

export interface ExtensionsWorkspaceActions {
  readonly inspect: (id: string) => void
  readonly approve: (card: ApprovalCard) => void
  readonly reject: (card: ApprovalCard) => void
  readonly activate?: (card: ActivationCard) => void
  readonly abandonActivation?: (card: ActivationCard) => void
  readonly askUninstall?: (plugin: UserPluginView) => void
  readonly cancelUninstall?: () => void
  readonly confirmUninstall?: (plugin: UserPluginView) => void
  readonly skill: (action: SkillAction, skill?: SkillProjection) => void
}

export function PluginLifecycleControl(props: {
  readonly plugin: UserPluginView
  readonly locked: boolean
  readonly confirming: boolean
  readonly actions: Pick<ExtensionsWorkspaceActions, 'askUninstall' | 'cancelUninstall' | 'confirmUninstall'>
}) {
  const { plugin, actions } = props
  const blocked = plugin.dependency.severity === 'hard' || plugin.dependency.severity === 'unresolved'
  const hard = plugin.dependency.dependents.filter((item) => item.kind === 'hard')
  const optional = plugin.dependency.dependents.filter((item) => item.kind === 'optional')
  const historical = plugin.dependency.dependents.filter((item) => item.kind === 'historical')
  return (
    <div className="plugin-row" data-plugin-id={plugin.id} data-owner={plugin.owner} data-version={plugin.version} data-uninstallable={plugin.uninstallable ? 'yes' : 'no'}>
      <dt><span className="capability-area">{plugin.owner}@{plugin.version}</span><span className="capability-action">{plugin.capabilities.join(', ') || 'user plugin'}</span></dt>
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
              <button type="button" className="button button--secondary" data-uninstall-action="cancel" onClick={actions.cancelUninstall}>Cancel</button>
              <button type="button" className="button button--approval" data-uninstall-action="confirm" disabled={props.locked || blocked} onClick={() => actions.confirmUninstall?.(plugin)}>Confirm uninstall</button>
            </div>
          </div>
        ) : (
          <button type="button" className="plugin-uninstall" data-uninstall-action="ask" aria-label="Uninstall plugin" title="Uninstall plugin" disabled={props.locked} onClick={() => actions.askUninstall?.(plugin)}><Glyph name="trash" /></button>
        )}
      </dd>
    </div>
  )
}

function SkillsCenter(props: { readonly view: MissionControlView; readonly state: ExtensionsWorkspaceState; readonly actions: ExtensionsWorkspaceActions }) {
  const { view, state, actions } = props
  const skills = view.skills ?? []
  const catalogOpen = skillInvocationSurfaceOpen(view)
  return (
    <section className="capability-section" aria-labelledby="skills-title">
      <h2 id="skills-title">SKILLS</h2>
      {view.skillCatalog?.state === 'degraded' || view.skillCatalog?.state === 'withheld' ? (
        <p className="workbench-meta" data-skill-catalog={view.skillCatalog.state}>
          {view.skillCatalog.state === 'withheld' ? 'catalog withheld' : `catalog degraded${view.skillCatalog.failed.length > 0 ? ` · failed ${view.skillCatalog.failed.join(', ')}` : ''}`}
          {view.skillCatalog.detail ? ` · ${view.skillCatalog.detail}` : ''}
        </p>
      ) : null}
      <ul className="workbench-list" data-skills="true">
        {skills.length === 0 ? <li className="workbench-item">No Skills in this Profile catalog.</li> : skills.map((skill) => (
          <li key={skill.id} className="workbench-item" data-skill-id={skill.id} data-skill-lifecycle={skill.lifecycle} data-skill-system={skill.system ? 'yes' : 'no'}>
            <div className="workbench-identity">{skill.name}@{skill.version}</div>
            <div className="workbench-meta">profile {skill.profile} · digest {skill.digest}</div>
            <div className="workbench-meta">lifecycle {skill.lifecycle} · {skill.provenance}</div>
            <div className="workbench-meta">{skill.description}</div>
            {skill.whenToUse ? <div className="workbench-meta">when {skill.whenToUse}</div> : null}
            <div className="workbench-meta">invocation model {skill.modelInvocable ? 'yes' : 'no'} · user {skill.userInvocable ? 'yes' : 'no'}</div>
            <div className="workbench-meta">resources {skill.resources.join(', ') || 'none'}</div>
            <div className="workbench-meta">validation {skill.validationPassed ? 'passed' : 'not passed'} · review {skill.reviewComplete ? 'complete' : 'not complete'}</div>
            {skill.dependsOn.length > 0 ? <div className="workbench-meta">depends on {skill.dependsOn.join(', ')}</div> : null}
            {skill.dependents.length > 0 ? <div className="workbench-meta" data-skill-dependents="true">dependents {skill.dependents.join(', ')}</div> : null}
            {skill.lastFailure ? <div className="workbench-meta" data-skill-failed="true">failed {skill.lastFailure.phase} · {skill.lastFailure.detail}</div> : null}
            {skill.revisionDiff ? (
              <div className="workbench-meta" data-skill-diff="true">
                instruction {skill.revisionDiff.instructionChanged ? 'changed' : 'unchanged'} ({skill.revisionDiff.instructionBeforeChars}→{skill.revisionDiff.instructionAfterChars} chars)
                {skill.revisionDiff.resources.added.length ? ` · resources +${skill.revisionDiff.resources.added.join(',')}` : ''}
                {skill.revisionDiff.resources.removed.length ? ` · resources -${skill.revisionDiff.resources.removed.join(',')}` : ''}
                {` · invocation ${skill.revisionDiff.invocation.before.modelInvocable ? 'model' : 'no-model'}/${skill.revisionDiff.invocation.before.userInvocable ? 'user' : 'no-user'}→${skill.revisionDiff.invocation.after.modelInvocable ? 'model' : 'no-model'}/${skill.revisionDiff.invocation.after.userInvocable ? 'user' : 'no-user'}`}
                {skill.revisionDiff.dependsOn.added.length ? ` · depends +${skill.revisionDiff.dependsOn.added.join(',')}` : ''}
                {skill.revisionDiff.dependsOn.removed.length ? ` · depends -${skill.revisionDiff.dependsOn.removed.join(',')}` : ''}
              </div>
            ) : null}
            {skill.resolutionHandoff ? <div className="workbench-meta" data-skill-handoff="capability-resolution">missing tools {skill.resolutionHandoff.missingTools.join(', ')} · next Capability Resolution</div> : null}
            {state.skillDependents?.id === skill.id ? <div className="workbench-meta" data-skill-dependent-warning="true">hard dependents {state.skillDependents.dependents.join(', ')}</div> : null}
            <div className="approval-actions">
              {skill.lifecycle === 'approval-requested' ? <>
                <button type="button" className="button button--secondary" data-skill-action="reject" disabled={state.locked} onClick={() => actions.skill('reject', skill)}>{state.armedSkill === `reject:${skill.id}` ? 'CONFIRM REJECT' : 'REJECT'}</button>
                <button type="button" className="button button--approval" data-skill-action="approve" disabled={state.locked} onClick={() => actions.skill('approve', skill)}>{state.armedSkill === `approve:${skill.id}` ? 'CONFIRM APPROVE' : 'APPROVE'}</button>
              </> : null}
              {catalogOpen && skill.lifecycle === 'approved' ? <button type="button" className="button button--approval" data-skill-action="activate" disabled={state.locked} onClick={() => actions.skill('activate', skill)}>{state.armedSkill === `activate:${skill.id}` ? 'CONFIRM ACTIVATE' : 'ACTIVATE'}</button> : null}
              {catalogOpen && skill.lifecycle === 'disabled' ? <button type="button" className="button button--approval" data-skill-action="reactivate" disabled={state.locked} onClick={() => actions.skill('reactivate', skill)}>{state.armedSkill === `reactivate:${skill.id}` ? 'CONFIRM REACTIVATE' : 'REACTIVATE'}</button> : null}
              {skill.lifecycle === 'active' && !skill.system ? <button type="button" className="button button--secondary" data-skill-action="disable" disabled={state.locked} onClick={() => actions.skill('disable', skill)}>{state.skillDependents?.id === skill.id ? 'CONFIRM DEPENDENTS' : state.armedSkill === `disable:${skill.id}` ? 'CONFIRM DISABLE' : 'DISABLE'}</button> : null}
              {!skill.system && skill.lifecycle !== 'uninstalled' ? state.confirmingSkill === skill.id ? <>
                <button type="button" className="button button--secondary" data-skill-action="cancel-uninstall" disabled={state.locked} onClick={() => actions.skill('uninstall')}>CANCEL</button>
                <button type="button" className="button button--approval" data-skill-action="confirm-uninstall" disabled={state.locked} onClick={() => actions.skill('uninstall', skill)}>{state.skillDependents?.id === skill.id ? 'CONFIRM DEPENDENTS' : 'CONFIRM UNINSTALL'}</button>
              </> : <button type="button" className="button button--secondary" data-skill-action="uninstall" disabled={state.locked} onClick={() => actions.skill('uninstall', skill)}>UNINSTALL</button> : null}
            </div>
          </li>
        ))}
      </ul>
      {view.skillRollback ? <button type="button" className="button button--secondary" data-skill-action="rollback" disabled={state.locked} onClick={() => actions.skill('rollback')}>{state.armedSkill === 'rollback' ? 'CONFIRM ROLLBACK' : `ROLLBACK ${view.skillRollback.name}@${view.skillRollback.version}`}</button> : null}
    </section>
  )
}

export function ExtensionsWorkspace(props: { readonly view: MissionControlView; readonly state: ExtensionsWorkspaceState; readonly actions: ExtensionsWorkspaceActions }) {
  const { view, state, actions } = props
  return (
    <main className="conversation-panel extensions-panel" id="extensions" data-workspace-pane="extensions">
      <div className="conversation-scroll">
        <section className="capability-section" aria-labelledby="extensions-title">
          <h2 id="extensions-title">EXTENSIONS</h2>
          <ul className="workbench-list" data-extensions="true">
            {(view.extensions ?? []).length === 0 ? <li className="workbench-item">No generated or third-party extensions in this home.</li> : (view.extensions ?? []).map((item) => {
              const approval = (view.approvals ?? []).find((candidate) => candidate.candidateId === item.candidateId)
              const card = (view.activations ?? []).find((activation) => activation.candidateId === item.candidateId)
              const plugin = (view.plugins ?? []).find((row) => row.owner === item.owner && row.version === item.version)
              const failure = view.activationFailure?.candidateId === item.candidateId ? view.activationFailure : undefined
              const open = state.inspecting === item.id
              const pending = approval !== undefined && isPendingApproval(approval.status)
              const canActivate = (item.lifecycle === 'DISABLED_REACTIVATABLE' || item.lifecycle === 'APPROVED_NOT_ACTIVE' || item.lifecycle === 'ACTIVATION_FAILED') && card !== undefined && item.eligibilityOk
              return (
                <li key={item.id} className="workbench-item" data-extension-id={item.id} data-extension-lifecycle={item.lifecycle} data-registry-status={item.registryStatus} data-extension-inspect={open ? 'open' : 'closed'}>
                  <div className="workbench-identity">{item.owner}@{item.version}</div>
                  <div className="workbench-meta">lifecycle {item.lifecycle.replaceAll('_', ' ')}</div>
                  <div className="workbench-meta">registry {item.registryStatus} · {item.mounted ? 'mounted' : 'unmounted'}</div>
                  <div className="workbench-meta" data-extension-provenance={item.provenance}>provenance {item.provenance === 'third-party' || item.provenanceOrigin === 'import' ? 'Third-party' : item.provenance}{item.provenanceOrigin ? ` / ${item.provenanceOrigin}` : ''}</div>
                  <div className="workbench-meta">capabilities {item.capabilities.join(', ') || 'none'}</div>
                  {item.candidateId ? <div className="workbench-meta">candidate {item.candidateId}</div> : null}
                  {item.digest ? <div className="workbench-meta">digest {item.digest}</div> : null}
                  <div className="workbench-meta">{item.eligibilityOk ? 'eligible' : `not eligible${item.eligibilityDenials.length ? `: ${item.eligibilityDenials.join(', ')}` : ''}`}</div>
                  {item.newerAuthoritative ? <div className="workbench-meta">newer authoritative revision exists</div> : null}
                  {open ? <div className="workbench-meta" data-extension-details="true">review {item.reviewState ?? 'unknown'} · validation {item.validationPassed === true ? 'passed' : 'not passed'} · approval {item.approvalDecision ?? 'none'}{failure ? ` · failed ${failure.phase}: ${failure.summary}` : ''}</div> : null}
                  <div className="approval-actions">
                    <button type="button" className="button button--secondary" data-extension-action={item.lifecycle === 'DISABLED_BLOCKED' ? 'inspect-denials' : item.lifecycle === 'ACTIVATION_FAILED' ? 'diagnostics' : item.lifecycle === 'SUPERSEDED' ? 'view-history' : 'inspect'} disabled={state.locked} onClick={() => actions.inspect(item.id)}>
                      {item.lifecycle === 'DISABLED_BLOCKED' ? (open ? 'HIDE DENIALS' : 'INSPECT DENIALS') : item.lifecycle === 'ACTIVATION_FAILED' ? (open ? 'HIDE DIAGNOSTICS' : 'DIAGNOSTICS') : item.lifecycle === 'SUPERSEDED' ? (open ? 'HIDE HISTORY' : 'VIEW HISTORY') : (open ? 'HIDE' : 'INSPECT')}
                    </button>
                    {item.lifecycle === 'APPROVAL_REQUIRED' && pending && approval ? <>
                      <button type="button" className="button button--secondary" data-extension-action="reject" disabled={state.locked} onClick={() => actions.reject(approval)}>REJECT</button>
                      <button type="button" className="button button--approval" data-extension-action="approve" disabled={state.locked} onClick={() => actions.approve(approval)}>APPROVE</button>
                    </> : null}
                    {canActivate && card ? <>
                      {item.lifecycle === 'ACTIVATION_FAILED' ? <button type="button" className="button button--fault" data-extension-action="abandon" disabled={state.locked} onClick={() => actions.abandonActivation?.(card)}>{state.armedAbandonment === card.id ? 'CONFIRM ABANDON' : 'ABANDON'}</button> : null}
                      <button type="button" className="button button--approval" data-extension-action={item.lifecycle === 'DISABLED_REACTIVATABLE' ? 'reactivate' : item.lifecycle === 'ACTIVATION_FAILED' ? 'retry' : 'activate'} disabled={state.locked} onClick={() => actions.activate?.(card)}>
                        {state.armedActivation === card.id ? (item.lifecycle === 'DISABLED_REACTIVATABLE' ? 'CONFIRM REACTIVATE' : item.lifecycle === 'ACTIVATION_FAILED' ? 'CONFIRM RETRY' : 'CONFIRM ACTIVATE') : (item.lifecycle === 'DISABLED_REACTIVATABLE' ? 'REACTIVATE' : item.lifecycle === 'ACTIVATION_FAILED' ? 'RETRY' : 'ACTIVATE')}
                      </button>
                    </> : null}
                    {item.lifecycle === 'ACTIVE' && plugin ? (
                      <PluginLifecycleControl
                        plugin={plugin}
                        locked={state.locked}
                        confirming={state.confirmingPlugin === plugin.id}
                        actions={actions}
                      />
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
        <SkillsCenter view={view} state={state} actions={actions} />
      </div>
    </main>
  )
}
