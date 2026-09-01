import { ActivationDeniedError } from '../domain/governance/errors.js'
import { SimulatedCrashError } from '../domain/governance/service.js'
import type { ActivationStatus } from '../domain/governance/types.js'
import { boundActivationDiagnostics } from '../domain/workspace/failure.js'
import type { ActivationCard, MissionControlView, WebUiAcknowledgement } from '../domain/workspace/types.js'
import type { WebUiGovernanceMutations } from './web-ui-governance-mutations.js'

interface ActivationAuthority {
  activate(candidateId: string): Promise<ActivationStatus>
  abandon(candidateId: string, fingerprint: string): void
}

export interface WebUiActivationRequest {
  readonly method?: string
  readonly pathname: string
  readonly readJson: () => Promise<unknown>
}

export interface WebUiActivationContext {
  readonly authority: ActivationAuthority
  readonly mutations: WebUiGovernanceMutations
  readonly activations: () => readonly ActivationCard[]
  readonly project: (acknowledgement?: WebUiAcknowledgement) => {
    readonly view: MissionControlView
    readonly webUi: string
    readonly acknowledgement?: WebUiAcknowledgement
  }
}

export interface WebUiActivationResponse {
  readonly status: number
  readonly body: unknown
  readonly broadcast?: boolean
}

export async function handleWebUiActivationRequest(
  request: WebUiActivationRequest,
  context: WebUiActivationContext,
): Promise<WebUiActivationResponse | undefined> {
  if (request.method !== 'POST'
    || (request.pathname !== '/api/activate' && request.pathname !== '/api/activation/abandon')) {
    return undefined
  }

  const raw = await request.readJson()
  if (raw === null || typeof raw !== 'object') return { status: 400, body: { error: 'malformed' } }
  const body = raw as Record<string, unknown>
  if (body.confirm !== true) return { status: 409, body: { error: 'confirmation-required' } }
  const busy = context.mutations.inFlight()
  if (busy !== undefined) return { status: 409, body: { error: `${busy}-in-flight`, ...context.project() } }

  const bound = bindActivation(body, context.activations())
  if ('error' in bound) {
    return { status: bound.error === 'malformed' ? 400 : 409, body: { error: bound.error } }
  }
  if (request.pathname === '/api/activation/abandon') return abandon(bound.card, context)
  return activate(bound.card, context)
}

async function activate(card: ActivationCard, context: WebUiActivationContext): Promise<WebUiActivationResponse> {
  try {
    const status = await context.mutations.run('activation', () => context.authority.activate(card.candidateId))
    if (status.state === 'activation-failed' || status.state === 'safe-mode') {
      const failure = status.lastFailure
      return {
        status: 409,
        body: {
          error: 'activation-failed',
          phase: failure?.phase,
          diagnostics: failure?.diagnostics ? boundActivationDiagnostics(failure.diagnostics) : 'activation failed',
          rollbackSucceeded: failure?.rollbackSucceeded === true,
          recoveryRequired: status.recoveryRequired,
          safeMode: status.safeMode,
          active: false,
          ...context.project(),
        },
        broadcast: true,
      }
    }
    return { status: 200, body: context.project(activationAcknowledgement(card)), broadcast: true }
  } catch (error) {
    if (error instanceof ActivationDeniedError) {
      return { status: 409, body: { error: 'activation-denied', denials: error.denials, ...context.project() }, broadcast: true }
    }
    if (error instanceof SimulatedCrashError) {
      return {
        status: 409,
        body: {
          error: 'activation-interrupted',
          phase: error.message.replace('simulated crash after ', ''),
          diagnostics: boundActivationDiagnostics(error.message),
          ...context.project(),
        },
        broadcast: true,
      }
    }
    const message = error instanceof Error ? error.message : 'activation failed'
    return {
      status: 409,
      body: { error: 'activation-error', diagnostics: boundActivationDiagnostics(message), ...context.project() },
      broadcast: true,
    }
  }
}

function activationAcknowledgement(card: ActivationCard): WebUiAcknowledgement {
  const name = friendlyOwner(card.owner)
  return {
    text: `${name}@${card.version} is live. ${publishedSurfaceSummary(card)}`,
    action: {
      kind: 'open-capability',
      label: 'VIEW CAPABILITY',
      capabilityId: `extension:${card.owner}@${card.version}`,
    },
  }
}

function friendlyOwner(owner: string): string {
  const name = owner.split('/').at(-1) ?? owner
  return name.split('-').map((part) => part ? `${part[0]?.toUpperCase()}${part.slice(1)}` : '').join(' ')
}

function publishedSurfaceSummary(card: ActivationCard): string {
  const surfaces = [
    ...card.toolsAdded,
    ...card.toolsChanged,
    ...(card.workflowsAdded ?? []),
    ...(card.workflowsChanged ?? []),
  ]
  if (surfaces.length === 0) return 'The capability is ready to use.'
  return `${surfaces.join(', ')} ${surfaces.length === 1 ? 'is' : 'are'} ready to use.`
}

function abandon(card: ActivationCard, context: WebUiActivationContext): WebUiActivationResponse {
  if (card.status !== 'ACTIVATION_FAILED') return { status: 409, body: { error: 'stale-activation' } }
  try {
    context.authority.abandon(card.candidateId, card.fingerprint)
    return { status: 200, body: context.project(), broadcast: true }
  } catch (error) {
    return {
      status: 409,
      body: {
        error: 'abandon-activation-denied',
        diagnostics: boundActivationDiagnostics(error instanceof Error ? error.message : 'abandon failed'),
        ...context.project(),
      },
      broadcast: true,
    }
  }
}

function bindActivation(
  body: Record<string, unknown>,
  cards: readonly ActivationCard[],
): { readonly card: ActivationCard } | { readonly error: string } {
  if (typeof body.id !== 'string' || body.id === '') return { error: 'malformed' }
  if (typeof body.candidateId !== 'string' || body.candidateId === '') return { error: 'malformed' }
  if (typeof body.digest !== 'string' || body.digest === '') return { error: 'malformed' }
  if (typeof body.fingerprint !== 'string' || body.fingerprint === '') return { error: 'malformed' }
  const card = cards.find((item) => item.id === body.id)
  if (!card) return { error: 'unknown-activation' }
  if (card.kind !== 'self-extension-activate') return { error: 'unknown-activation' }
  if (card.candidateId !== body.candidateId) return { error: 'stale-candidate' }
  if (card.digest !== body.digest) return { error: 'stale-digest' }
  if (card.fingerprint !== body.fingerprint) return { error: 'stale-fingerprint' }
  if (card.status !== 'APPROVED_NOT_ACTIVE' && card.status !== 'DISABLED_REACTIVATABLE' && card.status !== 'ACTIVATION_FAILED') {
    return { error: 'stale-activation' }
  }
  if (card.status === 'ACTIVATION_FAILED' && card.eligibilityOk !== true) return { error: 'stale-activation' }
  return { card }
}
