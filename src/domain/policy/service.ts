import { actionFingerprint } from './fingerprint.js'
import type {
  ActionExecutor,
  ActionRequest,
  AuditRecord,
  ConfirmationTicket,
  PolicyConfig,
  PolicyDenyCode,
  PolicyOutcome,
  TrustLevel,
} from './types.js'

export class PolicyService {
  private readonly tickets = new Map<string, ConfirmationTicket>()
  private readonly executors = new Map<string, ActionExecutor>()
  private readonly audit: AuditRecord[] = []
  private nextId = 1

  constructor(private readonly config: PolicyConfig) {}

  levelFor(capability: string, intent: ActionRequest['intent']): TrustLevel {
    const rule = this.config.rules.find((entry) => entry.capability === capability && entry.intent === intent)
    if (!rule) return intent === 'read' ? 'L0' : intent === 'propose' ? 'L1' : 'L2'
    return rule.level
  }

  registerExecutor(capability: string, operation: string, executor: ActionExecutor): void {
    this.executors.set(executorKey(capability, operation), executor)
  }

  confirmations(): readonly ConfirmationTicket[] {
    return [...this.tickets.values()]
  }

  auditTrail(): readonly AuditRecord[] {
    return [...this.audit]
  }

  decide(request: ActionRequest): PolicyOutcome {
    if (request.signal?.aborted) {
      return this.deny(request, 'cancelled', 'request was cancelled', this.levelFor(request.capability, request.intent))
    }
    const level = this.levelFor(request.capability, request.intent)
    const fingerprint = actionFingerprint(request.capability, request.operation, request.payload)
    if (request.intent !== 'execute') {
      return this.allow(request, level, `${request.intent} is permitted at ${level}`, fingerprint)
    }
    if (level === 'L3' && this.config.autoExecute.includes(request.capability)) {
      return this.allow(request, level, 'L3 auto-execute is enabled for this capability', fingerprint)
    }
    if (request.confirmationId) {
      return this.decideExisting(request, level, fingerprint)
    }
    const existing = [...this.tickets.values()].find((ticket) => ticket.fingerprint === fingerprint && ticket.status === 'pending')
    const ticket = existing ?? this.createTicket(request, level, fingerprint)
    this.record({
      verdict: 'pending_confirmation',
      level,
      capability: request.capability,
      operation: request.operation,
      confirmationId: ticket.id,
      fingerprint,
      reason: `${level} requires confirmation bound to this exact action`,
    })
    return {
      kind: 'pending_confirmation',
      level,
      reason: `${level} requires confirmation bound to this exact action`,
      confirmationId: ticket.id,
      fingerprint,
    }
  }

  async apply(request: ActionRequest): Promise<PolicyOutcome> {
    const decision = this.decide(request)
    if (decision.kind !== 'allow') return decision
    if (request.intent !== 'execute') return decision
    const executor = this.executors.get(executorKey(request.capability, request.operation))
    if (!executor) {
      return this.deny(request, 'unavailable', `no executor registered for ${request.capability}.${request.operation}`, decision.level)
    }
    const result = await executor(request.payload, request.signal)
    if (decision.confirmationId) this.consume(decision.confirmationId, request)
    return { ...decision, result }
  }

  async resolve(confirmationId: string, decision: 'approve' | 'deny' | 'cancel', signal?: AbortSignal): Promise<PolicyOutcome> {
    const ticket = this.tickets.get(confirmationId)
    if (!ticket) {
      return this.deny(
        { capability: 'policy', operation: 'resolve' },
        'unavailable',
        'confirmation id is unknown',
        'L2',
      )
    }
    if (signal?.aborted) {
      this.updateTicket(ticket.id, 'cancelled')
      return this.deny(ticketRequest(ticket), 'cancelled', 'confirmation was cancelled', ticket.level)
    }
    if (ticket.status === 'consumed') {
      return this.deny(ticketRequest(ticket), 'replay', 'confirmation was already consumed', ticket.level, ticket.id)
    }
    if (ticket.status === 'denied') {
      return this.deny(ticketRequest(ticket), 'denied', 'confirmation was denied', ticket.level, ticket.id)
    }
    if (ticket.status === 'cancelled') {
      return this.deny(ticketRequest(ticket), 'cancelled', 'confirmation was cancelled', ticket.level, ticket.id)
    }
    if (decision === 'deny') {
      this.updateTicket(ticket.id, 'denied')
      this.record({
        verdict: 'deny',
        level: ticket.level,
        capability: ticket.capability,
        operation: ticket.operation,
        confirmationId: ticket.id,
        fingerprint: ticket.fingerprint,
        reason: 'confirmation was denied',
      })
      return { kind: 'deny', level: ticket.level, reason: 'confirmation was denied', code: 'denied', confirmationId: ticket.id }
    }
    if (decision === 'cancel') {
      this.updateTicket(ticket.id, 'cancelled')
      this.record({
        verdict: 'cancelled',
        level: ticket.level,
        capability: ticket.capability,
        operation: ticket.operation,
        confirmationId: ticket.id,
        fingerprint: ticket.fingerprint,
        reason: 'confirmation was cancelled',
      })
      return { kind: 'deny', level: ticket.level, reason: 'confirmation was cancelled', code: 'cancelled', confirmationId: ticket.id }
    }
    this.updateTicket(ticket.id, 'approved')
    this.record({
      verdict: 'approved',
      level: ticket.level,
      capability: ticket.capability,
      operation: ticket.operation,
      confirmationId: ticket.id,
      fingerprint: ticket.fingerprint,
      reason: 'confirmation approved; executing bound action once',
    })
    return this.apply({
      capability: ticket.capability,
      operation: ticket.operation,
      intent: 'execute',
      payload: ticket.payload,
      confirmationId: ticket.id,
      signal,
    })
  }

