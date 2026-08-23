import { Service, type Context } from '@deepseek-ai/cordis'
import { EXAMPLE_PERSONAL_POLICY, PolicyService, requestFromTool, type PolicyConfig } from '../domain/policy/index.js'
import { registerPolicyTools } from './policy-tools.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    actionPolicy: ActionPolicyService
  }
}

export class ActionPolicyService extends Service {
  constructor(ctx: Context, readonly policy: PolicyService) {
    super(ctx, 'actionPolicy')
  }
}

export interface PolicyPluginConfig {
  config?: PolicyConfig
}

export const name = 'dsh-assistant-policy'
export const inject = ['systemPrompt', 'tools', 'integrations']

export async function apply(ctx: Context, config: PolicyPluginConfig = {}) {
  const policy = new PolicyService(config.config ?? EXAMPLE_PERSONAL_POLICY)
  const hub = ctx.integrations.hub
  policy.registerExecutor('calendar', 'create_event', (payload, signal) => hub.calendar().createEvent({
    title: String(payload.title ?? ''),
    start: String(payload.start ?? ''),
    end: String(payload.end ?? ''),
    timeZone: typeof payload.timeZone === 'string' ? payload.timeZone : undefined,
    calendarId: typeof payload.calendarId === 'string' ? payload.calendarId : undefined,
    description: typeof payload.description === 'string' ? payload.description : undefined,
    attendees: Array.isArray(payload.attendees) ? payload.attendees.map((item) => String(item)) : undefined,
    allDay: payload.allDay === true,
    idempotencyKey: typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey : undefined,
  }, signal))
  policy.registerExecutor('tasks', 'create', (payload, signal) => hub.tasks().createTask({
    title: String(payload.title ?? ''),
  }, signal))
  policy.registerExecutor('files', 'write', (payload) => hub.files().writeText({
    root: '',
    path: String(payload.path ?? ''),
    content: String(payload.content ?? ''),
  }))
  policy.registerExecutor('files', 'delete', (payload, signal) => hub.files().deleteFile(String(payload.id ?? ''), signal))

  await ctx.plugin(class extends ActionPolicyService {
    constructor(scope: Context) {
      super(scope, policy)
    }
  })
  ctx.systemPrompt.section({
    name: 'product:policy',
    order: 45,
    text: 'Read and propose tools may run. Execute tools require policy: L3 may auto-run when configured; L2/L4 return a pending confirmation bound to the exact action. confirm_action is the only grant path. A model request is not authorization.',
  })
  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    const request = requestFromTool(exec.name, (exec.arguments ?? {}) as Record<string, unknown>, exec.signal)
    if (!request) return next()
    const decision = policy.decide(request)
    if (decision.kind === 'deny') return { kind: 'deny', reason: decision.reason }
    return next()
  }))
  ctx.effect(() => registerPolicyTools(ctx.tools, policy))
}
