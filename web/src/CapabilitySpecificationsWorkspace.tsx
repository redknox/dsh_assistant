import React, { useMemo, useState } from 'react'
import type { SkillProjection } from '../../src/domain/workspace/types'
import type { CapabilitySpecificationsControl } from './useCapabilitySpecifications'
import { Glyph } from './icons'
import { CAPABILITY_DELIVERY_STEPS, projectCapabilityBuildQueue, projectSkillBuildQueue, type CapabilityDeliveryItem, type CapabilityDeliveryProgress, type SkillDeliveryItem } from './capabilityBuildQueue'

export function CapabilitySpecificationsWorkspace(props: {
  readonly control: CapabilitySpecificationsControl
  readonly skills?: readonly SkillProjection[]
  readonly locked: boolean
  readonly requestCapability?: () => void
  readonly continueDelivery?: (item: CapabilityDeliveryProgress) => void
}) {
  const { control } = props
  const [selectedSkillId, setSelectedSkillId] = useState<string>()
  const selected = control.selected
  const superseded = selected !== undefined && control.snapshot?.specifications.some((item) => item.supersedesId === selected.id) === true
  const editable = Boolean(selected
    && control.snapshot?.mutable
    && selected.source === 'explicit'
    && !superseded
    && !props.locked)
  const queue = useMemo(() => projectCapabilityBuildQueue(control.snapshot), [control.snapshot])
  const skillQueue = useMemo(() => projectSkillBuildQueue(props.skills), [props.skills])
  const selectedDelivery = [...queue.open, ...queue.history].find((item) => item.specification.id === selected?.id)
  const selectedSkill = [...skillQueue.open, ...skillQueue.history].find((item) => item.skill.id === selectedSkillId)
  const selectSpecification = (id: string) => {
    setSelectedSkillId(undefined)
    control.select(id)
  }
  const summary = {
    open: queue.summary.open + skillQueue.summary.open,
    needsUser: queue.summary.needsUser + skillQueue.summary.needsUser,
    inProgress: queue.summary.inProgress + skillQueue.summary.inProgress,
    live: queue.summary.live + skillQueue.summary.live,
  }
  return (
    <main className="conversation-panel instrument-panel specification-workspace" aria-label="Capability Build Queue">
      <header className="workspace-title specification-title">
        <div>
          <span className="eyebrow">CAPABILITY DEVELOPMENT / GOVERNED PIPELINE</span>
          <h1>BUILD QUEUE</h1>
          <p>Capabilities moving from business intent toward validation, review, exact approval, and activation. Specifications remain the immutable starting evidence.</p>
        </div>
        <div className="specification-title-actions">
          <button type="button" className="button button--approval" disabled={props.locked || control.loading} onClick={props.requestCapability ?? control.beginCreate}>REQUEST IN CHAT</button>
          <button type="button" className="button button--secondary" disabled={control.loading} onClick={control.load}>REFRESH</button>
        </div>
      </header>
      {control.error ? <p className="settings-alert" role="alert">{control.error}</p> : null}
      {control.notice ? <p className="settings-notice" role="status">{control.notice}</p> : null}
      <section className="capability-center-summary build-queue-summary" aria-label="Capability delivery summary">
        <QueueSummary label="IN DELIVERY" value={summary.open} />
        <QueueSummary label="NEEDS YOU" value={summary.needsUser} />
        <QueueSummary label="IN PROGRESS" value={summary.inProgress} />
        <QueueSummary label="LIVE" value={summary.live} />
      </section>
      <div className="specification-layout">
        <aside className="specification-index" aria-label="Capability delivery queue">
          <div className="specification-index-heading">
            <span>IN DELIVERY</span>
            <strong>{summary.open}</strong>
          </div>
          {control.loading && !control.snapshot ? <p className="settings-state">Reading Workbench authority…</p> : null}
          <ol>
            {queue.open.map((item) => <DeliveryIndexItem key={item.id} item={item} selected={!selectedSkill && selected?.id === item.specification.id} select={selectSpecification} />)}
            {skillQueue.open.map((item) => <SkillDeliveryIndexItem key={item.id} item={item} selected={selectedSkill?.skill.id === item.skill.id} select={setSelectedSkillId} />)}
          </ol>
          {control.snapshot && summary.open === 0 ? <p className="specification-empty">Nothing is waiting for delivery. Describe a missing outcome to begin.</p> : null}
          {queue.history.length + skillQueue.history.length > 0 ? (
            <details className="build-queue-history">
              <summary>HISTORY <span>{queue.history.length + skillQueue.history.length}</span></summary>
              <ol>
                {queue.history.map((item) => <DeliveryIndexItem key={`history:${item.id}`} item={item} selected={!selectedSkill && selected?.id === item.specification.id} select={selectSpecification} />)}
                {skillQueue.history.map((item) => <SkillDeliveryIndexItem key={`history:${item.id}`} item={item} selected={selectedSkill?.skill.id === item.skill.id} select={setSelectedSkillId} />)}
              </ol>
            </details>
          ) : null}
        </aside>
        <section className="specification-detail" aria-live="polite">
          {control.creating ? <NewSpecificationForm control={control} locked={props.locked} /> : selectedSkill ? <SkillDeliveryDetail item={selectedSkill} onAction={props.continueDelivery} /> : !selected ? <div className="specification-placeholder"><Glyph name="hex" /><p>Select a capability delivery item.</p></div> : (
            <>
              <header className="specification-detail-header">
                <div>
                  <span className="eyebrow">{selected.id} / SHA {selected.digest.slice(0, 12)}</span>
                  <h2>{selected.capability}</h2>
                </div>
                <div className="specification-badges">
                  <span data-spec-status={selectedDelivery?.stage ?? selected.status}>{selectedDelivery?.stateLabel ?? selected.status.replace('-', ' ')}</span>
                  <span>REV {selected.revision}</span>
                  {superseded ? <span>HISTORY</span> : null}
                </div>
              </header>
              {selectedDelivery ? <DeliveryOverview
                item={selectedDelivery}
                onAction={props.continueDelivery}
                onAskStop={selectedDelivery.historical || selectedDelivery.stage === 'approve' || selectedDelivery.stage === 'activate'
                  ? undefined
                  : () => control.askStop(selectedDelivery.id)}
                confirmingStop={control.confirmingStopId === selectedDelivery.id}
                stopping={control.stopping}
                cancelStop={control.cancelStop}
                confirmStop={control.stopDelivery}
              /> : null}
              {control.comparison ? (
                <div className="specification-diff" data-specification-diff="true">
                  <strong>Δ REV {control.comparison.from.revision} → {control.comparison.to.revision}</strong>
                  <span>{control.comparison.changedFields.length ? control.comparison.changedFields.join(' · ') : 'No business fields changed'}</span>
                </div>
              ) : null}
              <details className="specification-technical-record">
                <summary><span>SPECIFICATION &amp; EVIDENCE</span><small>Business rules, permissions, effects, acceptance examples, and revision controls</small></summary>
                <div className="specification-form">
                <label>
                  <span>GOAL</span>
                  <textarea value={control.draft.goal} disabled={!editable} rows={3} onChange={(event) => control.change('goal', event.target.value)} />
                </label>
                <div className="specification-form-grid">
                  <LineEditor label="NON-GOALS" help="One boundary per line" field="nonGoals" value={control.draft.nonGoals} editable={editable} control={control} />
                  <LineEditor label="BUSINESS RULES" help="One authoritative rule per line" field="businessRules" value={control.draft.businessRules} editable={editable} control={control} />
                </div>
                <LineEditor label="UNRESOLVED QUESTIONS" help="A non-empty list blocks Capability Resolution" field="unresolved" value={control.draft.unresolved} editable={editable} control={control} />
                </div>
                <div className="specification-evidence-grid">
                <SpecBlock title="INPUTS">
                  {selected.inputs.length ? selected.inputs.map((item) => <p key={item.name}><strong>{item.name}</strong><span>{item.required ? 'REQUIRED' : 'OPTIONAL'}</span><small>{item.description}</small></p>) : <Empty />}
                </SpecBlock>
                <SpecBlock title="RUNTIME PERMISSIONS">
                  {selected.permissions.length ? selected.permissions.map((item) => <code key={item}>{item}</code>) : <Empty />}
                </SpecBlock>
                <SpecBlock title="OPERATIONAL EFFECTS">
                  {effectLines(selected.effects).map((item) => <p key={item}>{item}</p>)}
                </SpecBlock>
                <SpecBlock title="ACCEPTANCE EXAMPLES">
                  {selected.acceptanceExamples.map((example) => (
                    <details key={example.name}>
                      <summary>{example.name}{example.fixture ? <span>EXECUTABLE</span> : null}</summary>
                      <p><strong>GIVEN</strong> {example.given.join(' · ') || 'No precondition'}</p>
                      <p><strong>WHEN</strong> {example.when}</p>
                      <p><strong>THEN</strong> {example.then.join(' · ')}</p>
                      {example.fixture ? <pre>INPUT {pretty(example.fixture.input)}{`\n`}EXPECTED {pretty(example.fixture.expected)}</pre> : null}
                    </details>
                  ))}
                </SpecBlock>
                <SpecBlock title="EVALUATION EVIDENCE">
                  {control.evaluation?.report ? (
                    <div className="specification-evaluation" data-evaluation-status={control.evaluation.report.status}>
                      <p><strong>{control.evaluation.report.status.toUpperCase()}</strong><span>{control.evaluation.report.executed} CASES</span><small>{control.evaluation.report.summary}</small></p>
                      <p>Candidate · <code>{control.evaluation.candidateId}</code></p>
                      {control.evaluation.report.cases.map((item) => (
                        <details key={item.name}>
                          <summary>{item.name}<span>{item.status.toUpperCase()}</span></summary>
                          <pre>EXPECTED {pretty(item.expected)}{item.actual === undefined ? '' : `\nACTUAL ${pretty(item.actual)}`}</pre>
                          {item.error ? <p>{item.error}</p> : null}
                        </details>
                      ))}
                    </div>
                  ) : <span className="specification-none">{control.evaluation?.candidateId ? 'CANDIDATE NOT EVALUATED' : 'NO CANDIDATE BOUND'}</span>}
                </SpecBlock>
                </div>
                <footer className="specification-footer">
                <p><Glyph name="shield" /> Saving creates a successor revision. It never changes existing Plans or Candidates.</p>
                <button type="button" className="button button--approval" data-specification-action="revise" disabled={!editable || !control.dirty || control.saving} onClick={control.saveRevision}>
                  {control.saving ? 'CREATING REVISION…' : superseded ? 'HISTORICAL REVISION' : 'CREATE NEW REVISION'}
                </button>
                </footer>
              </details>
            </>
          )}
        </section>
      </div>
    </main>
  )
}

