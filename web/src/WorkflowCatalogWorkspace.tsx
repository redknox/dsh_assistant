import React, { useMemo, useState } from 'react'
import type { WorkflowCatalogView, WorkflowGovernance } from '../../src/domain/workflow-catalog/index'
import { Glyph } from './icons'

type WorkflowFilter = 'all' | WorkflowGovernance

export function WorkflowCatalogWorkspace(props: {
  readonly catalog?: WorkflowCatalogView
  readonly locked: boolean
  readonly defineCapability: () => void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<WorkflowFilter>('all')
  const normalized = query.trim().toLowerCase()
  const workflows = useMemo(() => (props.catalog?.workflows ?? []).filter((workflow) => (
    (filter === 'all' || workflow.governance === filter)
    && (normalized === '' || [workflow.name, workflow.title, workflow.description, workflow.owner]
      .some((value) => value.toLowerCase().includes(normalized)))
  )), [filter, normalized, props.catalog])
  const summary = props.catalog?.summary
  return (
    <main className="conversation-panel instrument-panel workflow-catalog-workspace" aria-label="Workflow Catalog">
      <header className="workspace-title tool-catalog-title">
        <div>
          <span className="eyebrow">GOVERNED ORCHESTRATION / NATIVE DSH WORKFLOW</span>
          <h1>WORKFLOW CATALOG</h1>
          <p>Trusted orchestration patterns available to this Agent. Runs use bounded Subagents and the ordinary TARS-NG tool policy and approval path.</p>
        </div>
        <button type="button" className="button button--approval" disabled={props.locked} onClick={props.defineCapability}>DEFINE WORKFLOW CAPABILITY</button>
      </header>
      <section className="tool-catalog-summary" aria-label="Workflow governance summary">
        <Summary label="ACTIVE" value={summary?.total ?? 0} />
        <Summary label="HOST" value={summary?.hostManaged ?? 0} />
        <Summary label="GENERATED" value={summary?.generatedGoverned ?? 0} />
        <Summary label="THIRD-PARTY" value={summary?.thirdPartyGoverned ?? 0} />
      </section>
      <div className="tool-catalog-controls">
        <label><span className="sr-only">Search workflows</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search workflow, owner, purpose…" /></label>
        <div role="group" aria-label="Filter workflows by governance">
          {([
            ['all', 'ALL'],
            ['host-managed', 'HOST'],
            ['generated-governed', 'GENERATED'],
            ['third-party-governed', 'THIRD-PARTY'],
          ] as const).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
      </div>
      <section className="workflow-catalog-grid" aria-live="polite">
        {workflows.map((workflow) => (
          <article key={workflow.name} className="tool-catalog-card workflow-catalog-card" data-workflow-name={workflow.name} data-workflow-governance={workflow.governance}>
            <header>
              <span className="tool-catalog-lamp" aria-hidden="true" />
              <div><h2>{workflow.title}</h2><small>{workflow.name} · {workflow.owner}@{workflow.version}</small></div>
              <span className="tool-governance-badge">{governanceLabel(workflow.governance)}</span>
            </header>
            <p>{workflow.description}</p>
            {workflow.whenToUse ? <p className="workflow-when"><strong>WHEN TO USE</strong>{workflow.whenToUse}</p> : null}
            <dl>
              <div><dt>ENGINE</dt><dd>DSH WORKFLOW</dd></div>
              <div><dt>RUNTIME</dt><dd>{workflow.runtime.toUpperCase()}</dd></div>
              <div><dt>INTENT</dt><dd>{workflow.intent.toUpperCase()}</dd></div>
              <div><dt>AGENT CAP</dt><dd>{workflow.maxTotalAgents}</dd></div>
            </dl>
            <div className="tool-catalog-contract">
              <strong>PHASES</strong>
              <div>{workflow.phases.length ? workflow.phases.map((phase, index) => <code key={`${phase.title}-${index}`}>{index + 1}. {phase.title}</code>) : <span>NO DECLARED PHASES</span>}</div>
            </div>
            <div className="tool-catalog-contract">
              <strong>INPUT</strong>
              <div>{workflow.inputFields.length ? workflow.inputFields.map((field) => <code key={field.name}>{field.name}{field.required ? '*' : ''}</code>) : <span>NONE</span>}</div>
            </div>
          </article>
        ))}
        {props.catalog && workflows.length === 0 ? <div className="tool-catalog-empty"><Glyph name="workflow" /><p>No active workflows match this filter.</p></div> : null}
        {!props.catalog ? <div className="tool-catalog-empty"><Glyph name="workflow" /><p>Workflow Catalog is unavailable until the governed runtime is attached.</p></div> : null}
      </section>
      <footer className="tool-catalog-footer">
        <Glyph name="shield" />
        <p><strong>REGISTERED SCRIPTS ONLY</strong><span>Models supply Workflow input, never inline JavaScript. New scripts must pass validation, Independent Review, exact approval, and activation.</span></p>
      </footer>
    </main>
  )
}

function Summary(props: { readonly label: string; readonly value: number }) {
  return <div><span>{props.label}</span><strong>{props.value}</strong></div>
}

function governanceLabel(value: WorkflowGovernance): string {
  if (value === 'generated-governed') return 'GENERATED · GOVERNED'
  if (value === 'third-party-governed') return 'THIRD-PARTY · GOVERNED'
  return 'HOST · PRODUCT RELEASE'
}