  private decideExisting(request: ActionRequest, level: TrustLevel, fingerprint: string): PolicyOutcome {
    const ticket = this.tickets.get(request.confirmationId!)
    if (!ticket) return this.deny(request, 'unavailable', 'confirmation id is unknown', level, request.confirmationId)
    if (ticket.fingerprint !== fingerprint) {
      return this.deny(request, 'mismatch', 'confirmation is bound to a different action', level, ticket.id)
    }
    if (ticket.status === 'denied') return this.deny(request, 'denied', 'confirmation was denied', level, ticket.id)
    if (ticket.status === 'cancelled') return this.deny(request, 'cancelled', 'confirmation was cancelled', level, ticket.id)
    if (ticket.status === 'consumed') return this.deny(request, 'replay', 'confirmation was already consumed', level, ticket.id)
    if (ticket.status === 'approved') {
      return this.allow(request, level, 'confirmation matches the bound action', fingerprint, ticket.id)
    }
    return {
      kind: 'pending_confirmation',
      level,
      reason: 'confirmation is still pending',
      confirmationId: ticket.id,
      fingerprint,
    }
  }

  private createTicket(request: ActionRequest, level: TrustLevel, fingerprint: string): ConfirmationTicket {
    const ticket: ConfirmationTicket = {
      id: `conf-${this.nextId++}`,
      fingerprint,
      capability: request.capability,
      operation: request.operation,
      payload: request.payload,
      level,
      status: 'pending',
      createdAt: new Date().toISOString(),
    }
    this.tickets.set(ticket.id, ticket)
    return ticket
  }

  private consume(confirmationId: string, request: ActionRequest): void {
    const ticket = this.tickets.get(confirmationId)
    if (!ticket || ticket.status === 'consumed') return
    this.updateTicket(confirmationId, 'consumed')
    this.record({
      verdict: 'consumed',
      level: ticket.level,
      capability: request.capability,
      operation: request.operation,
      confirmationId,
      fingerprint: ticket.fingerprint,
      reason: 'approved action executed once',
    })
  }

  private allow(
    request: ActionRequest,
    level: TrustLevel,
    reason: string,
    fingerprint: string,
    confirmationId?: string,
  ): PolicyOutcome {
    this.record({
      verdict: 'allow',
      level,
      capability: request.capability,
      operation: request.operation,
      confirmationId,
      fingerprint,
      reason,
    })
    return { kind: 'allow', level, reason, confirmationId }
  }

  private deny(
    request: Pick<ActionRequest, 'capability' | 'operation'>,
    code: PolicyDenyCode,
    reason: string,
    level: TrustLevel,
    confirmationId?: string,
  ): Extract<PolicyOutcome, { kind: 'deny' }> {
    this.record({
      verdict: 'deny',
      level,
      capability: request.capability,
      operation: request.operation,
      confirmationId,
      fingerprint: confirmationId ? this.tickets.get(confirmationId)?.fingerprint ?? 'none' : 'none',
      reason,
    })
    return { kind: 'deny', level, reason, code, confirmationId }
  }

  private updateTicket(id: string, status: ConfirmationTicket['status']): void {
    const ticket = this.tickets.get(id)
    if (!ticket) return
    this.tickets.set(id, { ...ticket, status })
  }

  private record(entry: Omit<AuditRecord, 'id' | 'at'>): void {
    this.audit.push({
      ...entry,
      id: `audit-${this.audit.length + 1}`,
      at: new Date().toISOString(),
    })
  }
}

function executorKey(capability: string, operation: string): string {
  return `${capability}:${operation}`
}

function ticketRequest(ticket: ConfirmationTicket): ActionRequest {
  return {
    capability: ticket.capability,
    operation: ticket.operation,
    intent: 'execute',
    payload: ticket.payload,
    confirmationId: ticket.id,
  }
}
