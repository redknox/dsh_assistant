import React, { useMemo, useState } from 'react'
import { projectCapabilityPortfolio, type CapabilityPortfolioCard } from '../../src/domain/capability-portfolio/index'
import type { MissionControlView, SkillProjection, UserPluginView } from '../../src/domain/workspace/types'
import type { ToolCatalogView } from '../../src/domain/tool-catalog/index'
import type { WorkflowCatalogView } from '../../src/domain/workflow-catalog/index'
import { Glyph } from './icons'
import type { WorkspacePane } from './WorkspaceNavigation'

export function CapabilityCenterWorkspace(props: {
  readonly view: Pick<MissionControlView, 'extensions' | 'plugins' | 'skills'>
  readonly tools?: ToolCatalogView
  readonly workflows?: WorkflowCatalogView
  readonly locked: boolean
  readonly confirmingUnplug?: string
  readonly armedSkill?: string
  readonly skillDependents?: { readonly id: string; readonly dependents: readonly string[] }
  readonly navigate: (pane: WorkspacePane) => void
  readonly defineCapability: () => void
  readonly askUnplug?: (plugin: UserPluginView) => void
  readonly cancelUnplug?: () => void
  readonly confirmUnplug?: (plugin: UserPluginView) => void
  readonly skillAction?: (action: 'disable' | 'cancel-disable', skill?: SkillProjection) => void
}) {
  const [openCard, setOpenCard] = useState<string>()
  const portfolio = useMemo(() => projectCapabilityPortfolio({
    view: props.view,
    tools: props.tools,
    workflows: props.workflows,
  }), [props.tools, props.view, props.workflows])

  return (
    <main className="conversation-panel instrument-panel capability-center-workspace" aria-label="Capability Center">
      <header className="workspace-title capability-center-title">
        <div>
          <span className="eyebrow">INSTALLED CAPABILITIES / GOVERNED LIFECYCLE</span>
          <h1>CAPABILITY CENTER</h1>
          <p>Capabilities you explicitly installed or developed. Built-in product surfaces and connector health live in System Info.</p>
        </div>
        <button type="button" className="button button--approval" disabled={props.locked} onClick={props.defineCapability}>DESCRIBE WHAT YOU NEED</button>
      </header>

      <section className="capability-center-summary" aria-label="Capability portfolio summary">
        <Summary label="CAPABILITIES" value={portfolio.summary.total} />
        <Summary label="ACTIVE" value={portfolio.summary.active} />
        <Summary label="NEEDS ATTENTION" value={portfolio.summary.attention} />
        <Summary label="SAFE TO UNPLUG" value={portfolio.summary.unplugReady} />
      </section>

      <section className="capability-portfolio" aria-label="User capabilities">
        {portfolio.cards.length === 0 ? (
          <div className="capability-portfolio-empty">
            <Glyph name="capabilities" />
            <h2>NO INSTALLED CAPABILITIES YET</h2>
            <p>Describe an outcome in conversation. TARS-NG will propose the smallest governed implementation; built-ins remain visible in System Info.</p>
          </div>
        ) : portfolio.cards.map((card) => {
          const pane = implementationPane(card)
          const skill = card.unplug?.kind === 'skill' ? card.unplug.skill : undefined
          const plugin = card.unplug?.kind === 'plugin' ? card.unplug.plugin : undefined
          const confirming = plugin?.id === props.confirmingUnplug
            || (skill !== undefined && (props.armedSkill === `disable:${skill.id}` || props.skillDependents?.id === skill.id))
          return (
          <CapabilityCard
            key={card.id}
            card={card}
            open={openCard === card.id}
            locked={props.locked}
            confirming={confirming}
            toggle={() => setOpenCard(openCard === card.id ? undefined : card.id)}
            manage={pane ? () => props.navigate(pane) : undefined}
            askUnplug={() => plugin ? props.askUnplug?.(plugin) : skill ? props.skillAction?.('disable', skill) : undefined}
            cancelUnplug={() => plugin ? props.cancelUnplug?.() : skill ? props.skillAction?.('cancel-disable', skill) : undefined}
            confirmUnplug={() => plugin ? props.confirmUnplug?.(plugin) : skill ? props.skillAction?.('disable', skill) : undefined}
          />
          )
        })}
      </section>

      <section className="capability-growth" aria-labelledby="capability-growth-title">
        <div>
          <span className="eyebrow">ONE GOVERNED PATH</span>
          <h2 id="capability-growth-title">FROM NEED TO LIVE CAPABILITY</h2>
          <p>Development consent starts authoring. Exact artifact approval and activation remain separate decisions.</p>
        </div>
        <ol aria-label="Governed capability lifecycle">
          {['NEED', 'PROPOSE', 'CONSENT', 'BUILD', 'VALIDATE', 'REVIEW', 'APPROVE', 'ACTIVATE'].map((step, index) => (
            <li key={step}><span>{String(index + 1).padStart(2, '0')}</span><strong>{step}</strong></li>
          ))}
        </ol>
        <button type="button" className="button button--secondary" disabled={props.locked} onClick={props.defineCapability}>OPEN REQUEST PIPELINE</button>
      </section>

      <footer className="capability-center-footer">
        <Glyph name="shield" />
        <p><strong>CAPABILITY IS THE PRODUCT OBJECT</strong><span>Tools, Skills, Workflows, Extensions, and Connectors are implementation details. Subagents remain governed runtime workers.</span></p>
      </footer>
    </main>
  )
}

