import { DisableDeniedError, GovernanceContractError, RollbackDeniedError, UninstallDeniedError } from '../domain/governance/errors.js'
import { SimulatedCrashError } from '../domain/governance/service.js'
import type { ActivationStatus } from '../domain/governance/types.js'
import { boundActivationDiagnostics } from '../domain/workspace/failure.js'
import { redactText } from '../domain/workspace/redact.js'
import type { MissionControlView, RollbackCard, UserPluginView } from '../domain/workspace/types.js'
import {
  DESTRUCTIVE_RECOVERY_ACTIONS,
  SUPPORTED_RECOVERY_ACTIONS,
} from './web-ui-protocol.js'
import type { WebUiGovernanceMutations } from './web-ui-governance-mutations.js'

interface GovernanceLifecycleAuthority {
  inspect(): ActivationStatus
  disable(owner: string, version: string, acknowledgeDependents: boolean): Promise<ActivationStatus>
  uninstall(owner: string, version: string, acknowledgeDependents: boolean): Promise<ActivationStatus>
  rollback(): Promise<ActivationStatus>
  exitSafeMode(): ActivationStatus
}

export interface WebUiGovernanceLifecycleRequest {
  readonly method?: string
  readonly pathname: string
  readonly readJson: () => Promise<unknown>
}

export interface WebUiGovernanceLifecycleContext {
  readonly authority: GovernanceLifecycleAuthority
  readonly mutations: WebUiGovernanceMutations
  readonly diagnostics?: unknown
  readonly project: () => { readonly view: MissionControlView; readonly webUi: string }
}

export interface WebUiGovernanceLifecycleResponse {
  readonly status: number
  readonly body: unknown
  readonly broadcast?: boolean
}

export async function handleWebUiGovernanceLifecycleRequest(
  request: WebUiGovernanceLifecycleRequest,
  context: WebUiGovernanceLifecycleContext,
): Promise<WebUiGovernanceLifecycleResponse | undefined> {
  if (request.method !== 'POST'
    || !['/api/disable', '/api/uninstall', '/api/rollback', '/api/recovery'].includes(request.pathname)) {
    return undefined
  }

  const raw = await request.readJson()
  if (raw === null || typeof raw !== 'object') return { status: 400, body: { error: 'malformed' } }
  const body = raw as Record<string, unknown>

  if (request.pathname === '/api/recovery') return handleRecovery(body, context)
  if (body.confirm !== true) return { status: 409, body: { error: 'confirmation-required' } }
  const busy = context.mutations.inFlight()
  if (busy !== undefined) return { status: 409, body: { error: `${busy}-in-flight`, ...context.project() } }

  if (request.pathname === '/api/disable') return disable(body, context)
  if (request.pathname === '/api/uninstall') return uninstall(body, context)
  return rollback(body, context)
}

async function disable(
  body: Record<string, unknown>,
  context: WebUiGovernanceLifecycleContext,
): Promise<WebUiGovernanceLifecycleResponse> {
  const bound = bindUninstall(body, context.project().view.plugins)
  if ('error' in bound) {
    return { status: bound.error === 'malformed' ? 400 : 409, body: { error: bound.error } }
  }
  try {
    await context.mutations.run('disable', () => context.authority.disable(
      bound.card.owner,
      bound.card.version,
      body.acknowledgeDependents === true,
    ))
    return { status: 200, body: context.project(), broadcast: true }
  } catch (error) {
    if (error instanceof DisableDeniedError) {
      return {
        status: 409,
        body: { error: 'disable-denied', denials: error.denials, ...context.project() },
        broadcast: true,
      }
    }
    const message = error instanceof Error ? error.message : 'disable failed'
    return {
      status: 409,
      body: { error: 'disable-failed', diagnostics: boundActivationDiagnostics(message), ...context.project() },
      broadcast: true,
    }
  }
}

async function uninstall(
  body: Record<string, unknown>,
  context: WebUiGovernanceLifecycleContext,
): Promise<WebUiGovernanceLifecycleResponse> {
  const bound = bindUninstall(body, context.project().view.plugins)
  if ('error' in bound) {
    return { status: bound.error === 'malformed' ? 400 : 409, body: { error: bound.error } }
  }
  try {
    await context.mutations.run('uninstall', () => context.authority.uninstall(
      bound.card.owner,
      bound.card.version,
      body.acknowledgeDependents === true,
    ))
    return { status: 200, body: context.project(), broadcast: true }
  } catch (error) {
    if (error instanceof UninstallDeniedError) {
      return {
        status: 409,
        body: { error: 'uninstall-denied', denials: error.denials, ...context.project() },
        broadcast: true,
      }
    }
    const message = error instanceof Error ? error.message : 'uninstall failed'
    return {
      status: 409,
      body: { error: 'uninstall-failed', diagnostics: boundActivationDiagnostics(message), ...context.project() },
      broadcast: true,
    }
  }
}

