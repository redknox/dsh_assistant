import type { Context } from '@deepseek-ai/cordis'
import GoalService, { type GoalView } from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as ToolGoal from '@deepseek-ai/dsh-tool-goal'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import UserQuestionService, {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type { AgentTaskControlView } from '../domain/workspace/types.js'

export const MAX_AUTONOMOUS_GOAL_ROUNDS = 8

const DELIVERY_GOAL_CONTEXT_ORDER = 20

const PLAN_READ_TOOLS = new Set([
  'exit_plan_mode',
  'todo_write',
  'get_goal',
  'list_capabilities',
  'lookup_capability',
  'review_capability_resolution',
  'inspect_extension_governance',
  'recall_memory',
  'retrieve_knowledge',
  'calendar_list_events',
  'calendar_get_event',
  'calendar_freebusy',
  'mail_list_messages',
  'mail_get_message',
  'contacts_search',
  'files_list',
  'files_read',
  'read',
  'read_image',
  'glob',
  'grep',
  'list_registered_workflows',
  'job_list',
  'job_output',
  'web_search',
  'integration_status',
  'meeting_get_artifacts',
  'meeting_read_ai_notes',
  'inspect_authoring_contract',
  'list_workbench',
  'inspect_validation_diagnostics',
  'inspect_candidate',
  'inspect_candidate_review',
  'list_candidate_files',
  'read_candidate_file',
  'inspect_skill',
  'list_skill_files',
  'read_skill_file',
  'skill',
])

interface PendingQuestion {
  readonly id: string
  readonly agent: Agent
  readonly request: AskUserQuestionRequest
  readonly resolve: (answer: AskUserQuestionAnswer) => void
  readonly reject: (error: Error) => void
  readonly removeAbort?: () => void
}

class ProductQuestionBroker {
  private serial = 0
  private readonly pending = new Map<string, PendingQuestion>()

  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    const agent = request.agent
    if (!agent) throw new UserQuestionError('TARS-NG questions require an owning session', 'CALLER_NOT_LIVE')
    if (request.questions.length !== 1) {
      throw new UserQuestionError('TARS-NG currently presents one question at a time', 'MULTIPLE_QUESTIONS_UNSUPPORTED')
    }
    if ([...this.pending.values()].some((item) => item.agent === agent)) {
      throw new UserQuestionError('this session already has a pending question', 'QUESTION_PENDING')
    }
    const id = `question-${++this.serial}`
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id)
        reject(new UserQuestionError('the question was cancelled with its owning step', 'ASK_CANCELLED'))
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        id,
        agent,
        request,
        resolve,
        reject,
        ...(request.signal ? { removeAbort: () => request.signal!.removeEventListener('abort', onAbort) } : {}),
      })
    })
  }

  inspect(agent: Agent): AgentTaskControlView['question'] {
    const pending = [...this.pending.values()].find((item) => item.agent === agent)
    const question = pending?.request.questions[0]
    if (!pending || !question) return undefined
    return {
      id: pending.id,
      ...(question.header ? { header: question.header } : {}),
      question: question.question,
      ...(question.detail ? { detail: question.detail } : {}),
      options: (question.options ?? []).map((option) => ({ ...option })),
    }
  }

  answer(agent: Agent, id: string, selected: string, custom?: string): void {
    const pending = this.pending.get(id)
    if (!pending || pending.agent !== agent) throw new Error('question is stale or belongs to another session')
    const question = pending.request.questions[0]
    if (!question || !(question.options ?? []).some((option) => option.label === selected)) {
      throw new Error('question answer is not one of the offered options')
    }
    this.pending.delete(id)
    pending.removeAbort?.()
    pending.resolve({
      answers: [{ id: question.id, selected: [selected], ...(custom?.trim() ? { custom: custom.trim() } : {}) }],
    })
  }

  dispose(): void {
    for (const item of this.pending.values()) {
      item.removeAbort?.()
      item.reject(new UserQuestionError('TARS-NG question channel stopped', 'ASK_CANCELLED'))
    }
    this.pending.clear()
  }
}

