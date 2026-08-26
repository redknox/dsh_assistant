import { sanitizeProviderError } from '../integrations/sanitize.js'
import type { MissionControlView } from './types.js'

const SENSITIVE_KEY = /secret|token|authorization|credential|password|cookie|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|bearer|private[_-]?key/i

const APPROVAL_PAYLOAD_ALLOWLIST = [
  'title',
  'start',
  'end',
  'timeZone',
  'calendarId',
  'attendees',
  'allDay',
  'id',
  'description',
] as const

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key)
}

export function redactText(value: string): string {
  return sanitizeProviderError(value)
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? '[redacted]' : redactUnknown(nested)
    }
    return out
  }
  return '[redacted]'
}

export function allowedApprovalPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of APPROVAL_PAYLOAD_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue
    if (isSensitiveKey(key)) {
      out[key] = '[redacted]'
      continue
    }
    out[key] = redactUnknown(payload[key])
  }
  return out
}

export function sanitizeMissionControlView(view: MissionControlView): MissionControlView {
  return {
    ...view,
    conversation: view.conversation.map((item) => ({ ...item, text: redactText(item.text) })),
    activity: view.activity.map((item) => ({ ...item, summary: redactText(item.summary) })),
    approvalResolutions: (view.approvalResolutions ?? []).map((item) => ({
      ...item,
      ...(item.capability ? { capability: redactText(item.capability) } : {}),
      ...(item.operation ? { operation: redactText(item.operation) } : {}),
    })),
    approvals: view.approvals.map((card) => ({
      ...card,
      target: redactText(card.target),
      sideEffect: redactText(card.sideEffect),
      details: card.details.map((line) => redactText(line)),
    })),
    activations: view.activations.map((card) => ({
      ...card,
      details: card.details.map((line) => redactText(line)),
      effects: card.effects.map((line) => redactText(line)),
    })),
    plugins: view.plugins.map((plugin) => ({
      ...plugin,
      digest: plugin.digest === undefined ? undefined : redactText(plugin.digest),
    })),
    skills: (view.skills ?? []).map((item) => ({
      ...item,
      digest: redactText(item.digest),
      description: redactText(item.description),
      ...(item.whenToUse ? { whenToUse: redactText(item.whenToUse) } : {}),
    })),
    extensions: (view.extensions ?? []).map((item) => ({
      ...item,
      digest: item.digest === undefined ? undefined : redactText(item.digest),
      eligibilityDenials: item.eligibilityDenials.map((reason) => redactText(reason)),
    })),
    ...(view.rollback
      ? { rollback: { ...view.rollback, reason: redactText(view.rollback.reason) } }
      : {}),
    memory: view.memory.map((item) => ({ ...item, statement: redactText(item.statement) })),
    knowledge: view.knowledge.map((item) => ({
      ...item,
      sourceUri: redactText(item.sourceUri),
      ...(item.title ? { title: redactText(item.title) } : {}),
      ...(item.excerpt ? { excerpt: redactText(item.excerpt) } : {}),
    })),
    ...(view.recovery
      ? { recovery: { ...view.recovery, why: redactText(view.recovery.why) } }
      : {}),
    ...(view.activationFailure
      ? { activationFailure: { ...view.activationFailure, summary: redactText(view.activationFailure.summary) } }
      : {}),
    ...(view.sessions
      ? {
        sessions: {
          ...view.sessions,
          sessions: view.sessions.sessions.map((item) => ({
            ...item,
            title: redactText(item.title),
            ...(item.preview ? { preview: redactText(item.preview) } : {}),
          })),
        },
      }
      : {}),
    controlStrip: {
      ...view.controlStrip,
      ...(view.controlStrip.degradation ? { degradation: redactText(view.controlStrip.degradation) } : {}),
      ...(view.controlStrip.objective ? { objective: redactText(view.controlStrip.objective) } : {}),
    },
  }
}
