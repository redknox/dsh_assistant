import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-compaction'
import type { ApprovalCard } from '../domain/workspace/types.js'
import { sanitizeProviderError } from '../domain/integrations/sanitize.js'

export type ReliabilityCategory = 'startup' | 'tool' | 'approval' | 'compaction' | 'backup' | 'connector'
export type ReliabilitySeverity = 'P0' | 'P1' | 'P2'

export interface ReliabilityEvent {
  readonly schemaVersion: 1
  readonly id: string
  readonly occurredAt: string
  readonly severity: ReliabilitySeverity
  readonly category: ReliabilityCategory
  readonly code: string
  readonly message: string
  readonly sessionId?: string
}

export interface ReliabilitySummary {
  readonly state: 'quiet' | 'attention'
  readonly since: string
  readonly p0: number
  readonly p1: number
  readonly total: number
  readonly byCategory: Readonly<Record<ReliabilityCategory, number>>
  readonly recent: readonly ReliabilityEvent[]
}

const CATEGORIES: readonly ReliabilityCategory[] = ['startup', 'tool', 'approval', 'compaction', 'backup', 'connector']

export class ReliabilityJournal {
  private sequence = 0

  constructor(readonly file: string, private readonly now: () => Date = () => new Date()) {}

  record(input: Omit<ReliabilityEvent, 'schemaVersion' | 'id' | 'occurredAt'>): ReliabilityEvent {
    const occurredAt = this.now().toISOString()
    const event: ReliabilityEvent = {
      schemaVersion: 1,
      id: `${occurredAt}:${process.pid}:${++this.sequence}`,
      occurredAt,
      ...input,
      message: sanitizeProviderError(input.message).replace(/\s+/g, ' ').trim().slice(0, 500),
    }
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, { mode: 0o600 })
    return event
  }

  recordOncePerDay(input: Omit<ReliabilityEvent, 'schemaVersion' | 'id' | 'occurredAt'>): ReliabilityEvent | undefined {
    const day = this.now().toISOString().slice(0, 10)
    if (this.list().some((event) => event.occurredAt.startsWith(day) && event.category === input.category && event.code === input.code)) return undefined
    return this.record(input)
  }

  list(): ReliabilityEvent[] {
    if (!existsSync(this.file)) return []
    return readFileSync(this.file, 'utf8').split(/\r?\n/).flatMap((line) => {
      if (!line) return []
      try {
        const parsed = JSON.parse(line) as ReliabilityEvent
        return parsed.schemaVersion === 1 && CATEGORIES.includes(parsed.category) ? [parsed] : []
      } catch {
        return []
      }
    })
  }

  summary(days = 7): ReliabilitySummary {
    const now = this.now()
    const since = new Date(now.getTime() - days * 86_400_000)
    const events = this.list().filter((event) => Date.parse(event.occurredAt) >= since.getTime())
    const byCategory = Object.fromEntries(CATEGORIES.map((category) => [category, events.filter((event) => event.category === category).length])) as Record<ReliabilityCategory, number>
    const p0 = events.filter((event) => event.severity === 'P0').length
    const p1 = events.filter((event) => event.severity === 'P1').length
    return {
      state: p0 + p1 > 0 ? 'attention' : 'quiet',
      since: since.toISOString(),
      p0,
      p1,
      total: events.length,
      byCategory,
      recent: events.slice(-8).reverse(),
    }
  }
}

export class RuntimeReliabilityObserver {
  private readonly approvalFirstSeen = new Map<string, number>()
  private readonly reportedStuck = new Set<string>()

  constructor(private readonly journal: ReliabilityJournal, private readonly now: () => Date = () => new Date()) {}

  attach(ctx: Context): () => void {
    const offTools = ctx.on('tools/result', (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
      if (!result.isError) return
      const code = result.error.info?.code ?? 'TOOL_ERROR'
      if (code === 'ABORTED' || code === 'ABORTED_BEFORE_DISPATCH') return
      const expected = /DENIED|CANCEL|APPROVAL|INVALID|ARGUMENT|NOT_FOUND/.test(code)
      this.journal.record({
        severity: expected ? 'P2' : 'P1',
        category: 'tool',
        code,
        message: `${exec.name}: ${result.error.message}`,
        ...(exec.agent ? { sessionId: String(exec.agent.id) } : {}),
      })
    })
    const offSession = ctx.on('session/event', (session, event) => {
      if (event.type !== 'compaction/end' || event.data.error === undefined) return
      this.journal.record({
        severity: 'P1',
        category: 'compaction',
        code: 'COMPACTION_FAILED',
        message: event.data.error,
        sessionId: String(session.id),
      })
    })
    return () => {
      offTools()
      offSession()
    }
  }

  inspectApprovals(cards: readonly ApprovalCard[], thresholdMs = 30 * 60_000): void {
    const now = this.now().getTime()
    const pending = new Set(cards.filter((card) => ['pending', 'approval-requested', 'unreviewed'].includes(card.status)).map((card) => card.id))
    for (const id of [...this.approvalFirstSeen.keys()]) if (!pending.has(id)) this.approvalFirstSeen.delete(id)
    for (const card of cards) {
      if (!pending.has(card.id)) continue
      const first = this.approvalFirstSeen.get(card.id) ?? now
      this.approvalFirstSeen.set(card.id, first)
      if (now - first < thresholdMs || this.reportedStuck.has(card.id)) continue
      this.reportedStuck.add(card.id)
      this.journal.record({
        severity: 'P1',
        category: 'approval',
        code: 'APPROVAL_STUCK',
        message: `${card.kind}:${card.target} remained pending beyond ${Math.round(thresholdMs / 60_000)} minutes`,
        ...(card.sessionId ? { sessionId: card.sessionId } : {}),
      })
    }
  }
}
