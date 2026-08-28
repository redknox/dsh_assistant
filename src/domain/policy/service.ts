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

  autoExecuteCapabilities(): readonly string[] {
    return this.config.autoExecute.filter((capability) => this.levelFor(capability, 'execute') === 'L3')
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
    if (decision.confirmationId) {
      if (!this.tryClaim(decision.confirmationId)) {
        return this.denyForTicket(decision.confirmationId)
      }
      return this.runClaimed(decision.confirmationId, request.signal)
    }
    const executor = this.executors.get(executorKey(request.capability, request.operation))
    if (!executor) {
      return this.deny(request, 'unavailable', `no executor registered for ${request.capability}.${request.operation}`, decision.level)
    }
    const result = await executor(request.payload, request.signal)
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
      if (ticket.status === 'pending') this.updateTicket(ticket.id, 'cancelled')
      return this.deny(ticketRequest(ticket), 'cancelled', 'confirmation was cancelled', ticket.level, ticket.id)
    }
    if (ticket.status === 'executing') {
      return this.deny(ticketRequest(ticket), 'in_flight', 'confirmation is already executing', ticket.level, ticket.id)
    }
    if (ticket.status === 'failed') {
      return this.deny(ticketRequest(ticket), 'failed', 'confirmation already failed and cannot be retried', ticket.level, ticket.id)
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
      if (!this.tryClose(ticket.id, 'denied')) return this.denyForTicket(ticket.id)
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
      if (!this.tryClose(ticket.id, 'cancelled')) return this.denyForTicket(ticket.id)
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
    if (!this.tryClaim(ticket.id)) return this.denyForTicket(ticket.id)
    return this.runClaimed(ticket.id, signal)
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
    if (ticket.status === 'executing') return this.deny(request, 'in_flight', 'confirmation is already executing', level, ticket.id)
    if (ticket.status === 'failed') return this.deny(request, 'failed', 'confirmation already failed and cannot be retried', level, ticket.id)
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

  /** Claim the ticket before any await so a concurrent approve cannot enter the executor. */
  private tryClaim(confirmationId: string): boolean {
    const ticket = this.tickets.get(confirmationId)
    if (!ticket) return false
    if (ticket.status !== 'pending' && ticket.status !== 'approved') return false
    this.updateTicket(confirmationId, 'executing')
    return true
  }

  private tryClose(confirmationId: string, status: 'denied' | 'cancelled'): boolean {
    const ticket = this.tickets.get(confirmationId)
    if (!ticket || (ticket.status !== 'pending' && ticket.status !== 'approved')) return false
    this.updateTicket(confirmationId, status)
    return true
  }

  private async runClaimed(confirmationId: string, signal?: AbortSignal): Promise<PolicyOutcome> {
    const ticket = this.tickets.get(confirmationId)
    if (!ticket) {
      return this.deny({ capability: 'policy', operation: 'execute' }, 'unavailable', 'confirmation id is unknown', 'L2')
    }
    this.record({
      verdict: 'approved',
      level: ticket.level,
      capability: ticket.capability,
      operation: ticket.operation,
      confirmationId: ticket.id,
      fingerprint: ticket.fingerprint,
      reason: 'confirmation claimed; executing bound action once',
    })
    const request = ticketRequest(ticket)
    const executor = this.executors.get(executorKey(ticket.capability, ticket.operation))
    if (!executor) {
      this.updateTicket(ticket.id, 'failed')
      return this.deny(request, 'unavailable', `no executor registered for ${ticket.capability}.${ticket.operation}`, ticket.level, ticket.id)
    }
    try {
      const result = await executor(ticket.payload, signal)
      this.consume(ticket.id, request)
      return {
        kind: 'allow',
        level: ticket.level,
        reason: 'approved action executed once',
        confirmationId: ticket.id,
        result,
      }
    } catch {
      this.updateTicket(ticket.id, 'failed')
      return this.deny(
        request,
        'failed',
        'executor failed after the confirmation was claimed; retry is not allowed',
        ticket.level,
        ticket.id,
      )
    }
  }

  private denyForTicket(confirmationId: string): Extract<PolicyOutcome, { kind: 'deny' }> {
    const ticket = this.tickets.get(confirmationId)
    if (!ticket) {
      return this.deny({ capability: 'policy', operation: 'resolve' }, 'unavailable', 'confirmation id is unknown', 'L2')
    }
    if (ticket.status === 'executing') {
      return this.deny(ticketRequest(ticket), 'in_flight', 'confirmation is already executing', ticket.level, ticket.id)
    }
    if (ticket.status === 'failed') {
      return this.deny(ticketRequest(ticket), 'failed', 'confirmation already failed and cannot be retried', ticket.level, ticket.id)
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
    return this.deny(ticketRequest(ticket), 'replay', 'confirmation is not available to execute', ticket.level, ticket.id)
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
