import type {
  CandidateWorkbench,
  CapabilitySpecificationInput,
  CapabilitySpecificationPatch,
} from '../domain/workbench/index.js'
import type { WorkbenchListView } from '../domain/workbench/listing.js'
import type { WorkbenchSnapshotView } from './web-ui-workbench-types.js'

export function projectWebUiWorkbench(list: WorkbenchListView, mutable: boolean): WorkbenchSnapshotView {
  return {
    proposals: (list.proposals ?? []).map((proposal) => ({
      id: proposal.id,
      originSessionId: proposal.originSessionId,
      status: proposal.status,
      createdAt: proposal.createdAt,
      ...(proposal.deliverySessionId ? { deliverySessionId: proposal.deliverySessionId } : {}),
      review: {
        kind: proposal.review.kind,
        capability: proposal.review.capability,
        need: proposal.review.need,
        recommendation: proposal.review.recommendation,
        rationale: proposal.review.rationale,
        implications: proposal.review.implications,
        unresolved: proposal.review.unresolved,
      },
    })),
    specifications: list.specifications,
    plans: list.plans,
    candidates: list.candidates,
    ...(list.nextCursor ? { nextCursor: list.nextCursor } : {}),
    mutable,
  }
}

export interface WebUiWorkbenchRequest {
  readonly method?: string
  readonly pathname: string
  readonly query: (name: string) => string | undefined
  readonly readJson: () => Promise<unknown>
}

export interface WebUiWorkbenchContext {
  readonly workbench: Pick<CandidateWorkbench,
    'list' | 'inspectSpecification' | 'inspectSpecificationEvaluation' | 'defineSpecification' | 'reviseSpecification' | 'compareSpecifications' | 'stopSpecification'>
  readonly mutable: boolean
  readonly currentSessionId: () => string
  readonly project?: () => unknown
  readonly startProposal?: (proposalId: string, expected: { readonly sessionId: string; readonly revision: number }) => Promise<void>
  readonly declineProposal?: (proposalId: string) => void
}

export async function handleWebUiWorkbenchRequest(
  request: WebUiWorkbenchRequest,
  context: WebUiWorkbenchContext,
): Promise<{ readonly status: number; readonly body: unknown; readonly broadcast?: boolean } | undefined> {
  if (!request.pathname.startsWith('/api/workbench')) return undefined
  if (request.method === 'GET' && request.pathname === '/api/workbench') {
    return { status: 200, body: projectWebUiWorkbench(context.workbench.list({ limit: 50 }), context.mutable) }
  }
  if (request.method === 'GET' && request.pathname === '/api/workbench/specification') {
    const id = request.query('id')
    if (!id) return { status: 400, body: { error: 'missing-specification-id' } }
    return { status: 200, body: context.workbench.inspectSpecification(id) }
  }
  if (request.method === 'GET' && request.pathname === '/api/workbench/compare') {
    const from = request.query('from')
    const to = request.query('to')
    if (!from || !to) return { status: 400, body: { error: 'missing-comparison-id' } }
    return { status: 200, body: context.workbench.compareSpecifications(from, to) }
  }
  if (request.method === 'GET' && request.pathname === '/api/workbench/evaluation') {
    const id = request.query('id')
    if (!id) return { status: 400, body: { error: 'missing-specification-id' } }
    return { status: 200, body: context.workbench.inspectSpecificationEvaluation(id) }
  }
  if (request.method !== 'POST') return { status: 405, body: { error: 'method-not-allowed' } }
  if (!context.mutable) return { status: 409, body: { error: 'workbench-read-only' } }
  const body = await request.readJson()
  if (request.pathname === '/api/workbench/proposal/decide') {
    if (!isRecord(body)
      || typeof body.proposalId !== 'string'
      || !['declined', 'started'].includes(String(body.decision))
      || typeof body.sessionId !== 'string'
      || typeof body.revision !== 'number') {
      return { status: 400, body: { error: 'malformed-capability-proposal-decision' } }
    }
    if (body.decision === 'started') {
      if (!context.startProposal) return { status: 409, body: { error: 'session-host-unavailable' } }
      await context.startProposal(body.proposalId, { sessionId: body.sessionId, revision: body.revision })
    } else {
      if (!context.declineProposal) return { status: 409, body: { error: 'capability-proposal-control-unavailable' } }
      context.declineProposal(body.proposalId)
    }
    return { status: 200, body: context.project?.() ?? { ok: true }, broadcast: true }
  }
  if (request.pathname === '/api/workbench/specification/define') {
    if (!isSpecificationInput(body)) return { status: 400, body: { error: 'malformed-capability-specification' } }
    return {
      status: 200,
      body: context.workbench.defineSpecification({ ...body, origin: { sessionId: context.currentSessionId() } }),
      broadcast: true,
    }
  }
  if (request.pathname === '/api/workbench/specification/revise') {
    if (!isRevisionInput(body)) return { status: 400, body: { error: 'malformed-capability-specification-revision' } }
    return {
      status: 200,
      body: context.workbench.reviseSpecification(body.specificationId, body.patch),
      broadcast: true,
    }
  }
  if (request.pathname === '/api/workbench/specification/stop') {
    if (!isRecord(body) || typeof body.specificationId !== 'string') {
      return { status: 400, body: { error: 'malformed-capability-delivery-stop' } }
    }
    return {
      status: 200,
      body: context.workbench.stopSpecification(body.specificationId, { sessionId: context.currentSessionId() }),
      broadcast: true,
    }
  }
  return { status: 404, body: { error: 'not-found' } }
}

function isSpecificationInput(value: unknown): value is CapabilitySpecificationInput {
  return isRecord(value) && typeof value.capability === 'string' && typeof value.goal === 'string'
}

function isRevisionInput(value: unknown): value is { readonly specificationId: string; readonly patch: CapabilitySpecificationPatch } {
  return isRecord(value)
    && typeof value.specificationId === 'string'
    && isRecord(value.patch)
    && value.patch.capability === undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
