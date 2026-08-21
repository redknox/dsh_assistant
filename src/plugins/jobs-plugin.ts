import { Service, type Context } from '@deepseek-ai/cordis'
import { FakeClock, IntervalScheduler, type Clock } from '../adapters/jobs/interval-scheduler.js'
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
  constructor(
    ctx: Context,
    readonly service: AssistantJobService,
    readonly scheduler: IntervalScheduler,
  ) {
    super(ctx, 'assistantJobs')
  }
}

export interface JobsPluginConfig {
  now?: () => Date
  clock?: Clock
  morningBriefEveryMs?: number
  /** Process-local poll interval. Tests pass `null` and advance a fake clock instead. */
  autoTickMs?: number | null
}

const DAY_MS = 24 * 60 * 60 * 1000

export const name = 'dsh-assistant-jobs'
export const inject = ['jobs', 'systemPrompt', 'integrations', 'actionPolicy']

export async function apply(ctx: Context, config: JobsPluginConfig = {}) {
  ctx.effect(() => ctx.jobs.attachController('dsh-assistant'))
  const service = new AssistantJobService(ctx.jobs)
  const clock = config.clock ?? { now: () => Date.now() }
  const scheduler = new IntervalScheduler(clock, (name) => {
    service.start(name)
  })
  const morning = morningBriefWorkflow(ctx.integrations.hub, ctx.get('personalKnowledge'), {
    now: config.now ?? (() => new Date()),
  })
  const everyMs = config.morningBriefEveryMs
    ?? (morning.schedule.kind === 'every' ? morning.schedule.everyMs : DAY_MS)
  service.register({ ...morning, schedule: { kind: 'every', everyMs } })
  scheduler.scheduleEvery('morning-brief', everyMs)
  service.register(createFollowupTaskWorkflow(ctx.actionPolicy.policy))
  service.register(deleteFileWorkflow(ctx.actionPolicy.policy))
  await ctx.plugin(class extends AssistantJobsService {
    constructor(scope: Context) {
      super(scope, service, scheduler)
    }
  })
  if (config.autoTickMs !== null) {
    const period = config.autoTickMs ?? 1000
    ctx.effect(() => {
      const timer = setInterval(() => scheduler.tick(), period)
      return () => clearInterval(timer)
    })
  }
  ctx.systemPrompt.section({
    name: 'product:jobs',
    order: 50,
    text: 'Background assistant workflows run through ctx.jobs. Recurring work is triggered by a process-local interval scheduler, not a durable calendar. A job is not authorization for high-risk mutations.',
  })
}