function QueueSummary(props: { readonly label: string; readonly value: number }) {
  return <div><span>{props.label}</span><strong>{props.value}</strong></div>
}

function DeliveryIndexItem(props: { readonly item: CapabilityDeliveryItem; readonly selected: boolean; readonly select: (id: string) => void }) {
  const { item } = props
  return (
    <li>
      <button type="button" className={props.selected ? 'is-active' : ''} aria-current={props.selected ? 'true' : undefined} data-delivery-stage={item.stage} onClick={() => props.select(item.specification.id)}>
        <span><i className="control-lamp" aria-hidden="true" />{item.specification.capability}</span>
        <small>{item.stateLabel} · REV {item.specification.revision}</small>
        <em>{item.specification.goal}</em>
        {item.needsUser ? <strong className="delivery-needs-user">YOUR DECISION</strong> : null}
      </button>
    </li>
  )
}

function SkillDeliveryIndexItem(props: { readonly item: SkillDeliveryItem; readonly selected: boolean; readonly select: (id: string) => void }) {
  const { item } = props
  return (
    <li>
      <button type="button" className={props.selected ? 'is-active' : ''} aria-current={props.selected ? 'true' : undefined} data-delivery-stage={item.stage} onClick={() => props.select(item.skill.id)}>
        <span><i className="control-lamp" aria-hidden="true" />{item.skill.name}</span>
        <small>{item.stateLabel} · SKILL {item.skill.version}</small>
        <em>{item.skill.description}</em>
        {item.needsUser ? <strong className="delivery-needs-user">YOUR DECISION</strong> : null}
      </button>
    </li>
  )
}

