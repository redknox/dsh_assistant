import { SkillContractError } from '../domain/skill/errors.js'
import { redactText } from '../domain/workspace/redact.js'
import type { MissionControlView, SkillProjection } from '../domain/workspace/types.js'

export type WebUiSkillCommand =
  | { readonly action: 'approve' | 'reject'; readonly id: string; readonly fingerprint: string }
  | { readonly action: 'activate'; readonly id: string }
  | { readonly action: 'reactivate'; readonly name: string; readonly version: string }
  | { readonly action: 'disable'; readonly name: string; readonly dependents: readonly string[] }
  | { readonly action: 'uninstall'; readonly id: string; readonly dependents: readonly string[] }
  | { readonly action: 'rollback' }

interface SkillAuthority {
  execute(command: WebUiSkillCommand): void
}

export interface WebUiSkillRequest {
  readonly method?: string
  readonly pathname: string
  readonly readJson: () => Promise<unknown>
}

export interface WebUiSkillContext {
  readonly authority: SkillAuthority
  readonly project: (acknowledgement?: { readonly text: string }) => {
    readonly view: MissionControlView
    readonly webUi: string
    readonly acknowledgement?: { readonly text: string }
  }
}

export interface WebUiSkillResponse {
  readonly status: number
  readonly body: unknown
  readonly broadcast?: boolean
}

const ACTIONS = new Set(['approve', 'reject', 'activate', 'disable', 'reactivate', 'uninstall', 'rollback'])

export async function handleWebUiSkillRequest(
  request: WebUiSkillRequest,
  context: WebUiSkillContext,
): Promise<WebUiSkillResponse | undefined> {
  if (request.method !== 'POST' || request.pathname !== '/api/skill') return undefined

  const raw = await request.readJson()
  if (raw === null || typeof raw !== 'object') return { status: 400, body: { error: 'malformed' } }
  const body = raw as Record<string, unknown>
  if (body.confirm !== true) return { status: 409, body: { error: 'confirmation-required' } }

  const action = String(body.action ?? '')
  const projected = context.project()
  const withheld = withheldCatalogMutation(action, projected.view)
  if (withheld !== undefined) {
    return { status: 409, body: { error: withheld, view: projected.view, webUi: projected.webUi } }
  }

  const bound = bindSkillAction(body, projected.view)
  if ('error' in bound) {
    return { status: bound.error === 'malformed' ? 400 : 409, body: { error: bound.error } }
  }
  const command = commandFor(action, bound.skill, body)
  if ('response' in command) {
    return {
      status: command.response.status,
      body: { ...command.response.body, view: projected.view, webUi: projected.webUi },
    }
  }

  try {
    context.authority.execute(command.command)
    return {
      status: 200,
      body: context.project({ text: `Skill ${action} recorded.` }),
      broadcast: true,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'skill action failed'
    const code = error instanceof SkillContractError
      && (error.code === 'catalog-degraded' || error.code === 'catalog-sync-failed')
      ? error.code
      : 'skill-action-denied'
    return {
      status: 409,
      body: { error: code, detail: redactText(message), ...context.project() },
    }
  }
}

function commandFor(
  action: string,
  skill: SkillProjection,
  body: Record<string, unknown>,
): { readonly command: WebUiSkillCommand } | {
  readonly response: { readonly status: number; readonly body: Record<string, unknown> }
} {
  if (action === 'approve' || action === 'reject') {
    return { command: { action, id: skill.id, fingerprint: skill.approvalFingerprint ?? '' } }
  }
  if (action === 'activate') return { command: { action, id: skill.id } }
  if (action === 'reactivate') return { command: { action, name: skill.name, version: skill.version } }
  if (action === 'rollback') return { command: { action } }
  if (action === 'disable' || action === 'uninstall') {
    const dependents = skill.dependents
    if (dependents.length > 0 && body.acknowledgeDependents !== true) {
      return {
        response: {
          status: 409,
          body: {
            error: 'dependents-required',
            dependents,
            detail: `hard dependents must be acknowledged: ${dependents.join(', ')}`,
          },
        },
      }
    }
    const acknowledged = Array.isArray(body.dependents) ? body.dependents.map((item) => String(item)) : []
    if (body.acknowledgeDependents === true && !sameStringSet(dependents, acknowledged)) {
      return { response: { status: 409, body: { error: 'stale-dependents', dependents } } }
    }
    const accepted = body.acknowledgeDependents === true ? acknowledged : []
    return action === 'disable'
      ? { command: { action, name: skill.name, dependents: accepted } }
      : { command: { action, id: skill.id, dependents: accepted } }
  }
  return { response: { status: 400, body: { error: 'malformed', detail: 'unknown skill action' } } }
}

function bindSkillAction(
  body: Record<string, unknown>,
  view: MissionControlView,
): { readonly error: string } | { readonly skill: SkillProjection } {
  const action = String(body.action ?? '')
  if (!ACTIONS.has(action)) return { error: 'malformed' }
  if (typeof body.generation !== 'number' || !Number.isInteger(body.generation)) return { error: 'malformed' }
  if (action === 'rollback') {
    const target = view.skillRollback
    if (target === undefined) return { error: 'unknown-skill' }
    if (typeof body.name !== 'string' || body.name !== target.name) return { error: 'stale-skill' }
    if (typeof body.version !== 'string' || body.version !== target.version) return { error: 'stale-skill' }
    if (typeof body.digest !== 'string' || body.digest !== target.digest) return { error: 'stale-digest' }
    if (body.generation !== target.generation) return { error: 'stale-generation' }
    const skill = (view.skills ?? []).find((item) => item.name === target.name && item.version === target.version)
    return skill === undefined ? { error: 'unknown-skill' } : { skill }
  }
  if (typeof body.id !== 'string' || body.id === '') return { error: 'malformed' }
  const skill = (view.skills ?? []).find((item) => item.id === body.id)
  if (skill === undefined) return { error: 'unknown-skill' }
  if (typeof body.name !== 'string' || body.name !== skill.name) return { error: 'stale-skill' }
  if (typeof body.version !== 'string' || body.version !== skill.version) return { error: 'stale-skill' }
  if (typeof body.digest !== 'string' || body.digest !== skill.digest) return { error: 'stale-digest' }
  if (body.generation !== skill.generation) return { error: 'stale-generation' }
  if (action === 'approve' || action === 'reject') {
    if (skill.lifecycle !== 'approval-requested') return { error: 'stale-lifecycle' }
    if (typeof body.fingerprint !== 'string' || body.fingerprint !== skill.approvalFingerprint) {
      return { error: 'stale-fingerprint' }
    }
  }
  if (action === 'activate' && skill.lifecycle !== 'approved') return { error: 'stale-lifecycle' }
  if (action === 'disable' && skill.lifecycle !== 'active') return { error: 'stale-lifecycle' }
  if (action === 'reactivate' && skill.lifecycle !== 'disabled') return { error: 'stale-lifecycle' }
  if (action === 'uninstall' && skill.lifecycle === 'uninstalled') return { error: 'stale-lifecycle' }
  return { skill }
}

function withheldCatalogMutation(action: string, view: MissionControlView): string | undefined {
  if (action !== 'activate' && action !== 'reactivate') return undefined
  if (view.skillCatalog?.state === 'withheld') return 'catalog-withheld'
  if (view.systemState === 'SAFE_MODE' || view.runtimeContext?.safeMode === true) return 'safe-mode'
  return undefined
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item))
}
