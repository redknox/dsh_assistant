import React, { useMemo, useState } from 'react'
import type { ToolCatalogView, ToolGovernance } from '../../src/domain/tool-catalog/index'
import { Glyph } from './icons'

type ToolFilter = 'all' | ToolGovernance

export function ToolCatalogWorkspace(props: {
  readonly catalog?: ToolCatalogView
  readonly locked: boolean
  readonly defineCapability: () => void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ToolFilter>('all')
  const normalized = query.trim().toLowerCase()
  const tools = useMemo(() => (props.catalog?.tools ?? []).filter((tool) => (
    (filter === 'all' || tool.governance === filter)
    && (normalized === '' || [tool.name, tool.description, tool.owner, ...tool.capabilities]
      .some((value) => value.toLowerCase().includes(normalized)))
  )), [filter, normalized, props.catalog])
  const summary = props.catalog?.summary
  return (
    <main className="conversation-panel instrument-panel tool-catalog-workspace" aria-label="Tool Catalog">
      <header className="workspace-title tool-catalog-title">
        <div>
          <span className="eyebrow">AGENT EXECUTION SURFACE / LIVE DSH REGISTRY</span>
          <h1>TOOL CATALOG</h1>
          <p>The exact tools this Agent can call now. Generated and imported tools appear only after governed activation; catalog presence grants no new authority.</p>
        </div>
        <button type="button" className="button button--approval" disabled={props.locked} onClick={props.defineCapability}>DEFINE MISSING CAPABILITY</button>
      </header>
      <section className="tool-catalog-summary" aria-label="Tool governance summary">
        <Summary label="VISIBLE" value={summary?.total ?? 0} />
        <Summary label="HOST" value={summary?.hostManaged ?? 0} />
        <Summary label="GENERATED" value={summary?.generatedGoverned ?? 0} />
        <Summary label="THIRD-PARTY" value={summary?.thirdPartyGoverned ?? 0} />
      </section>
      <div className="tool-catalog-controls">
        <label><span className="sr-only">Search tools</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tool, owner, capability…" /></label>
        <div role="group" aria-label="Filter tools by governance">
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
      <section className="tool-catalog-grid" aria-live="polite">
        {tools.map((tool) => (
          <article key={tool.name} className="tool-catalog-card" data-tool-name={tool.name} data-tool-governance={tool.governance}>
            <header>
              <span className="tool-catalog-lamp" aria-hidden="true" />
              <div><h2>{tool.name}</h2><small>{tool.owner}@{tool.version}</small></div>
              <span className="tool-governance-badge">{governanceLabel(tool.governance)}</span>
            </header>
            <p>{tool.description}</p>
            <dl>
              <div><dt>RUNTIME</dt><dd>{tool.runtime.toUpperCase()}</dd></div>
              <div><dt>LIFECYCLE</dt><dd>{tool.lifecycle.toUpperCase()}</dd></div>
            </dl>
            <div className="tool-catalog-contract">
              <strong>PARAMETERS</strong>
              <div>{tool.parameters.length ? tool.parameters.map((item) => <code key={item.name}>{item.name}{item.required ? '*' : ''}</code>) : <span>NONE</span>}</div>
            </div>
            <div className="tool-catalog-contract">
              <strong>CAPABILITIES</strong>
              <div>{tool.capabilities.length ? tool.capabilities.map((item) => <code key={item}>{item}</code>) : <span>HOST RUNTIME TOOL</span>}</div>
            </div>
            {tool.permissions.length ? <div className="tool-catalog-contract"><strong>RUNTIME PERMISSIONS</strong><div>{tool.permissions.map((item) => <code key={item}>{item}</code>)}</div></div> : null}
          </article>
        ))}
        {props.catalog && tools.length === 0 ? <div className="tool-catalog-empty"><Glyph name="terminal" /><p>No visible tools match this filter.</p></div> : null}
        {!props.catalog ? <div className="tool-catalog-empty"><Glyph name="terminal" /><p>Tool Catalog is unavailable until a live Agent is attached.</p></div> : null}
      </section>
      <footer className="tool-catalog-footer">
        <Glyph name="shield" />
        <p><strong>NO DIRECT REGISTRATION</strong><span>A missing Tool begins as a Capability Specification, then passes Resolution, Candidate validation, Independent Review, approval, and isolated activation.</span></p>
      </footer>
    </main>
  )
}

function Summary(props: { readonly label: string; readonly value: number }) {
  return <div><span>{props.label}</span><strong>{props.value}</strong></div>
}

function governanceLabel(value: ToolGovernance): string {
  if (value === 'generated-governed') return 'GENERATED · GOVERNED'
  if (value === 'third-party-governed') return 'THIRD-PARTY · GOVERNED'
  return 'HOST · PRODUCT RELEASE'
}
