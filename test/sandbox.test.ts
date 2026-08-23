import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { CallId } from '@deepseek-ai/dsh-llm'
import { createSandboxFilesProvider } from '../src/adapters/integrations/sandbox-files.js'
import { createSandboxTasksProvider } from '../src/adapters/integrations/sandbox-tasks.js'
import { IntegrationError } from '../src/domain/integrations/types.js'
import { expandUserPath, inspectSandboxRoot } from '../src/domain/files/sandbox-root.js'
import { sandboxDiagnosis } from '../src/product/doctor.js'
import { bootAssistantControl } from '../src/runtime/boot.js'

function isolatedSandbox(): string {
  return mkdtempSync(path.join(tmpdir(), 'tars-ng-sandbox-'))
}

describe('operator sandbox root', () => {
  it('expands ~ and requires an existing non-symlink directory', () => {
    const dir = isolatedSandbox()
    assert.equal(expandUserPath('~/tars-ng'), path.join(os.homedir(), 'tars-ng'))
    assert.equal(inspectSandboxRoot(undefined).configured, false)
    assert.equal(inspectSandboxRoot('').configured, false)
    assert.equal(inspectSandboxRoot(path.join(dir, 'missing')).ok, false)
    writeFileSync(path.join(dir, 'file'), 'nope\n')
    assert.equal(inspectSandboxRoot(path.join(dir, 'file')).ok, false)
    const link = path.join(dir, 'link')
    symlinkSync(dir, link)
    assert.equal(inspectSandboxRoot(link).ok, false)
    const ok = inspectSandboxRoot(dir)
    assert.equal(ok.configured, true)
    assert.equal(ok.configured && ok.ok && ok.root, realpathSync(dir))
  })

  it('keeps files and tasks unavailable in product mode without a sandbox root', async () => {
    const previous = process.env.DSH_ASSISTANT_SANDBOX_ROOT
    delete process.env.DSH_ASSISTANT_SANDBOX_ROOT
    const { ctx } = await bootAssistantControl({ allowFixtures: false })
    try {
      const status = await ctx.tools.execute({
        callId: CallId('sandbox-unavail'),
        name: 'integration_status',
        arguments: {},
        signal: AbortSignal.timeout(5000),
      })
      const body = JSON.parse(String(status.value)) as {
        status?: { files?: { available?: boolean; reason?: string }; tasks?: { available?: boolean } }
      }
      assert.equal(body.status?.files?.available, false)
      assert.equal(body.status?.tasks?.available, false)
      assert.match(String(status.value), /not configured/)
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env.DSH_ASSISTANT_SANDBOX_ROOT
      else process.env.DSH_ASSISTANT_SANDBOX_ROOT = previous
    }
  })

  it('keeps files and tasks inside the sandbox root', async () => {
    const root = isolatedSandbox()
    const files = createSandboxFilesProvider(root)
    const tasks = createSandboxTasksProvider(root)
    await files.writeText({ root: '/tmp', path: 'notes/hello.md', content: 'hi\n' })
    assert.equal(await files.readText({ root: '/etc', path: 'notes/hello.md' }), 'hi\n')
    assert.deepEqual((await files.listFiles({})).items.map((item) => item.id), ['notes/hello.md'])
    await assert.rejects(
      () => files.readText({ root, path: '../secret.md' }),
      (error: unknown) => error instanceof IntegrationError && error.code === 'invalid_request',
    )
    await assert.rejects(
      () => files.readText({ root, path: '/etc/passwd' }),
      (error: unknown) => error instanceof IntegrationError && error.code === 'invalid_request',
    )
    const created = await tasks.createTask({ title: 'Call mom' })
    assert.equal(created.id, 'tasks/call-mom.md')
    assert.match(readFileSync(path.join(root, 'tasks', 'call-mom.md'), 'utf8'), /# Call mom/)
    assert.equal((await tasks.listTasks({})).items[0]?.title, 'Call mom')
    const proposal = await tasks.proposeCreateTask({ title: 'Not written' })
    assert.equal(proposal.trust, 'propose')
    assert.equal((await tasks.listTasks({})).items.length, 1)
    await files.deleteFile('notes/hello.md')
    assert.equal((await files.listFiles({})).items.some((item) => item.id === 'notes/hello.md'), false)
  })

  it('reports live sandbox in doctor when the root exists', () => {
    const previous = process.env.DSH_ASSISTANT_SANDBOX_ROOT
    const root = isolatedSandbox()
    try {
      delete process.env.DSH_ASSISTANT_SANDBOX_ROOT
      assert.equal(sandboxDiagnosis(false).mode, 'unavailable')
      process.env.DSH_ASSISTANT_SANDBOX_ROOT = root
      const live = sandboxDiagnosis(false)
      assert.equal(live.mode, 'live')
      assert.match(live.note, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    } finally {
      if (previous === undefined) delete process.env.DSH_ASSISTANT_SANDBOX_ROOT
      else process.env.DSH_ASSISTANT_SANDBOX_ROOT = previous
    }
  })

  it('wires files and tasks through the hub when the sandbox root is set', async () => {
    const previous = process.env.DSH_ASSISTANT_SANDBOX_ROOT
    const root = isolatedSandbox()
    mkdirSync(path.join(root, 'notes'), { recursive: true })
    writeFileSync(path.join(root, 'notes', 'seed.md'), 'seed\n')
    process.env.DSH_ASSISTANT_SANDBOX_ROOT = root
    const { ctx } = await bootAssistantControl({ allowFixtures: false })
    try {
      const status = await ctx.tools.execute({
        callId: CallId('sandbox-status'),
        name: 'integration_status',
        arguments: {},
        signal: AbortSignal.timeout(5000),
      })
      const body = JSON.parse(String(status.value)) as {
        status?: { files?: { available?: boolean }; tasks?: { available?: boolean } }
      }
      assert.equal(body.status?.files?.available, true)
      assert.equal(body.status?.tasks?.available, true)

      const listed = await ctx.tools.execute({
        callId: CallId('sandbox-list'),
        name: 'files_list',
        arguments: {},
        signal: AbortSignal.timeout(5000),
      })
      assert.match(String(listed.value), /notes\/seed\.md/)

      const created = await ctx.tools.execute({
        callId: CallId('sandbox-task'),
        name: 'tasks_create',
        arguments: { title: 'Sandbox task' },
        signal: AbortSignal.timeout(5000),
      })
      assert.equal(JSON.parse(String(created.value)).kind, 'allow')
      assert.match(readFileSync(path.join(root, 'tasks', 'sandbox-task.md'), 'utf8'), /Sandbox task/)

      const pending = await ctx.tools.execute({
        callId: CallId('sandbox-write'),
        name: 'files_write',
        arguments: { path: 'notes/new.md', content: 'written\n' },
        signal: AbortSignal.timeout(5000),
      })
      const pendingBody = JSON.parse(String(pending.value)) as { kind?: string; confirmationId?: string }
      assert.equal(pendingBody.kind, 'pending_confirmation')
      const approved = await ctx.tools.execute({
        callId: CallId('sandbox-write-approve'),
        name: 'confirm_action',
        arguments: { confirmationId: pendingBody.confirmationId, decision: 'approve' },
        signal: AbortSignal.timeout(5000),
      })
      assert.equal(JSON.parse(String(approved.value)).kind, 'allow')
      assert.equal(readFileSync(path.join(root, 'notes', 'new.md'), 'utf8'), 'written\n')

      const escaped = await ctx.tools.execute({
        callId: CallId('sandbox-escape'),
        name: 'files_read',
        arguments: { path: '../secret.md' },
        signal: AbortSignal.timeout(5000),
      })
      const escapedBody = JSON.parse(String(escaped.value)) as { error?: { code?: string } }
      assert.equal(escapedBody.error?.code, 'invalid_request')
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env.DSH_ASSISTANT_SANDBOX_ROOT
      else process.env.DSH_ASSISTANT_SANDBOX_ROOT = previous
    }
  })
})
