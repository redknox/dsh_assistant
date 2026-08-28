import type { Context } from '@deepseek-ai/cordis'
import GoalService, { type GoalView } from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as ToolGoal from '@deepseek-ai/dsh-tool-goal'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import type { AgentTaskControlView } from '../domain/workspace/types.js'

export const MAX_AUTONOMOUS_GOAL_ROUNDS = 8

/** Mount native DSH task state behind product-owned safety bounds. */
export async function mountAgentTaskControl(ctx: Context): Promise<void> {
  await ctx.plugin(GoalService, { defaultMaxGoalRounds: MAX_AUTONOMOUS_GOAL_ROUNDS })
  await ctx.plugin(GoalRoundDriver)
  await ctx.plugin(ToolGoal, { blockedAfterConsecutiveRounds: 3 })
  await ctx.plugin(ToolTodo, { allowParallelInProgress: false })

  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'create_goal' && exec.name !== 'update_goal') return next()
    const requested = (exec.arguments as Record<string, unknown> | undefined)?.max_goal_rounds
    if (typeof requested === 'number' && requested > MAX_AUTONOMOUS_GOAL_ROUNDS) {
      return {
        kind: 'deny',
        reason: `TARS-NG limits autonomous goals to ${MAX_AUTONOMOUS_GOAL_ROUNDS} rounds`,
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
  return {
    maxAutonomousRounds: MAX_AUTONOMOUS_GOAL_ROUNDS,
    driver: [...ctx.registry.values()].some((runtime) => runtime.name === 'goal-round-driver') ? 'active' : 'held',
    ...(goal ? { goal: goalView(goal) } : {}),
    todos: Array.isArray(todos) ? todos.map((todo) => ({ ...todo })) : [],
  }
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