function CapabilityCard(props: {
  readonly card: CapabilityPortfolioCard
  readonly open: boolean
  readonly locked: boolean
  readonly confirming: boolean
  readonly toggle: () => void
  readonly manage?: () => void
  readonly askUnplug: () => void
  readonly cancelUnplug?: () => void
  readonly confirmUnplug: () => void
}) {
  const { card } = props
  const blocked = card.dependency.severity === 'unresolved'
    || (card.dependency.severity === 'hard' && card.unplug?.kind === 'plugin')
  return (
    <article className="capability-card" data-capability-id={card.id} data-capability-status={card.status} data-dependency={card.dependency.severity}>
      <header>
        <span className="capability-card-lamp" aria-hidden="true" />
        <div><h2>{card.title}</h2><small>{`INSTALLED${card.version ? ` · ${card.version}` : ''}`}</small></div>
        <span className="capability-status-badge">{statusLabel(card.status)}</span>
      </header>
      <p>{card.purpose}</p>
      <div className="capability-kind-list" aria-label="Implementation forms">
        {card.implementation.map((kind) => <span key={kind}>{kind.toUpperCase()}</span>)}
      </div>
      <div className="capability-card-actions">
        <button type="button" className="button button--secondary" aria-expanded={props.open} onClick={props.toggle}>{props.open ? 'HIDE DETAILS' : 'VIEW DETAILS'}</button>
        {card.unplug ? (
          <button type="button" className={blocked ? 'button button--fault' : 'button button--secondary'} disabled={props.locked || blocked} title={blocked ? unplugImpact(card) : 'Reversibly disable this capability'} onClick={props.askUnplug}>UNPLUG</button>
        ) : null}
      </div>
      {props.open ? (
        <div className="capability-card-details">
          <Contract label="CAPABILITIES" values={card.capabilities} empty="No separate capability claims" />
          <Contract label="TOOLS" values={card.tools} empty="No callable tools" />
          <Contract label="WORKFLOWS" values={card.workflows} empty="No registered workflows" />
          <Contract label="PROVIDER" values={card.provider ? [card.provider] : []} empty="Local or host runtime" />
          <Contract label="SOURCE" values={[`${card.owner ?? 'user-added'}${card.version ? `@${card.version}` : ''}`]} empty="Unknown" />
          <Contract label="UNPLUG IMPACT" values={card.dependency.dependents} empty={unplugImpact(card)} />
          {props.manage ? <button type="button" className="capability-open-implementation" onClick={props.manage}>OPEN TECHNICAL IMPLEMENTATION →</button> : null}
        </div>
      ) : null}
      {props.confirming && card.unplug ? (
        <div className="capability-unplug-dialog" role="dialog" aria-labelledby={`unplug-${card.id}`}>
          <h3 id={`unplug-${card.id}`}>UNPLUG {card.title}?</h3>
          <p>{unplugImpact(card)} No new calls will enter; the isolated runtime will unload and the version and audit history will remain available for reactivation.</p>
          <div className="approval-actions">
            <button type="button" className="button button--secondary" onClick={props.cancelUnplug}>CANCEL</button>
            <button type="button" className="button button--approval" disabled={props.locked || blocked} onClick={props.confirmUnplug}>CONFIRM UNPLUG</button>
          </div>
        </div>
      ) : null}
    </article>
  )
}

function Contract(props: { readonly label: string; readonly values: readonly string[]; readonly empty: string }) {
  return <div><strong>{props.label}</strong><span>{props.values.length > 0 ? props.values.join(' · ') : props.empty}</span></div>
}

function Summary(props: { readonly label: string; readonly value: number }) {
  return <div><span>{props.label}</span><strong>{props.value}</strong></div>
}

function statusLabel(status: CapabilityPortfolioCard['status']): string {
  return status.replaceAll('-', ' ').toUpperCase()
}

function unplugImpact(card: CapabilityPortfolioCard): string {
  if (card.dependency.severity === 'hard') return 'Blocked: active capabilities have hard dependencies on this capability.'
  if (card.dependency.severity === 'optional') return 'Optional dependents will continue in a degraded state.'
  if (card.dependency.severity === 'unresolved') return 'Blocked: the dependency graph could not be verified.'
  return 'No active dependents were found.'
}

function implementationPane(card: CapabilityPortfolioCard): WorkspacePane | undefined {
  if (card.implementation.includes('skill') || card.implementation.includes('extension')) return 'extensions'
  if (card.implementation.includes('workflow')) return 'workflows'
  if (card.implementation.includes('tool')) return 'tools'
  return undefined
}
