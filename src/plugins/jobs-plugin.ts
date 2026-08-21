import { Service, type Context } from '@deepseek-ai/cordis'
import {
  AssistantJobService,
  createFollowupTaskWorkflow,
  deleteFileWorkflow,
  morningBriefWorkflow,
} from '../domain/jobs/index.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    assistantJobs: AssistantJobsService
  }
}

export class AssistantJobsService extends Service {
  constructor(ctx: Context, readonly service: AssistantJobService) {
    super(ctx, 'assistantJobs')
  }
}

export interface JobsPluginConfig {
  now?: () => Date
}

export const name = 'dsh-assistant-jobs'
export const inject = ['jobs', 'systemPrompt', 'integrations', 'actionPolicy']

export async function apply(ctx: Context, config: JobsPluginConfig = {}) {
  ctx.effect(() => ctx.jobs.attachController('dsh-assistant'))
  const service = new AssistantJobService(ctx.jobs)
  service.register(morningBriefWorkflow(ctx.integrations.hub, ctx.get('personalKnowledge'), {
    now: config.now ?? (() => new Date()),
  }))
  service.register(createFollowupTaskWorkflow(ctx.actionPolicy.policy))
  service.register(deleteFileWorkflow(ctx.actionPolicy.policy))
  await ctx.plugin(class extends AssistantJobsService {
    constructor(scope: Context) {
      super(scope, service)
    }
  })
  ctx.systemPrompt.section({
    name: 'product:jobs',
    order: 50,
    text: 'Background assistant workflows run through ctx.jobs. They are process-local and use the same policy boundary as interactive tools. A job is not authorization for high-risk mutations.',
  })
}