function SkillDeliveryDetail(props: { readonly item: SkillDeliveryItem; readonly onAction?: (item: CapabilityDeliveryProgress) => void }) {
  const { item } = props
  const skill = item.skill
  return (
    <>
      <header className="specification-detail-header">
        <div>
          <span className="eyebrow">SKILL / {skill.id}</span>
          <h2>{skill.name}</h2>
        </div>
        <div className="specification-badges"><span data-spec-status={item.stage}>{item.stateLabel}</span><span>{skill.version}</span></div>
      </header>
      <DeliveryOverview item={item} onAction={props.onAction} />
      <details className="specification-technical-record">
        <summary><span>SKILL DETAILS</span><small>Invocation, resources, dependencies, validation, review, and exact revision identity</small></summary>
        <div className="skill-delivery-details">
          <p><strong>PURPOSE</strong><span>{skill.description}</span></p>
          {skill.whenToUse ? <p><strong>WHEN TO USE</strong><span>{skill.whenToUse}</span></p> : null}
          <p><strong>INVOCATION</strong><span>Model {skill.modelInvocable ? 'enabled' : 'disabled'} · User {skill.userInvocable ? 'enabled' : 'disabled'}</span></p>
          <p><strong>RESOURCES</strong><span>{skill.resources.join(', ') || 'None'}</span></p>
          <p><strong>DEPENDENCIES</strong><span>{skill.dependsOn.join(', ') || 'None'}</span></p>
          <p><strong>EVIDENCE</strong><span>Validation {skill.validationPassed ? 'passed' : 'pending'} · Review {skill.reviewComplete ? 'complete' : 'pending'}</span></p>
          <p><strong>IDENTITY</strong><code>{skill.digest}</code></p>
        </div>
      </details>
    </>
  )
}

