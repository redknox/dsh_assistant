import type {
  CandidateWorkbench,
  CapabilitySpecificationInput,
  CapabilitySpecificationPatch,
} from '../domain/workbench/index.js'

export interface WebUiWorkbenchRequest {
  readonly method?: string
  readonly pathname: string
  readonly query: (name: string) => string | undefined
  readonly readJson: () => Promise<unknown>
}

export interface WebUiWorkbenchContext {
  readonly workbench: Pick<CandidateWorkbench,
    'list' | 'inspectSpecification' | 'inspectSpecificationEvaluation' | 'defineSpecification' | 'reviseSpecification' | 'compareSpecifications'>
  readonly mutable: boolean
}

export async function handleWebUiWorkbenchRequest(
  request: WebUiWorkbenchRequest,
  context: WebUiWorkbenchContext,
): Promise<{ readonly status: number; readonly body: unknown; readonly broadcast?: boolean } | undefined> {
  if (!request.pathname.startsWith('/api/workbench')) return undefined
  if (request.method === 'GET' && request.pathname === '/api/workbench') {
    return { status: 200, body: { ...context.workbench.list({ limit: 50 }), mutable: context.mutable } }
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
  if (request.pathname === '/api/workbench/specification/define') {
    if (!isSpecificationInput(body)) return { status: 400, body: { error: 'malformed-capability-specification' } }
    return { status: 200, body: context.workbench.defineSpecification(body), broadcast: true }
  }
  if (request.pathname === '/api/workbench/specification/revise') {
    if (!isRevisionInput(body)) return { status: 400, body: { error: 'malformed-capability-specification-revision' } }
    return {
      status: 200,
      body: context.workbench.reviseSpecification(body.specificationId, body.patch),
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
