import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantAgent } from '../runtime/boot.js'
import { AssistantControlSurface } from '../ui/controller.js'
import {
  SessionCatalog,
  SessionCatalogError,
  type CatalogJournal,
  type CatalogTransactionOp,
  type PublicSessionCatalog,
  type SessionCatalogFile,
} from './session-catalog.js'

export type SessionLifecycleFault =
  | 'after-flush'
  | 'after-prepare-next'
  | 'after-catalog-commit'
  | 'after-persist'
  | 'after-dispose'
  | 'before-unlink'

export interface SessionHandle {
  dispose(): Promise<void>
  readonly agent: { readonly session: unknown; readonly status?: string }
}

export class LiveSessionHost {
  private routeTail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly ctx: Context,
    private readonly surface: AssistantControlSurface,
    private readonly catalog: SessionCatalog,
    private readonly workspace: string | undefined,
    private readonly persistCurrent: (sessionId: string) => void,
    private handle: SessionHandle,
    private readonly safeMode: boolean,
    private readonly faults: {
      failAt?: SessionLifecycleFault
      on?: Partial<Record<SessionLifecycleFault, () => void>>
    } = {},
  ) {}

  currentHandle(): SessionHandle {
    return this.handle
  }

  inspect(): PublicSessionCatalog {
    return this.catalog.inspect()
  }

  async finishCommittedJournal(journal: CatalogJournal): Promise<void> {
    if (journal.phase !== 'committed') return
    if (this.surface.sessionId !== journal.toSessionId) {
      await this.finishAdopt(journal.toSessionId)
    }
    for (const id of journal.unlink ?? []) this.catalog.discardDeletedPersistence(id)
    this.catalog.clearJournal()
  }

  async create(title: string | undefined, expected: { readonly sessionId: string; readonly revision: number }): Promise<PublicSessionCatalog> {
    return this.serialize(async () => {
      this.assertMutable()
      this.assertExpected(expected)
      this.assertIdle()
      this.capturePendingOrigins()
      const created = this.catalog.create(title, expected)
      return this.commitRoute({
        op: 'create',
        toSessionId: created.id,
        expected: { sessionId: expected.sessionId, revision: this.catalog.inspect().revision },
        apply: (nextExpected) => this.catalog.switchTo(created.id, nextExpected),
      })
    })
  }

  async switchTo(id: string, expected: { readonly sessionId: string; readonly revision: number }): Promise<PublicSessionCatalog> {
    return this.serialize(async () => {
      this.assertExpected(expected)
      if (id === this.surface.sessionId) return this.catalog.inspect()
      this.assertIdle()
      return this.commitRoute({
        op: 'switch',
        toSessionId: id,
        expected,
        apply: (nextExpected) => this.catalog.switchTo(id, nextExpected),
      })
    })
  }

  async rename(id: string, title: string, expected: { readonly sessionId: string; readonly revision: number }): Promise<PublicSessionCatalog> {
    return this.serialize(async () => {
      this.assertMutable()
      this.assertExpected(expected)
      return this.catalog.rename(id, title, expected)
    })
  }

  async archive(id: string, expected: { readonly sessionId: string; readonly revision: number }): Promise<PublicSessionCatalog> {
    return this.serialize(async () => {
      this.assertMutable()
      this.assertExpected(expected)
      const before = this.catalog.inspect()
      const nextCurrent = before.currentSessionId === id
        ? before.sessions.find((item) => item.lifecycle === 'active' && item.id !== id)?.id
        : before.currentSessionId
      if (nextCurrent === undefined) {
        throw new SessionCatalogError('last-active', 'the last active conversation cannot be archived')
      }
      if (before.currentSessionId === id) this.assertIdle()
      return this.commitRoute({
        op: 'archive',
        toSessionId: nextCurrent,
        expected,
        apply: (nextExpected) => this.catalog.archive(id, nextExpected),
      })
    })
  }

  async restore(id: string, expected: { readonly sessionId: string; readonly revision: number }): Promise<PublicSessionCatalog> {
    return this.serialize(async () => {
      this.assertMutable()
      this.assertExpected(expected)
      return this.catalog.restore(id, expected)
    })
  }

  async delete(id: string, expected: { readonly sessionId: string; readonly revision: number; readonly confirm: boolean }): Promise<PublicSessionCatalog> {
    return this.serialize(async () => {
      this.assertMutable()
      this.assertExpected(expected)
      const before = this.catalog.inspect()
      const nextCurrent = before.currentSessionId === id
        ? before.sessions.find((item) => item.lifecycle === 'active' && item.id !== id)?.id
        : before.currentSessionId
      if (nextCurrent === undefined) {
        throw new SessionCatalogError('last-active', 'the last active conversation cannot be deleted')
      }
      if (before.currentSessionId === id) this.assertIdle()
      return this.commitRoute({
        op: 'delete',
        toSessionId: nextCurrent,
        expected,
        unlink: [id],
        apply: (nextExpected) => this.catalog.delete(id, { ...nextExpected, confirm: expected.confirm }),
      })
    })
  }

  noteApprovals(ids: readonly string[]): void {
    for (const id of ids) this.catalog.noteApprovalOrigin(id, this.surface.sessionId)
  }

  touchPreview(text: string): void {
    this.catalog.touch(this.surface.sessionId, text)
  }

  private async commitRoute(input: {
    readonly op: CatalogTransactionOp
    readonly toSessionId: string
    readonly expected: { readonly sessionId: string; readonly revision: number }
    readonly apply: (expected: { readonly sessionId: string; readonly revision: number }) => PublicSessionCatalog
    readonly unlink?: readonly string[]
  }): Promise<PublicSessionCatalog> {
    const from = this.surface.sessionId
    this.capturePendingOrigins()
    if (from !== input.toSessionId) await this.flushCurrent()
    this.trip('after-flush')
    const next = from === input.toSessionId ? undefined : await createAssistantAgent(this.ctx, input.toSessionId, undefined, this.workspace)
    this.trip('after-prepare-next')
    const previous = this.catalog.load()
    let adopted = false
    let applied: SessionCatalogFile | undefined
    try {
      const journal: CatalogJournal = {
        schemaVersion: 1,
        op: input.op,
        fromSessionId: from,
        toSessionId: input.toSessionId,
        previous,
        phase: 'prepared',
        ...(input.unlink ? { unlink: input.unlink } : {}),
      }
      this.catalog.writeJournal(journal)
      const view = input.apply(input.expected)
      applied = this.catalog.load()
      this.catalog.writeJournal({ ...journal, phase: 'committed', intended: applied })
      this.trip('after-catalog-commit')
      if (from !== input.toSessionId) {
        this.persistCurrent(input.toSessionId)
        this.trip('after-persist')
        this.surface.setSessionId(input.toSessionId)
        const outgoing = this.handle
        this.handle = next!
        try {
          await outgoing.dispose()
        } finally {
          adopted = true
        }
        this.trip('after-dispose')
      } else {
        await next?.dispose()
      }
      if (input.unlink) {
        this.trip('before-unlink')
        for (const id of input.unlink) this.catalog.discardDeletedPersistence(id)
      }
      this.catalog.clearJournal()
      return view
    } catch (error) {
      if (adopted) throw error
      if (next && next !== this.handle) await next.dispose().catch(() => undefined)
      const live = this.catalog.load()
      if (applied && sameSnapshot(live, applied)) {
        try {
          this.catalog.restoreSnapshot(previous)
          this.persistCurrent(from)
          this.surface.setSessionId(from)
          this.catalog.clearJournal()
        } catch {
          this.catalog.restoreSnapshot(applied)
        }
      }
      throw error
    }
  }

  private capturePendingOrigins(): void {
    const policy = this.ctx.get('actionPolicy') as { policy?: { confirmations(): readonly { readonly id: string; readonly status: string }[] } } | undefined
    const pending = policy?.policy?.confirmations().filter((item) => item.status === 'pending').map((item) => item.id) ?? []
    this.noteApprovals(pending)
  }

  private async finishAdopt(id: string): Promise<void> {
    const next = await createAssistantAgent(this.ctx, id, undefined, this.workspace)
    const outgoing = this.handle
    this.persistCurrent(id)
    this.surface.setSessionId(id)
    this.handle = next
    await outgoing.dispose()
  }

  private async flushCurrent(): Promise<void> {
    await this.ctx.sessions.flush(this.handle.agent.session as never)
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.routeTail.then(work, work)
    this.routeTail = next.then(() => undefined, () => undefined)
    return next
  }

  private assertExpected(expected: { readonly sessionId: string; readonly revision: number }): void {
    if (expected.sessionId !== this.surface.sessionId) {
      throw new SessionCatalogError('stale-session', 'request targeted a different current session')
    }
    if (expected.revision !== this.catalog.inspect().revision) {
      throw new SessionCatalogError('stale-revision', 'session catalog revision is stale')
    }
  }

  private assertIdle(): void {
    const agent = this.ctx.agents.get(SessionId(this.surface.sessionId))
    if (agent?.status === 'running') {
      throw new SessionCatalogError('busy', 'current conversation is still running')
    }
  }

  private assertMutable(): void {
    if (this.safeMode) {
      throw new SessionCatalogError('recovery-required', 'conversation lifecycle is frozen while Safe Mode is active')
    }
  }

  private trip(point: SessionLifecycleFault): void {
    this.faults.on?.[point]?.()
    if (this.faults.failAt === point) {
      this.faults.failAt = undefined
      throw new SessionCatalogError('injected-fault', point)
    }
  }
}

function sameSnapshot(left: SessionCatalogFile, right: SessionCatalogFile): boolean {
  return left.revision === right.revision
    && left.currentSessionId === right.currentSessionId
    && left.sessions.length === right.sessions.length
    && left.sessions.every((item, index) => item.id === right.sessions[index]?.id && item.lifecycle === right.sessions[index]?.lifecycle)
}