function DeliveryOverview(props: {
  readonly item: CapabilityDeliveryProgress
  readonly onAction?: (item: CapabilityDeliveryProgress) => void
  readonly onAskStop?: () => void
  readonly confirmingStop?: boolean
  readonly stopping?: boolean
  readonly cancelStop?: () => void
  readonly confirmStop?: () => void
}) {
  const { item } = props
  return (
    <section className="delivery-overview" data-delivery-stage={item.stage}>
      <ol aria-label="Capability delivery progress">
        {CAPABILITY_DELIVERY_STEPS.map((step, index) => {
          const state = item.completedSteps > index ? 'complete' : item.completedSteps === index ? 'current' : 'pending'
          return <li key={step} data-step-state={state}><span>{String(index + 1).padStart(2, '0')}</span><strong>{step}</strong></li>
        })}
      </ol>
      <div className="delivery-next-action">
        <span>{item.needsUser ? 'NEEDS YOUR DECISION' : 'NEXT'}</span>
        <strong>{item.stateLabel}</strong>
        <p>{item.nextAction}</p>
        {item.action ? <button type="button" className="button button--approval delivery-action" data-delivery-action={item.action.kind} onClick={() => props.onAction?.(item)}>{item.action.label}</button> : null}
        {item.action?.kind === 'conversation' && !item.action.sessionId
          ? <small className="delivery-session-fallback">ORIGIN SESSION NOT RECORDED · CONTINUES IN CURRENT CHAT</small>
          : null}
        {props.confirmingStop ? (
          <div className="delivery-stop-confirmation" role="alertdialog" aria-label="Confirm stop development">
            <strong>CONFIRM STOP DEVELOPMENT</strong>
            <p>This removes the item from active delivery. Specifications, Candidates, approvals, and audit evidence are retained.</p>
            <div>
              <button type="button" className="button button--secondary" disabled={props.stopping} onClick={props.cancelStop}>KEEP DEVELOPING</button>
              <button type="button" className="button button--fault" data-delivery-stop="confirm" disabled={props.stopping} onClick={props.confirmStop}>{props.stopping ? 'STOPPING…' : 'STOP DEVELOPMENT'}</button>
            </div>
          </div>
        ) : props.onAskStop ? (
          <button type="button" className="button button--secondary delivery-stop" data-delivery-stop="ask" onClick={props.onAskStop}>STOP DEVELOPMENT</button>
        ) : null}
      </div>
    </section>
  )
}

