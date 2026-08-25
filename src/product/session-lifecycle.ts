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
  | 'before-unlink'

export interface SessionHandle {
  dispose(): Promise<void>
  readonly agent: { readonly session: unknown; readonly status?: string }
}

export class LiveSessionHost {
  constructor(
    private readonly ctx: Context,
    private readonly surface: AssistantControlSurface,
    private readonly catalog: SessionCatalog,
    private readonly workspace: string | undefined,
    private readonly persistCurrent: (sessionId: string) => void,
    private handle: SessionHandle,
    private readonly safeMode: boolean,
    private readonly faults: { failAt?: SessionLifecycleFault } = {},
  ) {}

  currentHandle(): SessionHandle {
    return this.handle
  }

  inspect(): PublicSessionCatalog {
    return this.catalog.inspect()
  }

  async recover(): Promise<PublicSessionCatalog> {
    const journal = this.catalog.readJournal()
    if (!journal) return this.catalog.inspect()
    const stored = this.catalog.load()
    if (sameSnapshot(stored, journal.previous) && journal.phase === 'prepared') {
      this.catalog.clearJournal()
      return this.catalog.inspect()
    }
    if (journal.phase === 'committed' || stored.currentSessionId === journal.toSessionId) {
      if (this.surface.sessionId !== journal.toSessionId) {
        await this.finishAdopt(journal.toSessionId)
      }
      for (const id of journal.unlink ?? []) this.catalog.discardDeletedPersistence(id)
      this.catalog.clearJournal()
      return this.catalog.inspect()
    }
      this.catalog.restoreSnapshot(journal.previous)
    this.catalog.clearJournal()
    return this.catalog.inspect()
  }

  async create(title: string | undefined, expected: { readonly sessionId: string; readonly revision: number }): Promise<PublicSessionCatalog> {
    this.assertMutable()
    this.assertExpected(expected)
    this.assertIdle()
    const previous = this.catalog.load()
    const created = this.catalog.create(title, expected)
    try {
      return await this.commitRoute({
        op: 'create',
        toSessionId: created.id,
        expected: { sessionId: expected.sessionId, revision: this.catalog.inspect().revision },
        apply: (nextExpected) => this.catalog.switchTo(created.id, nextExpected),
      })
    } catch (error) {
      this.catalog.restoreSnapshot(previous)
      throw error
    }
  }

  async switchTo(id: string, expected: { readonly sessionId: string; readonly revision: number }): Promise<PublicSessionCatalog> {
    this.assertExpected(expected)
    if (id === this.surface.sessionId) return this.catalog.inspect()
    this.assertIdle()
    return this.commitRoute({
      op: 'switch',
      toSessionId: id,
      expected,
      apply: (nextExpected) => this.catalog.switchTo(id, nextExpected),
    })
  }

  async rename(id: string, title: string, expected: { readonly sessionId: string; readonly revision: number }): Promise<PublicSessionCatalog> {
    this.assertMutable()
    this.assertExpected(expected)
    return this.catalog.rename(id, title, expected)
  }

  async archive(id: string, expected: { readonly sessionId: string; readonly revision: number }): Promise<PublicSessionCatalog> {
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
  }

  async restore(id: string, expected: { readonly sessionId: string; readonly revision: number }): Promise<PublicSessionCatalog> {
    this.assertMutable()
    this.assertExpected(expected)
    return this.catalog.restore(id, expected)
  }

  async delete(id: string, expected: { readonly sessionId: string; readonly revision: number; readonly confirm: boolean }): Promise<PublicSessionCatalog> {
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
    const previous = this.catalog.load()
    if (from !== input.toSessionId) await this.flushCurrent()
    this.trip('after-flush')
    const next = from === input.toSessionId ? undefined : await createAssistantAgent(this.ctx, input.toSessionId, undefined, this.workspace)
    const journal: CatalogJournal = {
      schemaVersion: 1,
      op: input.op,
      fromSessionId: from,
      toSessionId: input.toSessionId,
      previous,
      phase: 'prepared',
      ...(input.unlink ? { unlink: input.unlink } : {}),
    }
    try {
      this.trip('after-prepare-next')
      this.catalog.writeJournal(journal)
      const view = input.apply(input.expected)
      this.catalog.writeJournal({ ...journal, phase: 'committed' })
      this.trip('after-catalog-commit')
      if (from !== input.toSessionId) {
        this.surface.setSessionId(input.toSessionId)
        this.persistCurrent(input.toSessionId)
        this.trip('after-persist')
        const outgoing = this.handle
        this.handle = next!
        await outgoing.dispose()
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
      if (next && next !== this.handle) await next.dispose().catch(() => undefined)
      const live = this.catalog.load()
      if (!sameSnapshot(live, previous)) this.catalog.restoreSnapshot(previous)
      if (this.surface.sessionId !== from) {
        this.surface.setSessionId(from)
        this.persistCurrent(from)
      }
      this.catalog.clearJournal()
      throw error
    }
  }

  private async finishAdopt(id: string): Promise<void> {
    const next = await createAssistantAgent(this.ctx, id, undefined, this.workspace)
    const outgoing = this.handle
    this.surface.setSessionId(id)
    this.persistCurrent(id)
    this.handle = next
    await outgoing.dispose()
  }

  private async flushCurrent(): Promise<void> {
    await this.ctx.sessions.flush(this.handle.agent.session as never)
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
