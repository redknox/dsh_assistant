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
        <button type="button" className="button button--secondary" disabled={control.loading} onClick={control.load}>REFRESH</button>
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
          {!selected ? <div className="specification-placeholder"><Glyph name="hex" /><p>Select a Capability Specification revision.</p></div> : (
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
                      <summary>{example.name}</summary>
                      <p><strong>GIVEN</strong> {example.given.join(' · ') || 'No precondition'}</p>
                      <p><strong>WHEN</strong> {example.when}</p>
                      <p><strong>THEN</strong> {example.then.join(' · ')}</p>
                    </details>
                  ))}
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