function NewSpecificationForm(props: { readonly control: CapabilitySpecificationsControl; readonly locked: boolean }) {
  const { control } = props
  const draft = control.createDraft
  const editable = control.snapshot?.mutable === true && !props.locked && !control.saving
  const field = (name: keyof typeof draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    control.changeCreate(name, event.target.value)
  }
  return (
    <section className="specification-create" aria-label="Define a missing capability">
      <header className="specification-detail-header">
        <div>
          <span className="eyebrow">CAPABILITY GAP / NO TOOL CREATED YET</span>
          <h2>DEFINE THE MISSING CAPABILITY</h2>
          <p>This records business intent only. Resolution must still prove reuse, configuration, adoption, provider implementation, owner evolution, or a new Candidate.</p>
        </div>
        <div className="specification-badges"><span>HOST OWNED</span><span>REV 1</span></div>
      </header>
      <div className="specification-form">
        <div className="specification-form-grid">
          <label><span>CAPABILITY ID<small>Stable dotted identity</small></span><input value={draft.capability} disabled={!editable} placeholder="finance.exchange-rate.query" onChange={field('capability')} /></label>
          <label><span>REMOTE SIDE EFFECT<small>Declare the strongest external effect</small></span><select value={draft.remoteSideEffect} disabled={!editable} onChange={field('remoteSideEffect')}><option value="none">NONE</option><option value="read-only">READ ONLY</option><option value="mutate">MUTATE</option></select></label>
        </div>
        <label><span>GOAL</span><textarea value={draft.goal} disabled={!editable} rows={3} placeholder="What outcome must this capability reliably produce?" onChange={field('goal')} /></label>
        <div className="specification-form-grid">
          <CreateLines label="BUSINESS RULES" help="Required · one rule per line" value={draft.businessRules} editable={editable} onChange={field('businessRules')} />
          <CreateLines label="NON-GOALS" help="Explicit boundaries" value={draft.nonGoals} editable={editable} onChange={field('nonGoals')} />
        </div>
        <fieldset className="specification-create-group">
          <legend>INITIAL ACCEPTANCE EXAMPLE</legend>
          <label><span>NAME</span><input value={draft.acceptanceName} disabled={!editable} onChange={field('acceptanceName')} /></label>
          <CreateLines label="GIVEN" help="One precondition per line" value={draft.acceptanceGiven} editable={editable} onChange={field('acceptanceGiven')} />
          <label><span>WHEN</span><textarea value={draft.acceptanceWhen} disabled={!editable} rows={2} placeholder="The user or Agent performs…" onChange={field('acceptanceWhen')} /></label>
          <CreateLines label="THEN" help="Required · observable outcomes" value={draft.acceptanceThen} editable={editable} onChange={field('acceptanceThen')} />
        </fieldset>
        <fieldset className="specification-create-group">
          <legend>RUNTIME AUTHORITY</legend>
          <CreateLines label="RUNTIME PERMISSIONS" help="Exact Broker operations, one per line" value={draft.permissions} editable={editable} onChange={field('permissions')} />
          <div className="specification-form-grid">
            <CreateLines label="FILESYSTEM EFFECTS" help="Governed paths or operations" value={draft.filesystem} editable={editable} onChange={field('filesystem')} />
            <CreateLines label="NETWORK EFFECTS" help="Hosts or providers" value={draft.network} editable={editable} onChange={field('network')} />
            <CreateLines label="PROCESS EFFECTS" help="Process authority" value={draft.process} editable={editable} onChange={field('process')} />
            <CreateLines label="SECRET ACCESS" help="Secret names only; never values" value={draft.secrets} editable={editable} onChange={field('secrets')} />
          </div>
          <CreateLines label="EXTERNAL SYSTEMS" help="Named external systems" value={draft.externalSystems} editable={editable} onChange={field('externalSystems')} />
        </fieldset>
        <CreateLines label="UNRESOLVED QUESTIONS" help="Any entry keeps Resolution blocked" value={draft.unresolved} editable={editable} onChange={field('unresolved')} />
      </div>
      <footer className="specification-footer">
        <p><Glyph name="shield" /> Creating this record grants no Tool, permission, installation, or activation authority.</p>
        <div>
          <button type="button" className="button button--secondary" disabled={control.saving} onClick={control.cancelCreate}>CANCEL</button>
          <button type="button" className="button button--approval" data-specification-action="create" disabled={!editable || !control.canCreate} onClick={control.createSpecification}>
            {control.saving ? 'RECORDING…' : 'CREATE SPECIFICATION'}
          </button>
        </div>
      </footer>
    </section>
  )
}

function CreateLines(props: {
  readonly label: string
  readonly help: string
  readonly value: string
  readonly editable: boolean
  readonly onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void
}) {
  return <label><span>{props.label}<small>{props.help}</small></span><textarea value={props.value} disabled={!props.editable} rows={3} onChange={props.onChange} /></label>
}

function LineEditor(props: {
  readonly label: string
  readonly help: string
  readonly field: 'nonGoals' | 'businessRules' | 'unresolved'
  readonly value: string
  readonly editable: boolean
  readonly control: CapabilitySpecificationsControl
}) {
  return <label><span>{props.label}<small>{props.help}</small></span><textarea value={props.value} disabled={!props.editable} rows={5} onChange={(event) => props.control.change(props.field, event.target.value)} /></label>
}

function SpecBlock(props: { readonly title: string; readonly children: React.ReactNode }) {
  return <section className="specification-block"><h3>{props.title}</h3><div>{props.children}</div></section>
}

function Empty() { return <span className="specification-none">NONE DECLARED</span> }

function effectLines(effects: NonNullable<CapabilitySpecificationsControl['selected']>['effects']): string[] {
  const out = [`remote side effect · ${effects.remoteSideEffect}`]
  for (const key of ['filesystem', 'network', 'process', 'secrets', 'externalSystems'] as const) {
    if (effects[key].length) out.push(`${key} · ${effects[key].join(', ')}`)
  }
  return out
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2)
}