async function rollback(
  body: Record<string, unknown>,
  context: WebUiGovernanceLifecycleContext,
): Promise<WebUiGovernanceLifecycleResponse> {
  const bound = bindRollback(body, context.project().view.rollback)
  if ('error' in bound) {
    return { status: bound.error === 'malformed' ? 400 : 409, body: { error: bound.error } }
  }
  try {
    const status = await context.mutations.run('recovery', () => context.authority.rollback())
    if (status.state === 'activation-failed' || status.safeMode) {
      return {
        status: 409,
        body: {
          error: 'rollback-failed',
          diagnostics: status.lastFailure?.diagnostics
            ? boundActivationDiagnostics(status.lastFailure.diagnostics)
            : 'rollback failed',
          recoveryRequired: status.recoveryRequired,
          safeMode: status.safeMode,
          ...context.project(),
        },
        broadcast: true,
      }
    }
    return { status: 200, body: context.project(), broadcast: true }
  } catch (error) {
    if (error instanceof RollbackDeniedError) {
      return {
        status: 409,
        body: { error: 'rollback-denied', denials: error.denials, ...context.project() },
        broadcast: true,
      }
    }
    if (error instanceof SimulatedCrashError) {
      return {
        status: 409,
        body: {
          error: 'rollback-interrupted',
          diagnostics: boundActivationDiagnostics(error.message),
          ...context.project(),
        },
        broadcast: true,
      }
    }
    const message = error instanceof Error ? error.message : 'rollback failed'
    return {
      status: 409,
      body: { error: 'rollback-failed', diagnostics: boundActivationDiagnostics(message), ...context.project() },
      broadcast: true,
    }
  }
}

async function handleRecovery(
  body: Record<string, unknown>,
  context: WebUiGovernanceLifecycleContext,
): Promise<WebUiGovernanceLifecycleResponse> {
  if (typeof body.action !== 'string') return { status: 400, body: { error: 'malformed' } }
  const action = body.action
  if (!(SUPPORTED_RECOVERY_ACTIONS as readonly string[]).includes(action)) {
    return projected(409, { error: 'unsupported', action }, context)
  }
  if ((DESTRUCTIVE_RECOVERY_ACTIONS as readonly string[]).includes(action) && body.confirm !== true) {
    return projected(409, { error: 'confirmation-required', action }, context)
  }
  if (action === 'diagnostics') return diagnostics(context)

  const busy = context.mutations.inFlight()
  if (busy !== undefined) return projected(409, { error: `${busy}-in-flight`, action }, context)
  if (action === 'rollback') return recoveryRollback(context)
  return exitSafeMode(context)
}

function diagnostics(context: WebUiGovernanceLifecycleContext): WebUiGovernanceLifecycleResponse {
  const inspected = context.authority.inspect()
  const boot = context.diagnostics && typeof context.diagnostics === 'object'
    ? context.diagnostics as { persistence?: unknown; reasons?: unknown }
    : {}
  const parts: string[] = []
  if (typeof boot.persistence === 'string') parts.push(`persistence ${boot.persistence}`)
  if (Array.isArray(boot.reasons)) {
    for (const reason of boot.reasons.slice(0, 4)) {
      if (typeof reason === 'string' && reason.trim() !== '') parts.push(reason.trim().slice(0, 200))
    }
  }
  const projectedView = context.project()
  if (projectedView.view.runtimeContext?.profileCompositionError) {
    parts.push(`profile-composition ${projectedView.view.runtimeContext.profileCompositionError.slice(0, 200)}`)
  }
  parts.push(inspected.safeMode ? 'safe-mode true' : 'safe-mode false')
  return {
    status: 200,
    body: {
      action: 'diagnostics',
      diagnostics: context.diagnostics ?? { activation: inspected },
      acknowledgement: { text: redactText(parts.join(' · ') || 'Diagnostics available.') },
      ...projectedView,
    },
    broadcast: true,
  }
}

