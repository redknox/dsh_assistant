import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { actionFingerprint } from '../policy/index.js'
import type { DshApprovalDecision, DshApprovalTicket, OpenDshApproval } from './types.js'

type Pending = {
  ticket: DshApprovalTicket
  settle?: (outcome: ApprovalOutcome) => void
  detachAbort?: () => void
}

/**
 * One-shot bridge between DSH's approval waterfall and a human control surface.
 * It never executes tools: resolving a ticket only returns an outcome to DSH.
 */
export class DshApprovalBroker {
  private readonly records = new Map<string, Pending>()

  constructor(private readonly historyLimit = 200) {}

  open(input: OpenDshApproval): Promise<ApprovalOutcome> {
    const id = cardId(input.requestId)
    if (this.records.has(id)) return Promise.resolve('unavailable')

    const payload = {
      requestId: input.requestId,
      toolName: input.toolName,
      ...(input.callId ? { callId: input.callId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.arguments !== undefined ? { arguments: input.arguments } : {}),
      sessionId: input.sessionId,
    }
    const record: Pending = {
      ticket: {
        id,
        ...payload,
        fingerprint: actionFingerprint('dsh-tool', input.toolName, payload),
        status: 'pending',
        createdAt: new Date().toISOString(),
      },
    }
    this.records.set(id, record)
    this.prune()

    if (input.signal?.aborted) {
      this.settle(record, 'cancelled')
      return Promise.resolve('cancelled')
    }

    return new Promise<ApprovalOutcome>((resolve) => {
      record.settle = resolve
      if (input.signal) {
        const onAbort = () => this.settle(record, 'cancelled')
        input.signal.addEventListener('abort', onAbort, { once: true })
        record.detachAbort = () => input.signal?.removeEventListener('abort', onAbort)
      }
    })
  }

  resolve(id: string, decision: DshApprovalDecision): DshApprovalTicket {
    const record = this.records.get(id)
    if (!record) throw new Error('unknown DSH approval')
    if (record.ticket.status !== 'pending') throw new Error('stale DSH approval')
    const outcome: ApprovalOutcome = decision === 'approve'
      ? 'allowed-once'
      : decision === 'deny' ? 'rejected' : 'cancelled'
    this.settle(record, outcome)
    return record.ticket
  }

  list(): readonly DshApprovalTicket[] {
    return [...this.records.values()].map((record) => record.ticket)
  }

  hasRequest(requestId: string): boolean {
    return this.records.has(cardId(requestId))
  }

  dispose(): void {
    for (const record of this.records.values()) {
      if (record.ticket.status === 'pending') this.settle(record, 'unavailable')
    }
  }

  private settle(record: Pending, outcome: ApprovalOutcome): void {
    if (record.ticket.status !== 'pending') return
    record.detachAbort?.()
    record.detachAbort = undefined
    record.ticket = { ...record.ticket, status: outcome }
    const resolve = record.settle
    record.settle = undefined
    resolve?.(outcome)
  }

  private prune(): void {
    if (this.records.size <= this.historyLimit) return
    for (const [id, record] of this.records) {
      if (record.ticket.status === 'pending') continue
      this.records.delete(id)
      if (this.records.size <= this.historyLimit) break
    }
  }
}

function cardId(requestId: string): string {
  return `dsh:${requestId}`
}
