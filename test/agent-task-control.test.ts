import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CallId } from '@deepseek-ai/dsh-llm'
import { MAX_AUTONOMOUS_GOAL_ROUNDS } from '../src/product/agent-task-control.js'
import { bootAssistantControl, bootSafeModeRuntime, createAssistantAgent } from '../src/runtime/boot.js'
import { AssistantControlSurface } from '../src/ui/controller.js'

describe('Agent Task Control', () => {
  it('mounts bounded native Goal and Todo capabilities in the normal Profile', async () => {
    const control = await bootAssistantControl()
    const handle = await createAssistantAgent(control.ctx, 'task-control')
    try {
      assert.ok(control.ctx.get('goals'))
      assert.ok(control.ctx.tools.get('create_goal'))
      assert.ok(control.ctx.tools.get('update_goal'))
      assert.ok(control.ctx.tools.get('todo_write'))

      const overBudget = await control.ctx.tools.execute({
        callId: CallId('over-budget-goal'),
        name: 'create_goal',
        arguments: { objective: 'Run without a bound', max_goal_rounds: MAX_AUTONOMOUS_GOAL_ROUNDS + 1 },
        agent: handle.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(overBudget.isError, true)
      assert.match(overBudget.error?.message ?? '', /limits autonomous goals to 8 rounds/)

      const created = control.ctx.goals.create(handle.agent, { objective: 'Prepare the monthly review' })
      const paused = control.ctx.goals.pause(handle.agent, { id: created.id, revision: created.revision })
      handle.agent.session.append('todo/write', {
        todos: [
          { content: 'Collect evidence', status: 'completed' },
          { content: 'Write review', status: 'in_progress' },
        ],
      })

      const view = new AssistantControlSurface(control.ctx, 'task-control').workspace()
      assert.equal(view.taskControl?.driver, 'active')
      assert.equal(view.taskControl?.maxAutonomousRounds, MAX_AUTONOMOUS_GOAL_ROUNDS)
      assert.equal(view.taskControl?.goal?.objective, 'Prepare the monthly review')
      assert.equal(view.taskControl?.goal?.phase, 'paused')
      assert.equal(view.objective?.status, 'waiting')
      assert.deepEqual(view.taskControl?.todos.map((todo) => todo.status), ['completed', 'in_progress'])

      const resumedView = new AssistantControlSurface(control.ctx, 'task-control')
        .controlGoal('resume', String(paused.id), paused.revision)
      assert.equal(resumedView.taskControl?.goal?.phase, 'active')
      assert.equal(resumedView.taskControl?.goal?.activation, 'armed')
    } finally {
      control.ctx.goals.disarm(handle.agent)
      await handle.dispose()
      await control.ctx.fiber.dispose()
    }
  })

  it('keeps task-control services and projections out of Safe Mode', async () => {
    const control = await bootSafeModeRuntime()
    try {
      assert.equal(control.ctx.get('goals'), undefined)
      assert.equal(control.ctx.tools.get('create_goal'), undefined)
      assert.equal(control.ctx.tools.get('todo_write'), undefined)
      assert.equal(new AssistantControlSurface(control.ctx, 'missing').workspace().taskControl, undefined)
    } finally {
      await control.ctx.fiber.dispose()
    }
  })

  it('isolates Goal and Todo projections by current session', async () => {
    const control = await bootAssistantControl()
    const first = await createAssistantAgent(control.ctx, 'task-first')
    const second = await createAssistantAgent(control.ctx, 'task-second')
    try {
      const goal = control.ctx.goals.create(first.agent, { objective: 'First session only' })
      control.ctx.goals.pause(first.agent, { id: goal.id, revision: goal.revision })
      first.agent.session.append('todo/write', { todos: [{ content: 'Private first-session task', status: 'pending' }] })

      const surface = new AssistantControlSurface(control.ctx, 'task-first')
      assert.equal(surface.workspace().taskControl?.goal?.objective, 'First session only')
      surface.setSessionId('task-second')
      assert.equal(surface.workspace().taskControl?.goal, undefined)
      assert.deepEqual(surface.workspace().taskControl?.todos, [])
    } finally {
      await first.dispose()
      await second.dispose()
      await control.ctx.fiber.dispose()
    }
  })
})