async function recoveryRollback(
  context: WebUiGovernanceLifecycleContext,
): Promise<WebUiGovernanceLifecycleResponse> {
  const inspected = context.authority.inspect()
  if (!inspected.safeMode && !inspected.recoveryRequired) {
    return projected(409, { error: 'ready-state-rollback', action: 'rollback' }, context)
  }
  try {
    const result = await context.mutations.run('recovery', () => context.authority.rollback())
    return projected(200, { action: 'rollback', result }, context, true)
  } catch (error) {
    if (error instanceof RollbackDeniedError) {
      return projected(409, { error: 'rollback-denied', denials: error.denials, action: 'rollback' }, context, true)
    }
    if (error instanceof GovernanceContractError && /in-flight$/.test(error.message)) {
      return projected(409, { error: error.message, action: 'rollback' }, context, true)
    }
    throw error
  }
}

async function exitSafeMode(
  context: WebUiGovernanceLifecycleContext,
): Promise<WebUiGovernanceLifecycleResponse> {
  const status = context.authority.inspect()
  const live = context.project()
  if (live.view.runtimeContext?.profileCompositionError !== undefined || (
    live.view.runtimeContext?.safeMode === true && !status.safeMode && !status.recoveryRequired
  )) {
    return {
      status: 409,
      body: {
        error: 'profile-composition-recovery',
        action: 'exit-safe-mode',
        detail: 'Exit Safe Mode cannot repair a broken Profile. Restore profiles/assistant and restart TARS-NG.',
        ...live,
      },
      broadcast: true,
    }
  }
  if (status.recoveryRequired) {
    return projected(409, {
      error: 'integrity-failure',
      action: 'exit-safe-mode',
      detail: 'Exit Safe Mode is refused while recovery is still required. Restore the selected Profile and restart; this button does not repair a broken Profile.',
    }, context, true)
  }
  try {
    const result = await context.mutations.run('recovery', () => context.authority.exitSafeMode())
    return projected(200, { action: 'exit-safe-mode', result }, context, true)
  } catch (error) {
    if (error instanceof GovernanceContractError && /in-flight$/.test(error.message)) {
      return projected(409, { error: error.message, action: 'exit-safe-mode' }, context, true)
    }
    throw error
  }
}

function projected(
  status: number,
  body: Record<string, unknown>,
  context: WebUiGovernanceLifecycleContext,
  broadcast = true,
): WebUiGovernanceLifecycleResponse {
  return { status, body: { ...body, ...context.project() }, broadcast }
}

function bindUninstall(
  body: Record<string, unknown>,
  cards: readonly UserPluginView[],
): { readonly card: UserPluginView } | { readonly error: string } {
  if (typeof body.id !== 'string' || body.id === '') return { error: 'malformed' }
  if (typeof body.owner !== 'string' || body.owner === '') return { error: 'malformed' }
  if (typeof body.version !== 'string' || body.version === '') return { error: 'malformed' }
  if (typeof body.registryGeneration !== 'number' || !Number.isInteger(body.registryGeneration)) {
    return { error: 'malformed' }
  }
  const card = cards.find((item) => item.id === body.id)
  if (!card) return { error: 'unknown-plugin' }
  if (card.owner !== body.owner || card.version !== body.version) return { error: 'stale-plugin' }
  if (card.registryGeneration !== body.registryGeneration) return { error: 'stale-registry' }
  if (card.candidateId !== undefined
    && (typeof body.candidateId !== 'string' || body.candidateId !== card.candidateId)) {
    return { error: 'stale-candidate' }
  }
  if (card.digest !== undefined && (typeof body.digest !== 'string' || body.digest !== card.digest)) {
    return { error: 'stale-digest' }
  }
  return { card }
}

function bindRollback(
  body: Record<string, unknown>,
  card: RollbackCard | undefined,
): { readonly card: RollbackCard } | { readonly error: string } {
  if (typeof body.id !== 'string' || body.id === '') return { error: 'malformed' }
  if (typeof body.fingerprint !== 'string' || body.fingerprint === '') return { error: 'malformed' }
  if (typeof body.currentGeneration !== 'number' || !Number.isInteger(body.currentGeneration)) {
    return { error: 'malformed' }
  }
  if (typeof body.targetGeneration !== 'number' || !Number.isInteger(body.targetGeneration)) {
    return { error: 'malformed' }
  }
  if (card === undefined) return { error: 'unknown-rollback' }
  if (card.id !== body.id) return { error: 'stale-rollback' }
  if (card.fingerprint !== body.fingerprint) return { error: 'stale-fingerprint' }
  if (card.currentGeneration !== body.currentGeneration) return { error: 'stale-current' }
  if (card.targetGeneration !== body.targetGeneration) return { error: 'stale-target' }
  return { card }
}
