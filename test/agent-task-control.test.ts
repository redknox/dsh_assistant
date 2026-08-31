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
      assert.ok(control.ctx.get('planMode'))
      assert.ok(control.ctx.get('userQuestions'))

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
      assert.equal(view.taskControl?.plan.active, false)

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
      assert.equal(control.ctx.get('planMode'), undefined)
      assert.equal(control.ctx.get('userQuestions'), undefined)
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

  it('enforces Plan Mode as read-only and requires an active Goal to pause first', async () => {
    const control = await bootAssistantControl()
    const handle = await createAssistantAgent(control.ctx, 'plan-enforcement')
    const surface = new AssistantControlSurface(control.ctx, 'plan-enforcement')
    try {
      const goal = control.ctx.goals.create(handle.agent, { objective: 'Implement after planning' })
      assert.throws(() => surface.controlPlan(true), /pause the active Goal/)
      const paused = control.ctx.goals.pause(handle.agent, { id: goal.id, revision: goal.revision })
      assert.equal(surface.controlPlan(true).taskControl?.plan.active, true)

      const inspected = await control.ctx.tools.execute({
        callId: CallId('plan-read-allowed'),
        name: 'integration_status',
        arguments: {},
        agent: handle.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(inspected.isError, false)

      const denied = await control.ctx.tools.execute({
        callId: CallId('plan-write-denied'),
        name: 'files_write',
        arguments: { path: 'forbidden.md', content: 'must not run' },
        agent: handle.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(denied.isError, true)
      assert.match(denied.error?.message ?? '', /unavailable while Plan Mode is read-only/)

      assert.equal(surface.controlPlan(false).taskControl?.plan.active, false)
      assert.equal(control.ctx.goals.get(handle.agent)?.revision, paused.revision)
    } finally {
      await handle.dispose()
      await control.ctx.fiber.dispose()
    }
  })

  it('projects and resolves a pending plan-review question only in its owning session', async () => {
    const control = await bootAssistantControl()
    const first = await createAssistantAgent(control.ctx, 'question-first')
    const second = await createAssistantAgent(control.ctx, 'question-second')
    try {
      const answer = control.ctx.userQuestions.ask({
        agent: first.agent,
        questions: [{
          id: 'plan-review',
          header: 'Plan review',
          question: 'Approve this plan?',
          detail: '# Safe plan\n\n1. Inspect\n2. Apply',
          options: [{ label: 'Approve' }, { label: 'Keep planning' }],
          intent: { kind: 'plan-review', approve: 'Approve' },
        }],
      })
      const firstSurface = new AssistantControlSurface(control.ctx, 'question-first')
      const question = firstSurface.workspace().taskControl?.question
      assert.equal(question?.question, 'Approve this plan?')
      assert.equal(new AssistantControlSurface(control.ctx, 'question-second').workspace().taskControl?.question, undefined)
      firstSurface.answerTaskQuestion(question!.id, 'Approve')
      assert.deepEqual(await answer, { answers: [{ id: 'plan-review', selected: ['Approve'] }] })
      assert.equal(firstSurface.workspace().taskControl?.question, undefined)
    } finally {
      await first.dispose()
      await second.dispose()
      await control.ctx.fiber.dispose()
    }
  })

  it('bridges native exit_plan_mode review through the Task Control question card', async () => {
    const control = await bootAssistantControl()
    const handle = await createAssistantAgent(control.ctx, 'native-plan-review')
    const surface = new AssistantControlSurface(control.ctx, 'native-plan-review')
    try {
      surface.controlPlan(true)
      const execution = control.ctx.tools.execute({
        callId: CallId('native-plan-review-call'),
        name: 'exit_plan_mode',
        arguments: { plan: '# Controlled change\n\n1. Inspect\n2. Implement\n3. Verify' },
        agent: handle.agent,
        signal: AbortSignal.timeout(5_000),
      })
      const question = await waitForQuestion(surface)
      assert.equal(question.header, 'Plan review')
      assert.match(question.detail ?? '', /# Controlled change/)
      assert.throws(() => surface.controlPlan(false), /answer the pending plan review/)
      surface.answerTaskQuestion(question.id, 'Approve')
      const result = await execution
      assert.equal(result.isError, false)
      assert.equal((result.value as { approved?: boolean }).approved, true)
      assert.deepEqual(control.ctx.planMode.get(handle.agent), { active: true, pending: false })
    } finally {
      await handle.dispose()
      await control.ctx.fiber.dispose()
    }
  })
})

async function waitForQuestion(surface: AssistantControlSurface) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const question = surface.workspace().taskControl?.question
    if (question) return question
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('question did not become visible')
}
