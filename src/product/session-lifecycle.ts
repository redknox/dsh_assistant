import type { Context } from '@deepseek-ai/cordis'
import { createAssistantAgent } from '../runtime/boot.js'
import { AssistantControlSurface } from '../ui/controller.js'
import { SessionCatalog, SessionCatalogError, type PublicSessionCatalog } from './session-catalog.js'

export interface SessionHandle {
  dispose(): Promise<void>
  readonly agent: { readonly session: unknown }
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
  ) {}

  currentHandle(): SessionHandle {
    return this.handle
  }

  inspect(): PublicSessionCatalog {
    return this.catalog.inspect()
  }

  async create(title?: string): Promise<PublicSessionCatalog> {
    this.assertMutable()
    const created = this.catalog.create(title)
    const handle = await createAssistantAgent(this.ctx, created.id, undefined, this.workspace)
    await handle.dispose()
    return this.switchTo(created.id, {
      sessionId: this.surface.sessionId,
      revision: this.catalog.inspect().revision,
    })
  }

  async switchTo(id: string, expected: { readonly sessionId: string; readonly revision: number }): Promise<PublicSessionCatalog> {
    if (expected.sessionId !== this.surface.sessionId) {
      throw new SessionCatalogError('stale-session', 'request targeted a different current session')
    }
    const inspected = this.catalog.inspect()
    if (expected.revision !== inspected.revision) {
      throw new SessionCatalogError('stale-revision', 'session catalog revision is stale')
    }
    if (id === this.surface.sessionId) return inspected
    await this.flushCurrent()
    const next = await createAssistantAgent(this.ctx, id, undefined, this.workspace)
    try {
      const view = this.catalog.switchTo(id, expected)
      this.surface.setSessionId(id)
      this.persistCurrent(id)
      await this.handle.dispose()
      this.handle = next
      return view
    } catch (error) {
      await next.dispose()
      throw error
    }
  }

  async rename(id: string, title: string, expected: { readonly revision: number }): Promise<PublicSessionCatalog> {
    this.assertMutable()
    return this.catalog.rename(id, title, expected)
  }

  async archive(id: string, expected: { readonly revision: number }): Promise<PublicSessionCatalog> {
    this.assertMutable()
    const before = this.catalog.inspect()
    const view = this.catalog.archive(id, expected)
    if (before.currentSessionId === id && view.currentSessionId !== id) {
      await this.adopt(view.currentSessionId)
    }
    return this.catalog.inspect()
  }

  async restore(id: string, expected: { readonly revision: number }): Promise<PublicSessionCatalog> {
    this.assertMutable()
    return this.catalog.restore(id, expected)
  }

  async delete(id: string, expected: { readonly revision: number; readonly confirm: boolean }): Promise<PublicSessionCatalog> {
    this.assertMutable()
    const before = this.catalog.inspect()
    const view = this.catalog.delete(id, expected)
    this.catalog.discardDeletedPersistence(id)
    if (before.currentSessionId === id && view.currentSessionId !== id) {
      await this.adopt(view.currentSessionId)
    }
    return this.catalog.inspect()
  }

  noteApprovals(ids: readonly string[]): void {
    for (const id of ids) this.catalog.noteApprovalOrigin(id, this.surface.sessionId)
  }

  touchPreview(text: string): void {
    this.catalog.touch(this.surface.sessionId, text)
  }

  private async adopt(id: string): Promise<void> {
    await this.flushCurrent()
    const next = await createAssistantAgent(this.ctx, id, undefined, this.workspace)
    this.surface.setSessionId(id)
    this.persistCurrent(id)
    await this.handle.dispose()
    this.handle = next
  }

  private async flushCurrent(): Promise<void> {
    await this.ctx.sessions.flush(this.handle.agent.session as never)
  }

  private assertMutable(): void {
    if (this.safeMode) {
      throw new SessionCatalogError('recovery-required', 'conversation lifecycle is frozen while Safe Mode is active')
    }
  }
}
