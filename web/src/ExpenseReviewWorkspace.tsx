import React from 'react'
import type { ExpenseReviewDecision } from '../../src/domain/expense-review/types'
import type { ExpenseReviewControl } from './useExpenseReview'

const DECISION_LABELS: Record<ExpenseReviewDecision, string> = {
  clear: 'CLEAR',
  review: 'REVIEW REQUIRED',
  'missing-evidence': 'MISSING EVIDENCE',
}

export function ExpenseReviewWorkspace(props: {
  readonly control: ExpenseReviewControl
  readonly locked: boolean
  readonly openSpecifications: () => void
}) {
  const { control } = props
  const unavailable = control.availability && control.availability.status !== 'ready'
  return (
    <main className="conversation-panel instrument-panel expense-workspace" aria-label="Expense risk review">
      <header className="workspace-title expense-title">
        <div>
          <span className="eyebrow">FINANCE / GOVERNED DECISION SUPPORT</span>
          <h1>EXPENSE RISK REVIEW</h1>
          <p>Evaluate one claim through the exact approved capability. Recommendations never approve or post expenses.</p>
        </div>
        <button type="button" className="button button--secondary" disabled={control.loading} onClick={control.load}>REFRESH</button>
      </header>

      <section className="expense-capability" data-expense-capability={control.availability?.status ?? 'loading'}>
        <span className="control-lamp" aria-hidden="true" />
        <div>
          <strong>{control.availability?.status === 'ready' ? 'CAPABILITY READY' : control.loading ? 'CHECKING CAPABILITY' : 'CAPABILITY NOT READY'}</strong>
          <p>{control.availability?.reason ?? 'Inspecting finance.expense-risk.review…'}</p>
          {control.availability?.owner ? <small>{control.availability.owner}@{control.availability.version}{control.availability.tool ? ` · ${control.availability.tool}` : ''}</small> : null}
        </div>
        {unavailable ? <button type="button" className="button button--secondary" onClick={props.openSpecifications}>OPEN SPECIFICATIONS</button> : null}
      </section>

      {control.error ? <p className="settings-alert" role="alert">{control.error}</p> : null}

      <div className="expense-console">
        <form className="expense-form" onSubmit={(event) => { event.preventDefault(); control.submit() }}>
          <div className="expense-section-heading"><span>CLAIM INPUT</span><small>STRUCTURED / LOCAL</small></div>
          <div className="expense-field-grid">
            <ExpenseField label="Claim ID" required>
              <input value={control.draft.claimId} onChange={(event) => control.change('claimId', event.target.value)} placeholder="ER-2026-001" />
            </ExpenseField>
            <ExpenseField label="Company entity" required>
              <input value={control.draft.entity} onChange={(event) => control.change('entity', event.target.value)} placeholder="Shanghai Entity" />
            </ExpenseField>
            <ExpenseField label="Employee" required>
              <input value={control.draft.employee} onChange={(event) => control.change('employee', event.target.value)} placeholder="Employee name or ID" />
            </ExpenseField>
            <ExpenseField label="Category" required>
              <select value={control.draft.category} onChange={(event) => control.change('category', event.target.value)}>
                <option>Travel</option><option>Meals</option><option>Accommodation</option><option>Office</option><option>Other</option>
              </select>
            </ExpenseField>
            <ExpenseField label="Amount" required>
              <div className="expense-amount"><input type="number" min="0.01" step="0.01" value={control.draft.amount || ''} onChange={(event) => control.change('amount', Number(event.target.value))} /><input aria-label="Currency" maxLength={3} value={control.draft.currency} onChange={(event) => control.change('currency', event.target.value.toUpperCase())} /></div>
            </ExpenseField>
            <ExpenseField label="Receipt">
              <span className="expense-toggle"><input type="checkbox" checked={control.draft.receiptAttached} onChange={(event) => control.change('receiptAttached', event.target.checked)} /><span>{control.draft.receiptAttached ? 'ATTACHED' : 'NOT ATTACHED'}</span></span>
            </ExpenseField>
          </div>
          <ExpenseField label="Business purpose">
            <textarea rows={3} value={control.draft.purpose ?? ''} onChange={(event) => control.change('purpose', event.target.value)} placeholder="Why was this expense necessary?" />
          </ExpenseField>
          <button type="submit" className="button button--approval expense-submit" disabled={props.locked || control.running || control.availability?.status !== 'ready'}>
            {control.running ? 'EVALUATING…' : 'RUN GOVERNED REVIEW'}
          </button>
        </form>

        <section className="expense-result" aria-live="polite">
          <div className="expense-section-heading"><span>REVIEW EVIDENCE</span><small>HOST RENDERED</small></div>
          {control.result ? <ExpenseFinding result={control.result} /> : (
            <div className="expense-empty">
              <strong>NO REVIEW YET</strong>
              <p>Submit a claim to see the decision, triggered rules, missing evidence, and recommended next action.</p>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}

function ExpenseField(props: { readonly label: string; readonly required?: boolean; readonly children: React.ReactNode }) {
  return <label className="expense-field"><span>{props.label}{props.required ? ' *' : ''}</span>{props.children}</label>
}

function ExpenseFinding(props: { readonly result: NonNullable<ExpenseReviewControl['result']> }) {
  const { finding } = props.result
  return (
    <div className="expense-finding" data-expense-decision={finding.decision}>
      <div className="expense-decision"><span className="control-lamp" aria-hidden="true" /><strong>{DECISION_LABELS[finding.decision]}</strong></div>
      <h2>{finding.summary}</h2>
      <EvidenceList title="TRIGGERED RULES" values={finding.triggeredRules} empty="No risk rule was triggered." />
      <EvidenceList title="MISSING EVIDENCE" values={finding.missingEvidence} empty="No evidence is missing." />
      <div className="expense-recommendation"><span>RECOMMENDED NEXT ACTION</span><p>{finding.recommendation}</p></div>
      <footer>
        <span>{props.result.capability.owner}@{props.result.capability.version}</span>
        <time dateTime={props.result.reviewedAt}>{new Date(props.result.reviewedAt).toLocaleString()}</time>
      </footer>
    </div>
  )
}

function EvidenceList(props: { readonly title: string; readonly values: readonly string[]; readonly empty: string }) {
  return <div className="expense-evidence"><span>{props.title}</span><ul>{(props.values.length ? props.values : [props.empty]).map((value) => <li key={value}>{value}</li>)}</ul></div>
}
