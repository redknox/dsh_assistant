import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as assistantProduct from '../src/product/bundle.js'
import { PRODUCT_TOOL_NAMES } from '../src/product/bundle.js'
import { bootAssistantRuntime, createAssistantAgent } from '../src/runtime/boot.js'
import { withDshAssistantProfile } from './helpers/dsh-profile-loader.js'

const root = join(import.meta.dirname, '..')

async function bootHarness() {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

describe('product package and profile', () => {
  it('declares a DSH bundle and example profile for 0.1.0-rc.8', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      private: boolean
      engines: { node: string }
      dsh: { bundle: { patch: string } }
      files: string[]
      dependencies: Record<string, string>
    }
    assert.equal(pkg.private, true)
    assert.equal(pkg.engines.node, '>=22')
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
    assert.deepEqual(pkg.files, ['dist', 'cordis.patch.yml'])
    assert.equal(pkg.dependencies['@deepseek-ai/dsh-agent-loop'], '0.1.0-rc.8')
    assert.match(readFileSync(join(root, 'cordis.patch.yml'), 'utf8'), /id: dsh-assistant/)

    const profile = JSON.parse(readFileSync(join(root, 'profiles/assistant/package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    assert.deepEqual(profile.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-assistant'])
    assert.match(readFileSync(join(root, 'profiles/assistant/cordis.patch.yml'), 'utf8'), /^\[]\s*$/m)
  })

  it('remounts the product bundle without duplicate tools or leftover services', async () => {
    const ctx = await bootHarness()
    try {
      const first = await ctx.plugin(assistantProduct, { jobs: { autoTickMs: null } })
      for (const name of PRODUCT_TOOL_NAMES) assert.ok(ctx.tools.get(name), name)
      assert.ok(ctx.personalMemory)
      assert.ok(ctx.assistantJobs)
      const workflows = ctx.assistantJobs.service.list().map((item) => item.name).sort()
      assert.deepEqual(workflows, ['create-followup-task', 'delete-file', 'morning-brief'])

      await first.dispose()
      for (const name of PRODUCT_TOOL_NAMES) assert.equal(ctx.tools.get(name), undefined, name)
      assert.equal(ctx.get('personalMemory'), undefined)
      assert.equal(ctx.get('personalKnowledge'), undefined)
      assert.equal(ctx.get('actionPolicy'), undefined)
      assert.equal(ctx.get('assistantJobs'), undefined)

      const second = await ctx.plugin(assistantProduct, { jobs: { autoTickMs: null } })
      for (const name of PRODUCT_TOOL_NAMES) assert.ok(ctx.tools.get(name), name)
      assert.deepEqual(
        ctx.assistantJobs.service.list().map((item) => item.name).sort(),
        ['create-followup-task', 'delete-file', 'morning-brief'],
      )
      await second.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('boots, disposes, and boots again without leftover agents', async () => {
    const first = await bootAssistantRuntime()
    const handle = await createAssistantAgent(first, 'pack-remount')
    assert.ok(first.agents.get(handle.agent.id))
    await handle.dispose()
    await first.fiber.dispose()

    const second = await bootAssistantRuntime()
    assert.equal(second.agents.list().length, 0)
    const again = await createAssistantAgent(second, 'pack-remount')
    assert.equal(second.agents.list().length, 1)
    await again.dispose()
    await second.fiber.dispose()
  })

  it('loads the example profile through official DSH app-boot APIs', async () => {
    await withDshAssistantProfile(async ({ profile, dump, composedIds, bootProfile }) => {
      assert.deepEqual(
        profile.layers.map((layer) => layer.packageName),
        ['@deepseek-ai/dsh-base', 'dsh-assistant'],
      )
      assert.match(dump, /# == @deepseek-ai\/dsh-base/)
      assert.match(dump, /# == dsh-assistant/)
      assert.match(dump, /id: dsh-assistant/)
      assert.equal(composedIds.filter((id) => id === 'dsh-assistant').length, 1)
      assert.ok(composedIds.includes('agent'))
      assert.ok(composedIds.includes('system-prompt'))

      const first = await bootProfile()
      try {
        assert.ok(first.tools.get('remember_memory'), 'remember_memory')
        assert.ok(first.get('personalMemory'))
        assert.equal(
          first.assistantJobs.service.list().map((item: { name: string }) => item.name).sort().join(','),
          'create-followup-task,delete-file,morning-brief',
        )
      } finally {
        await first.fiber.dispose()
      }
      assert.equal(first.get('personalMemory'), undefined)
      assert.equal(first.get('assistantJobs'), undefined)

      const second = await bootProfile()
      try {
        assert.ok(second.tools.get('remember_memory'), 'remember_memory after remount')
        assert.ok(second.get('personalMemory'))
        const jobs = second.assistantJobs.service.list().map((item: { name: string }) => item.name)
        assert.equal(jobs.length, 3)
        assert.equal(new Set(jobs).size, 3)
      } finally {
        await second.fiber.dispose()
      }
    })
  })

  it('packs only the intended release files', () => {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: root,
      encoding: 'utf8',
    })
    const packed = JSON.parse(raw.slice(raw.indexOf('['))) as { files: { path: string }[] }[]
    const paths = packed[0]?.files.map((file) => file.path) ?? []
    assert.ok(paths.includes('README.md'))
    assert.ok(paths.includes('cordis.patch.yml'))
    assert.ok(paths.includes('package.json'))
    assert.ok(paths.some((path) => path === 'dist/index.js' || path.startsWith('dist/')))
    const forbidden = paths.filter((path) => (
      path.startsWith('src/')
      || path.startsWith('test/')
      || path.startsWith('fixtures/')
      || path.startsWith('docs/')
      || path.startsWith('profiles/')
      || path.startsWith('.env')
      || path.includes('credentials')
    ))
    assert.deepEqual(forbidden, [])
  })
})
