import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { CallId } from '@deepseek-ai/dsh-llm'
import { bootAssistantControl, createAssistantAgent } from '../src/runtime/boot.js'
import { AssistantControlSurface } from '../src/ui/controller.js'

describe('bounded workbench', () => {
  it('binds native reads to the Files root instead of the session cwd', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tars-workbench-'))
    const other = mkdtempSync(path.join(os.tmpdir(), 'tars-session-cwd-'))
    writeFileSync(path.join(root, 'inside.md'), 'bounded content')
    writeFileSync(path.join(other, 'outside.md'), 'must stay private')
    const control = await bootAssistantControl({ allowFixtures: false, sandboxRoot: root })
    const handle = await createAssistantAgent(control.ctx, 'bounded-read', undefined, other)
    try {
      assert.equal(handle.agent.session.header.cwd, realpathSync(root))
      const read = await control.ctx.tools.execute({
        callId: CallId('bounded-read-inside'),
        name: 'read',
        arguments: { file_path: 'inside.md' },
        agent: handle.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(read.isError, false)
      assert.match(String(read.content?.[0]?.type === 'text' ? read.content[0].text : ''), /bounded content/)

      const escaped = await control.ctx.tools.execute({
        callId: CallId('bounded-read-outside'),
        name: 'read',
        arguments: { file_path: '../outside.md' },
        agent: handle.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(escaped.isError, true)
      assert.match(JSON.stringify(escaped), /path traversal is not allowed/)

      const glob = await control.ctx.tools.execute({
        callId: CallId('bounded-glob'),
        name: 'glob',
        arguments: { pattern: '*.md' },
        agent: handle.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(glob.isError, false)
      assert.match(JSON.stringify(glob), /inside\.md/)
      assert.doesNotMatch(JSON.stringify(glob), /outside\.md/)

      const escapedSearch = await control.ctx.tools.execute({
        callId: CallId('bounded-glob-outside'),
        name: 'glob',
        arguments: { pattern: '*.md', path: '../' },
        agent: handle.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(escapedSearch.isError, true)
      assert.match(JSON.stringify(escapedSearch), /must stay inside the configured Files workspace/)
    } finally {
      await handle.dispose()
      await control.ctx.fiber.dispose()
    }
  })

  it('requires one approval and an observed version before mutating', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tars-workbench-'))
    writeFileSync(path.join(root, 'note.md'), 'before')
    const control = await bootAssistantControl({ allowFixtures: false, sandboxRoot: root })
    const handle = await createAssistantAgent(control.ctx, 'bounded-edit')
    const surface = new AssistantControlSurface(control.ctx, 'bounded-edit')
    try {
      const unobserved = await control.ctx.tools.execute({
        callId: CallId('bounded-unobserved-edit'),
        name: 'edit',
        arguments: { file_path: 'note.md', old_string: 'before', new_string: 'after' },
        agent: handle.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(unobserved.isError, true)
      assert.match(JSON.stringify(unobserved), /read the file/i)

      await control.ctx.tools.execute({
        callId: CallId('bounded-observe'),
        name: 'read',
        arguments: { file_path: 'note.md' },
        agent: handle.agent,
        signal: AbortSignal.timeout(5_000),
      })

      handle.agent.session.append('turn/start', { turn: 0 })
      handle.agent.session.append('step/start', { turn: 0, step: 0 })
      writeFileSync(path.join(root, 'note.md'), 'changed externally')
      const staleExecution = control.ctx.tools.execute({
        callId: CallId('bounded-stale-edit'),
        name: 'edit',
        arguments: {
          file_path: 'note.md',
          old_string: 'before',
          new_string: 'must not win',
          sandbox_permissions: 'workspace-write',
          justification: 'Attempt an edit against the previously observed version.',
        },
        agent: handle.agent,
        signal: AbortSignal.timeout(5_000),
      })
      await surface.resolveApproval(await waitForApproval(surface), 'approve')
      const stale = await staleExecution
      assert.equal(stale.isError, true)
      assert.match(JSON.stringify(stale), /re-read the file/i)
      assert.equal(readFileSync(path.join(root, 'note.md'), 'utf8'), 'changed externally')

      await control.ctx.tools.execute({
        callId: CallId('bounded-reobserve'),
        name: 'read',
        arguments: { file_path: 'note.md' },
        agent: handle.agent,
        signal: AbortSignal.timeout(5_000),
      })
      const execution = control.ctx.tools.execute({
        callId: CallId('bounded-approved-edit'),
        name: 'edit',
        arguments: {
          file_path: 'note.md',
          old_string: 'changed externally',
          new_string: 'after',
          sandbox_permissions: 'workspace-write',
          justification: 'Update the observed note inside the configured Files workspace.',
        },
        agent: handle.agent,
        signal: AbortSignal.timeout(5_000),
      })
      const approval = await waitForApproval(surface)
      assert.equal(approval.target, 'edit')
      await surface.resolveApproval(approval, 'approve')
      const edited = await execution
      assert.equal(edited.isError, false)
      assert.equal(readFileSync(path.join(root, 'note.md'), 'utf8'), 'after')
    } finally {
      await handle.dispose()
      await control.ctx.fiber.dispose()
    }
  })

  it('keeps native discovery read-only while Plan Mode is active', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tars-workbench-'))
    writeFileSync(path.join(root, 'plan.md'), 'inspect only')
    const control = await bootAssistantControl({ allowFixtures: false, sandboxRoot: root })
    const handle = await createAssistantAgent(control.ctx, 'bounded-plan')
    const surface = new AssistantControlSurface(control.ctx, 'bounded-plan')
    try {
      surface.controlPlan(true)
      const search = await control.ctx.tools.execute({
        callId: CallId('bounded-plan-search'),
        name: 'grep',
        arguments: { pattern: 'inspect' },
        agent: handle.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(search.isError, false)

      const write = await control.ctx.tools.execute({
        callId: CallId('bounded-plan-write'),
        name: 'write',
        arguments: {
          file_path: 'forbidden.md',
          content: 'must not be written',
          sandbox_permissions: 'workspace-write',
          justification: 'This must still be blocked by Plan Mode.',
        },
        agent: handle.agent,
        signal: AbortSignal.timeout(5_000),
      })
      assert.equal(write.isError, true)
      assert.match(JSON.stringify(write), /unavailable while Plan Mode is read-only/)
      assert.equal(existsSync(path.join(root, 'forbidden.md')), false)
    } finally {
      await handle.dispose()
      await control.ctx.fiber.dispose()
    }
  })
})

async function waitForApproval(surface: AssistantControlSurface) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const card = surface.workspace().approvals.find((item) => item.kind === 'dsh-tool' && item.status === 'pending')
    if (card) return card
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('bounded workbench approval did not reach the workspace')
}