const questionBrokers = new WeakMap<Context, ProductQuestionBroker>()

/** Mount native DSH task state behind product-owned safety bounds. */
export async function mountAgentTaskControl(ctx: Context): Promise<void> {
  await ctx.plugin(GoalService, { defaultMaxGoalRounds: MAX_AUTONOMOUS_GOAL_ROUNDS })
  await ctx.plugin(GoalRoundDriver)
  await ctx.plugin(ToolGoal, { blockedAfterConsecutiveRounds: 3 })
  await ctx.plugin(ToolTodo, { allowParallelInProgress: false })
  await ctx.plugin(UserQuestionService)
  const questions = new ProductQuestionBroker()
  questionBrokers.set(ctx, questions)
  ctx.userQuestions.registerProvider({ ask: (request) => questions.ask(request) })
  ctx.effect(() => () => {
    questionBrokers.delete(ctx)
    questions.dispose()
  })
  await ctx.plugin(PlanModeController, {
    section: 'Plan Mode is read-only exploration. Inspect current state, maintain todo_write, and present the complete plan through exit_plan_mode. Do not claim that changes were executed. TARS-NG enforces this restriction at tool dispatch.',
  })

  ctx.systemPrompt.context({
    name: 'product:session-work-context',
    order: DELIVERY_GOAL_CONTEXT_ORDER,
    text: ({ agent }) => renderSessionWorkContext(ctx, agent),
  })

  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'create_goal' || exec.name === 'update_goal') {
      const args = exec.arguments as Record<string, unknown> | undefined
      const requested = args?.max_goal_rounds
      if (typeof requested === 'number' && requested > MAX_AUTONOMOUS_GOAL_ROUNDS) {
        return {
          kind: 'deny',
          reason: `TARS-NG limits autonomous goals to ${MAX_AUTONOMOUS_GOAL_ROUNDS} rounds`,
        }
      }
      if (exec.name === 'update_goal' && args?.action === 'complete' && exec.agent) {
        const delivery = ctx.get('candidateWorkbench')?.inspectDeliverySession(String(exec.agent.id))
        if (delivery && delivery.status !== 'complete') {
          return {
            kind: 'deny',
            reason: `Capability delivery cannot complete its Goal while stage ${delivery.stage} is ${delivery.status}`,
          }
        }
      }
    }
    if (exec.agent) {
      const plan = ctx.planMode.get(exec.agent)
      const enforced = plan.pending ?? plan.active
      if (enforced && !PLAN_READ_TOOLS.has(exec.name)) {
        return { kind: 'deny', reason: `tool ${exec.name} is unavailable while Plan Mode is read-only` }
      }
    }
    return next()
  }))

  ctx.effect(() => ctx.on('tools/result', (exec, result) => {
    // A human-authorized resume must survive its own tool result so the current
    // turn can cross the decision point. The next delivery mutation reconciles again.
    if (exec.agent && exec.name !== 'update_goal' && !result.isError) reconcileDeliveryGoal(ctx, exec.agent)
  }))
}

/** Create the durable native Goal that owns one dedicated delivery Session. */
export function createSessionGoal(ctx: Context, agent: Agent, objective: string): GoalView {
  if (!ctx.get('goals')) throw new Error('Goal control is unavailable')
  const current = ctx.goals.get(agent)
  if (current && current.phase !== 'complete') {
    if (current.objective === objective) return current
    throw new Error('the delivery Session already has a different active Goal')
  }
  return ctx.goals.create(agent, { objective, maxGoalRounds: MAX_AUTONOMOUS_GOAL_ROUNDS })
}

