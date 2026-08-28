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

  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'create_goal' || exec.name === 'update_goal') {
      const requested = (exec.arguments as Record<string, unknown> | undefined)?.max_goal_rounds
      if (typeof requested === 'number' && requested > MAX_AUTONOMOUS_GOAL_ROUNDS) {
        return {
          kind: 'deny',
          reason: `TARS-NG limits autonomous goals to ${MAX_AUTONOMOUS_GOAL_ROUNDS} rounds`,
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
