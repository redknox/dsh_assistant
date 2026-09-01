import React from 'react'
import type { CapabilitySpecificationsControl } from './useCapabilitySpecifications'
import { Glyph } from './icons'

export function CapabilitySpecificationsWorkspace(props: {
  readonly control: CapabilitySpecificationsControl
  readonly locked: boolean
}) {
  const { control } = props
  const selected = control.selected
  const superseded = selected !== undefined && control.snapshot?.specifications.some((item) => item.supersedesId === selected.id) === true
  const editable = Boolean(selected
    && control.snapshot?.mutable
    && selected.source === 'explicit'
    && !superseded
    && !props.locked)
  return (
    <main className="conversation-panel instrument-panel specification-workspace" aria-label="Capability Specifications">
      <header className="workspace-title specification-title">
        <div>
          <span className="eyebrow">DOMAIN CONSTRUCTION / HOST AUTHORITY</span>
          <h1>CAPABILITY SPECIFICATIONS</h1>
          <p>Business intent before code. Every revision is immutable and binds Resolution, Candidate review, and approval to one digest.</p>
        </div>
        <div className="specification-title-actions">
          <button type="button" className="button button--approval" disabled={props.locked || control.loading} onClick={control.beginCreate}>NEW SPECIFICATION</button>
          <button type="button" className="button button--secondary" disabled={control.loading} onClick={control.load}>REFRESH</button>
        </div>
      </header>
      {control.error ? <p className="settings-alert" role="alert">{control.error}</p> : null}
      {control.notice ? <p className="settings-notice" role="status">{control.notice}</p> : null}
      <div className="specification-layout">
        <aside className="specification-index" aria-label="Specification revisions">
          <div className="specification-index-heading">
            <span>SPECIFICATIONS</span>
            <strong>{control.snapshot?.specifications.length ?? 0}</strong>
          </div>
          {control.loading && !control.snapshot ? <p className="settings-state">Reading Workbench authority…</p> : null}
          <ol>
            {(control.snapshot?.specifications ?? []).slice().reverse().map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={selected?.id === item.id ? 'is-active' : ''}
                  aria-current={selected?.id === item.id ? 'true' : undefined}
                  onClick={() => control.select(item.id)}
                >
                  <span><i className="control-lamp" aria-hidden="true" />{item.capability}</span>
                  <small>REV {item.revision} · {item.status === 'ready' ? 'READY' : 'CLARIFY'} · {item.id}</small>
                  <em>{item.goal}</em>
                </button>
              </li>
            ))}
          </ol>
          {control.snapshot && control.snapshot.specifications.length === 0 ? <p className="specification-empty">No specifications yet. TARS-NG will create one before the next governed capability change.</p> : null}
        </aside>
        <section className="specification-detail" aria-live="polite">
          {control.creating ? <NewSpecificationForm control={control} locked={props.locked} /> : !selected ? <div className="specification-placeholder"><Glyph name="hex" /><p>Select a Capability Specification revision.</p></div> : (
            <>
              <header className="specification-detail-header">
                <div>
                  <span className="eyebrow">{selected.id} / SHA {selected.digest.slice(0, 12)}</span>
                  <h2>{selected.capability}</h2>
                </div>
                <div className="specification-badges">
                  <span data-spec-status={selected.status}>{selected.status.replace('-', ' ')}</span>
                  <span>REV {selected.revision}</span>
                  {superseded ? <span>HISTORY</span> : null}
                </div>
              </header>
              {control.comparison ? (
                <div className="specification-diff" data-specification-diff="true">
                  <strong>Δ REV {control.comparison.from.revision} → {control.comparison.to.revision}</strong>
                  <span>{control.comparison.changedFields.length ? control.comparison.changedFields.join(' · ') : 'No business fields changed'}</span>
                </div>
              ) : null}
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
            </>
          )}
        </section>
      </div>
    </main>
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