/** Settle or hold a delivery Goal from authoritative Workbench state. */
export function reconcileDeliveryGoal(ctx: Context, agent: Agent): GoalView | undefined {
  const goal = ctx.get('goals')?.get(agent)
  const delivery = ctx.get('candidateWorkbench')?.inspectDeliverySession(String(agent.id))
  if (!goal || !delivery || goal.phase === 'complete') return goal
  const ref = { id: goal.id, revision: goal.revision }
  if (delivery.status === 'complete') return ctx.goals.complete(agent, ref)
  if (delivery.status === 'blocked' && goal.phase !== 'blocked') {
    return ctx.goals.block(agent, ref, {
      code: 'capability-delivery-blocked',
      message: `Capability delivery is blocked at ${delivery.stage}.`,
    })
  }
  if (delivery.status === 'waiting' && goal.phase === 'active') return ctx.goals.pause(agent, ref)
  return goal
}

/** Browser-safe current-session task projection. */
export function inspectAgentTaskControl(ctx: Context, agent: Agent | undefined): AgentTaskControlView | undefined {
  if (!agent || !ctx.get('goals')) return undefined
  const goal = ctx.goals.get(agent)
  const todos = ctx.get('sessionProjections')?.snapshot(agent.session).values.todos
  const plan = ctx.get('planMode')?.get(agent) ?? { active: false }
  const question = questionBrokers.get(ctx)?.inspect(agent)
  return {
    maxAutonomousRounds: MAX_AUTONOMOUS_GOAL_ROUNDS,
    driver: [...ctx.registry.values()].some((runtime) => runtime.name === 'goal-round-driver') ? 'active' : 'held',
    ...(goal ? { goal: goalView(goal) } : {}),
    todos: Array.isArray(todos) ? todos.map((todo) => ({ ...todo })) : [],
    plan,
    ...(question ? { question } : {}),
  }
}

function renderSessionWorkContext(ctx: Context, agent: Agent | undefined): string {
  if (!agent || !ctx.get('goals')) return ''
  const goal = ctx.goals.get(agent)
  if (!goal) return ''
  const delivery = ctx.get('candidateWorkbench')?.inspectDeliverySession(String(agent.id))
  const lines = [
    '<session_work_context>',
    `Objective: ${JSON.stringify(goal.objective)}`,
    `Goal: ${goal.phase}; round ${goal.roundsStarted}/${goal.maxGoalRounds}.`,
  ]
  if (delivery) {
    lines.push(`Capability: ${JSON.stringify(delivery.capability)}.`)
    if (delivery.objective !== goal.objective) lines.push(`Current capability specification objective: ${JSON.stringify(delivery.objective)}.`)
    lines.push(`Delivery: ${delivery.stage}; ${delivery.status}.`)
    lines.push('The Workbench lifecycle is authoritative. Do not skip validation, review, approval, or activation, and do not mark this Goal complete before delivery is live or stopped.')
  }
  lines.push('Choose the next useful step dynamically from current evidence; this context is an objective, not a fixed Workflow.')
  lines.push('</session_work_context>')
  return lines.join('\n')
}

export function controlPlanMode(ctx: Context, agent: Agent, active: boolean): void {
  if (!ctx.get('planMode')) throw new Error('Plan Mode is unavailable')
  if (!active && questionBrokers.get(ctx)?.inspect(agent)) throw new Error('answer the pending plan review before leaving Plan Mode')
  const goal = ctx.goals.get(agent)
  if (active && goal?.phase === 'active') throw new Error('pause the active Goal before entering Plan Mode')
  ctx.planMode.set(agent, active)
}

export function answerTaskQuestion(ctx: Context, agent: Agent, id: string, selected: string, custom?: string): void {
  const broker = questionBrokers.get(ctx)
  if (!broker) throw new Error('question channel is unavailable')
  broker.answer(agent, id, selected, custom)
}

function goalView(goal: GoalView): NonNullable<AgentTaskControlView['goal']> {
  return {
    id: String(goal.id),
    revision: goal.revision,
    objective: goal.objective,
    phase: goal.phase,
    roundsStarted: goal.roundsStarted,
    maxGoalRounds: goal.maxGoalRounds,
    activation: goal.activation,
    ...(goal.blockedReason ? { blockedReason: goal.blockedReason.message } : {}),
  }
}
