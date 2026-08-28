import { Service, type Context } from '@deepseek-ai/cordis'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DshApprovalBroker } from '../domain/approval/index.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshApprovalBridge: DshApprovalBridgeService
  }
}

export class DshApprovalBridgeService extends Service {
  readonly broker = new DshApprovalBroker()

  constructor(ctx: Context) {
    super(ctx, 'dshApprovalBridge')
  }
}

export const name = 'dsh-assistant-approval-bridge'
export const inject = ['approval']

export async function apply(ctx: Context) {
  await ctx.plugin(DshApprovalBridgeService)
  const service = ctx.get('dshApprovalBridge') as DshApprovalBridgeService | undefined
  if (!service) throw new Error('DSH approval bridge service did not mount')
  const bridge = service.broker
  ctx.effect(() => ctx.on('approval/request', async (request) => {
    const asked = findCurrentAsk(request, bridge)
    if (!asked) return 'unavailable'
    return bridge.open({
      requestId: String(asked.data.id),
      toolName: request.toolName,
      ...(request.callId ? { callId: String(request.callId) } : {}),
      ...(request.reason ? { reason: request.reason } : {}),
      ...(toolArguments(request) !== undefined ? { arguments: toolArguments(request) } : {}),
      sessionId: String(request.agent.id),
      ...(request.signal ? { signal: request.signal } : {}),
    })
  }))
  ctx.effect(() => () => bridge.dispose())
}

function findCurrentAsk(request: ApprovalRequest, bridge: DshApprovalBroker): Extract<SessionEvent, { type: 'approval/asked' }> | undefined {
  const decided = new Set(
    request.agent.session.events
      .filter((event): event is Extract<SessionEvent, { type: 'approval/decided' }> => event.type === 'approval/decided')
      .map((event) => String(event.data.id)),
  )
  for (let index = request.agent.session.events.length - 1; index >= 0; index -= 1) {
    const event = request.agent.session.events[index]
    if (event?.type !== 'approval/asked') continue
    const id = String(event.data.id)
    if (decided.has(id) || bridge.hasRequest(id)) continue
    if (event.data.toolName !== request.toolName) continue
    if (request.callId !== undefined && String(event.data.callId) !== String(request.callId)) continue
    return event
  }
  return undefined
}

function toolArguments(request: ApprovalRequest): unknown {
  if (request.callId === undefined) return undefined
  for (let index = request.agent.session.events.length - 1; index >= 0; index -= 1) {
    const event = request.agent.session.events[index]
    if (event?.type !== 'tool/call' || String(event.data.callId) !== String(request.callId)) continue
    try {
      return JSON.parse(event.data.arguments)
    } catch {
      return event.data.arguments
    }
  }
  return undefined
}
