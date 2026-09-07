import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PublicSessionCatalog } from './session-catalog.js'
import { DEFAULT_SESSION_ID } from './runtime-context.js'

interface SessionArchiveHost {
  inspect(): PublicSessionCatalog
  noteApprovals(ids: readonly string[]): void
  archive(id: string, expected: { readonly sessionId: string; readonly revision: number }): Promise<PublicSessionCatalog>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionArchive: SessionArchiveService
  }
}

function textOutput() {
  return {
    schema: { type: 'string' as const },
    render(_args: unknown, value: string) {
      return [{ type: 'text' as const, text: value }]
    },
  }
}

/** Host-owned bridge from an Agent proposal to the durable Session Catalog. */
export class SessionArchiveService extends Service {
  private host?: SessionArchiveHost

  constructor(ctx: Context) {
    super(ctx, 'sessionArchive')
  }

  bind(host: SessionArchiveHost): void {
    this.host = host
  }

  request(agentId: string) {
    const host = this.requireHost()
    const catalog = host.inspect()
    if (agentId !== catalog.currentSessionId) throw new Error('only the current conversation can request its own archive')
    if (agentId === DEFAULT_SESSION_ID) throw new Error('Today is the permanent management conversation and cannot be archived')
    const session = catalog.sessions.find((item) => item.id === agentId)
    if (!session || session.lifecycle !== 'active') throw new Error('the current conversation is not active')
    const outcome = this.ctx.actionPolicy.policy.decide({
      capability: 'sessions',
      operation: 'archive',
      intent: 'execute',
      payload: { id: agentId, title: session.title, revision: catalog.revision },
    })
    if (outcome.kind === 'pending_confirmation') host.noteApprovals([outcome.confirmationId])
    return outcome
  }

  private requireHost(): SessionArchiveHost {
    if (!this.host) throw new Error('Session archive is unavailable without a persistent Session Catalog')
    return this.host
  }

  async execute(payload: Record<string, unknown>): Promise<PublicSessionCatalog> {
    const host = this.requireHost()
    if (typeof payload.id !== 'string' || typeof payload.revision !== 'number') throw new Error('invalid Session archive payload')
    return host.archive(payload.id, { sessionId: payload.id, revision: payload.revision })
  }
}

export const name = 'dsh-assistant-session-archive'
export const inject = ['actionPolicy', 'commands', 'systemPrompt', 'tools']

export async function apply(ctx: Context): Promise<void> {
  const holder: { service?: SessionArchiveService } = {}
  await ctx.plugin(class extends SessionArchiveService {
    constructor(scope: Context) {
      super(scope)
      holder.service = this
    }
  })
  const service = holder.service
  if (!service) throw new Error('Session archive service did not mount')
  ctx.actionPolicy.policy.registerExecutor('sessions', 'archive', (payload) => service.execute(payload))
  ctx.systemPrompt.section({
    name: 'product:session-archive',
    order: 53,
    text: 'When the user explicitly asks to archive the current non-Today conversation, call request_session_archive. This creates an exact approval; approval moves the conversation to Archived and switches away. Do not substitute files_write or create an archive document unless the user separately asks for one. The user may also invoke the deterministic /archive command.',
  })
  ctx.effect(() => ctx.commands.register({
    name: 'archive',
    description: 'Request approval to archive this conversation',
    handler(invocation) {
      if (invocation.rawInput.trim() !== '') return { kind: 'error', text: 'Usage: /archive (no arguments)' }
      try {
        const outcome = service.request(String(invocation.agent.id))
        if (outcome.kind === 'pending_confirmation') {
          return { kind: 'success', text: 'Session archive requested. Review the ARCHIVE CONVERSATION card.' }
        }
        if (outcome.kind === 'deny') return { kind: 'error', text: outcome.reason }
        return { kind: 'success', text: 'Session archive completed.' }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : 'Session archive is unavailable.' }
      }
    },
  }))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'request_session_archive',
    description: 'Request exact human approval to archive the current non-Today conversation. Approval moves it to Archived and switches to another active conversation; it does not write an archive file.',
    parameters: {},
    output: textOutput(),
    async execute(_args, exec) {
      if (!exec.agent) throw new Error('Session archive requires a calling agent')
      return JSON.stringify(service.request(String(exec.agent.id)))
    },
  })))
}
