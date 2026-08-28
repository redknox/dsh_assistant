import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
import { SAFE_MODE_PROFILE_PATCH, withDshAssistantProfile } from './helpers/dsh-profile-loader.js'

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
      version: string
      private: boolean
      engines: { node: string }
      dsh: { bundle: { patch: string } }
      files: string[]
      bin?: Record<string, string>
      tarsNg?: { dsh: string }
      dependencies: Record<string, string>
    }
    assert.equal(pkg.version, '0.4.0')
    assert.equal(pkg.private, true)
    assert.equal(pkg.engines.node, '>=22')
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
    assert.equal(pkg.bin?.['tars-ng'], './dist/product/bin.js')
    assert.equal(pkg.tarsNg?.dsh, '0.1.0-rc.8')
    assert.deepEqual(pkg.files, ['dist', 'cordis.patch.yml', 'profiles/assistant', 'profiles/assistant-safe'])
    assert.equal(pkg.dependencies['@deepseek-ai/dsh-agent-loop'], '0.1.0-rc.8')
    assert.equal(pkg.dependencies['@deepseek-ai/dsh-llm-deepseek'], '0.1.0-rc.8')
    assert.equal(pkg.dependencies['@deepseek-ai/dsh-agent-default-model'], '0.1.0-rc.8')
    assert.equal(pkg.dependencies['@deepseek-ai/dsh-app-boot'], '0.1.0-rc.8')
    assert.equal(pkg.dependencies['@deepseek-ai/dsh-base'], '0.1.0-rc.8')
    assert.equal(pkg.dependencies['@deepseek-ai/dsh-token-meter'], '0.1.0-rc.8')
    assert.equal(pkg.dependencies['@deepseek-ai/dsh-compaction-basic'], '0.1.0-rc.8')
    assert.equal(pkg.dependencies['@deepseek-ai/dsh-output-retention'], '0.1.0-rc.8')
    assert.equal(pkg.dependencies['@deepseek-ai/dsh-spill-local'], '0.1.0-rc.8')
    assert.equal(pkg.dependencies['@deepseek-ai/dsh-spill-policy'], '0.1.0-rc.8')
    assert.equal(pkg.dependencies['@deepseek-ai/dsh-session-checkpoint-policy'], '0.1.0-rc.8')
    assert.match(readFileSync(join(root, 'cordis.patch.yml'), 'utf8'), /id: dsh-assistant/)

    const profile = JSON.parse(readFileSync(join(root, 'profiles/assistant/package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    assert.deepEqual(profile.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-assistant'])
    assert.match(readFileSync(join(root, 'profiles/assistant/cordis.patch.yml'), 'utf8'), /includeDefaultRoots: false/)
  })

  it('remounts the product bundle without duplicate tools or leftover services', async () => {
    const ctx = await bootHarness()
    try {
      const first = await ctx.plugin(assistantProduct, { jobs: { autoTickMs: null } })
      for (const name of PRODUCT_TOOL_NAMES) assert.ok(ctx.tools.get(name), name)
      assert.ok(ctx.personalMemory)
      assert.ok(ctx.capabilityRegistry)
      assert.ok(ctx.capabilityResolution)
      assert.ok(ctx.candidateWorkspace)
      assert.ok(ctx.candidateValidation)
      assert.ok(ctx.independentReview)
      assert.ok(ctx.tarsPersonality)
      assert.ok(ctx.extensionGovernance)
      assert.ok(ctx.extensionActivation)
      assert.ok(ctx.extensionRecovery)
      assert.ok(ctx.assistantJobs)
      const workflows = ctx.assistantJobs.service.list().map((item) => item.name).sort()
      assert.deepEqual(workflows, ['create-followup-task', 'delete-file', 'morning-brief'])

      await first.dispose()
      for (const name of PRODUCT_TOOL_NAMES) assert.equal(ctx.tools.get(name), undefined, name)
      assert.equal(ctx.get('personalMemory'), undefined)
      assert.equal(ctx.get('personalKnowledge'), undefined)
      assert.equal(ctx.get('actionPolicy'), undefined)
      assert.equal(ctx.get('assistantJobs'), undefined)
      assert.equal(ctx.get('capabilityRegistry'), undefined)
      assert.equal(ctx.get('capabilityResolution'), undefined)
      assert.equal(ctx.get('candidateWorkspace'), undefined)
      assert.equal(ctx.get('candidateValidation'), undefined)
      assert.equal(ctx.get('independentReview'), undefined)
      assert.equal(ctx.get('tarsPersonality'), undefined)
      assert.equal(ctx.get('extensionGovernance'), undefined)
      assert.equal(ctx.get('extensionActivation'), undefined)
      assert.equal(ctx.get('extensionRecovery'), undefined)

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

  it('loads the Safe Mode profile without optional integrations or jobs', async () => {
    await withDshAssistantProfile(async ({ bootProfile }) => {
      const ctx = await bootProfile()
      try {
        assert.ok(ctx.tools.get('inspect_extension_governance'))
        assert.ok(ctx.tools.get('list_capabilities'))
        assert.ok(ctx.capabilityRegistry)
        assert.ok(ctx.extensionRecovery)
        assert.ok(ctx.tarsPersonality)
        assert.equal(ctx.tools.get('calendar_list_events'), undefined)
        assert.equal(ctx.get('assistantJobs'), undefined)
        assert.equal(ctx.get('personalMemory'), undefined)
      } finally {
        await ctx.fiber.dispose()
      }
    }, { profileName: 'assistant-safe', patch: SAFE_MODE_PROFILE_PATCH })
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
    assert.ok(paths.some((item) => item === 'profiles/assistant/cordis.patch.yml' || item.startsWith('profiles/assistant/')))
    assert.ok(paths.some((item) => item === 'profiles/assistant-safe/cordis.patch.yml' || item.startsWith('profiles/assistant-safe/')))
    const forbidden = paths.filter((item) => {
      const profileOk = item === 'profiles/assistant'
        || item.startsWith('profiles/assistant/')
        || item === 'profiles/assistant-safe'
        || item.startsWith('profiles/assistant-safe/')
      return item.startsWith('src/')
        || item.startsWith('web/')
        || item.startsWith('test/')
        || item.startsWith('fixtures/')
        || item.startsWith('docs/')
        || (item.startsWith('profiles/') && !profileOk)
        || item.startsWith('self-extension/')
        || item.includes('authority.json')
        || item.includes('candidates/')
        || item.startsWith('.env')
        || item.includes('credentials')
        || item.includes('conversation-self-dev-adapter')
    })
    assert.deepEqual(forbidden, [])
  })

  it('installs the packed artifact and runs tars-ng without src or tsx', { timeout: 360_000 }, async () => {
    execFileSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf8' })
    const packDir = mkdtempSync(join(tmpdir(), 'tars-ng-pack-'))
    const packedName = execFileSync('npm', ['pack', '--pack-destination', packDir], { cwd: root, encoding: 'utf8' }).trim().split('\n').at(-1)
    assert.ok(packedName)
    const tarball = packedName.startsWith('/') ? packedName : join(packDir, packedName)
    assert.equal(existsSync(tarball), true)
    assert.match(packedName, /dsh-assistant-0\.4\.0\.tgz$/)

    const installDir = mkdtempSync(join(tmpdir(), 'tars-ng-install-'))
    execFileSync('npm', ['init', '-y'], { cwd: installDir, encoding: 'utf8' })
    execFileSync('npm', ['install', tarball, '--omit=dev'], {
      cwd: installDir,
      encoding: 'utf8',
      timeout: 180_000,
    })
    const pkgRoot = join(installDir, 'node_modules', 'dsh-assistant')
    assert.equal(existsSync(join(pkgRoot, 'src')), false)
    assert.equal(existsSync(join(pkgRoot, 'web')), false)
    assert.equal(existsSync(join(pkgRoot, 'dist', 'product', 'bin.js')), true)
    assert.equal(existsSync(join(pkgRoot, 'dist', 'web', 'index.html')), true)
    const installedPkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as { version: string }
    assert.equal(installedPkg.version, '0.4.0')
    const uiIndex = readFileSync(join(pkgRoot, 'dist', 'web', 'index.html'), 'utf8')
    assert.doesNotMatch(uiIndex, /\btsx\b/)
    assert.doesNotMatch(uiIndex, /@vitejs\/plugin-react/)
    const uiCss = readdirSync(join(pkgRoot, 'dist', 'web', 'assets')).find((name) => name.endsWith('.css'))
    assert.ok(uiCss)
    const packedCss = readFileSync(join(pkgRoot, 'dist', 'web', 'assets', uiCss), 'utf8')
    assert.match(packedCss, /--instrument-black/)
    assert.match(packedCss, /\.console/)
    assert.match(packedCss, /--signal-amber/)
    assert.match(packedCss, /--muted:\s*#4f4a40/)
    assert.match(packedCss, /--text-amber:\s*#7a4500/)
    const interLicense = readFileSync(join(pkgRoot, 'dist', 'web', 'licenses', 'Inter-OFL.txt'), 'utf8')
    const barlowLicense = readFileSync(join(pkgRoot, 'dist', 'web', 'licenses', 'Barlow-OFL.txt'), 'utf8')
    const zcoolLicense = readFileSync(join(pkgRoot, 'dist', 'web', 'licenses', 'ZCOOL-QingKe-HuangYou-OFL.txt'), 'utf8')
    assert.match(interLicense, /SIL Open Font License/)
    assert.match(interLicense, /Inter Project Authors/)
    assert.match(barlowLicense, /SIL Open Font License/)
    assert.match(barlowLicense, /Barlow Project Authors/)
    assert.match(zcoolLicense, /SIL Open Font License/)
    assert.match(zcoolLicense, /ZCOOL QingKe HuangYou Project Authors/)
    assert.equal(existsSync(join(installDir, 'node_modules', '@deepseek-ai', 'dsh-llm-deepseek')), true)
    assert.equal(existsSync(join(installDir, 'node_modules', '@deepseek-ai', 'dsh-agent-default-model')), true)
    const binSource = readFileSync(join(pkgRoot, 'dist', 'product', 'bin.js'), 'utf8')
    assert.match(binSource, /^#!\/usr\/bin\/env node/m)
    assert.doesNotMatch(binSource, /\btsx\b/)

    const userHome = mkdtempSync(join(tmpdir(), 'tars-ng-user-'))
    const productHome = mkdtempSync(join(tmpdir(), 'tars-ng-home-'))
    mkdirSync(join(productHome, 'config'), { recursive: true })
    writeFileSync(join(productHome, 'config', 'env'), 'DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN=ya29.installed-secret\n', { mode: 0o600 })
    chmodSync(join(productHome, 'config', 'env'), 0o600)
    assert.equal(productHome.startsWith(pkgRoot), false)

    const bin = join(installDir, 'node_modules', '.bin', 'tars-ng')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: userHome,
      XDG_CONFIG_HOME: join(userHome, '.config'),
      XDG_DATA_HOME: join(userHome, '.local', 'share'),
      TARS_NG_HOME: productHome,
      DSH_ASSISTANT_HOME: productHome,
    }
    delete env.DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN
    delete env.GOOGLE_SEARCH_API_KEY
    delete env.GOOGLE_SEARCH_ENGINE_ID
    delete env.TARS_NG_ALLOW_FIXTURES
    delete env.DEEPSEEK_API_KEY

    const doctor = execFileSync(bin, ['doctor', '--home', productHome], { encoding: 'utf8', env })
    assert.match(doctor, /TARS-NG 0\.4\.0/)
    assert.match(doctor, new RegExp(productHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(doctor, /DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN: present/)
    assert.match(doctor, /DEEPSEEK_API_KEY: missing/)
    assert.match(doctor, /GOOGLE_SEARCH_API_KEY: missing/)
    assert.match(doctor, /llm-provider: deepseek-official/)
    assert.match(doctor, /llm-model: deepseek-v4-flash/)
    assert.match(doctor, /llm-route: available/)
    assert.match(doctor, /ai-runtime: LLM not configured\/unavailable/)
    assert.doesNotMatch(doctor, /ya29\.installed-secret/)
    assert.doesNotMatch(doctor, /\btsx\b/)
    assert.doesNotMatch(doctor, /Team standup/)
    assert.match(doctor, /calendar: unavailable|calendar: live/)
    assert.match(doctor, /generated-runtime: (available|unavailable)/)
    assert.match(doctor, /isolation: /)
    assert.match(doctor, /active generated processes: /)

    const pidFile = join(productHome, 'state', 'tars-ng.pid')
    const failedOnce = spawnSync(bin, ['start', '--once', '--home', productHome], { encoding: 'utf8', env })
    const failedStart = spawnSync(bin, ['start', '--home', productHome], { encoding: 'utf8', env })
    const failedText = `${failedOnce.stdout}\n${failedOnce.stderr}\n${failedStart.stdout}\n${failedStart.stderr}`
    assert.notEqual(failedOnce.status, 0)
    assert.notEqual(failedStart.status, 0)
    assert.equal(existsSync(pidFile), false)
    assert.match(failedText, /LLM not configured\/unavailable/)
    assert.match(failedText, /missing DEEPSEEK_API_KEY/)
    assert.doesNotMatch(failedText, /TARS-NG is running/)
    assert.doesNotMatch(failedText, /ya29\.installed-secret/)

    writeFileSync(join(productHome, 'config', 'env'), 'DEEPSEEK_API_KEY=sk-offline-not-a-live-key\n', { mode: 0o600 })
    chmodSync(join(productHome, 'config', 'env'), 0o600)
    const withKey = execFileSync(bin, ['doctor', '--home', productHome], { encoding: 'utf8', env })
    assert.match(withKey, /DEEPSEEK_API_KEY: present/)
    assert.match(withKey, /llm-route: available/)
    assert.match(withKey, /ai-runtime: configured/)
    assert.doesNotMatch(withKey, /sk-offline-not-a-live-key/)

    const started = execFileSync(bin, ['start', '--once', '--home', productHome], { encoding: 'utf8', env })
    assert.match(started, /ai-runtime: configured/)
    assert.match(started, /llm-route: available/)
    assert.match(started, /TARS-NG 0\.4\.0/)
    assert.doesNotMatch(started, /LLM not configured\/unavailable/)
    assert.doesNotMatch(started, /sk-offline-not-a-live-key/)
    assert.doesNotMatch(started, /Web UI:/)
    assert.equal(existsSync(pidFile), false)

    mkdirSync(join(productHome, 'data'), { recursive: true })
    writeFileSync(join(productHome, 'data', 'soak-marker'), 'keep-across-reinstall\n')
    rmSync(pkgRoot, { recursive: true, force: true })
    execFileSync('npm', ['install', tarball, '--omit=dev'], {
      cwd: installDir,
      encoding: 'utf8',
      timeout: 180_000,
    })
    assert.equal(existsSync(join(pkgRoot, 'src')), false)
    assert.equal(existsSync(join(pkgRoot, 'dist', 'web', 'index.html')), true)
    assert.equal(existsSync(join(productHome, 'data', 'soak-marker')), true)
    assert.match(readFileSync(join(productHome, 'data', 'soak-marker'), 'utf8'), /keep-across-reinstall/)

    const uiEnv = { ...env, TARS_NG_UI_PORT: '0' }
    const child = spawn(bin, ['start', '--home', productHome], { encoding: 'utf8', env: uiEnv })
    const uiUrl = await new Promise<string>((resolve, reject) => {
      let buf = ''
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`start did not report Web UI\n${buf}`))
      }, 25_000)
      const onData = (chunk: string) => {
        buf += chunk
        const match = buf.match(/Web UI: (http:\/\/127\.0\.0\.1:\d+)/)
        if (match?.[1]) {
          clearTimeout(timer)
          resolve(match[1])
        }
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.on('error', reject)
    })
    try {
      const page = await fetch(uiUrl)
      assert.equal(page.status, 200)
      const html = await page.text()
      assert.match(html, /TARS-NG|root/)
      assert.doesNotMatch(html, /\bsrc\/product\b/)
      const snapshot = await fetch(`${uiUrl}/api/view`).then((res) => res.json()) as { view: { identity: string }; webUi: string }
      assert.equal(snapshot.view.identity, 'TARS-NG')
      assert.match(snapshot.webUi, /^http:\/\/127\.0\.0\.1:\d+$/)
      assert.doesNotMatch(JSON.stringify(snapshot), /sk-offline-not-a-live-key/)
      const status = execFileSync(bin, ['status', '--home', productHome], { encoding: 'utf8', env: uiEnv })
      assert.match(status, /TARS-NG 0\.4\.0/)
      assert.match(status, /running: yes/)
      assert.match(status, /web-ui: http:\/\/127\.0\.0\.1:\d+/)
      const stopped = execFileSync(bin, ['stop', '--home', productHome], { encoding: 'utf8', env: uiEnv })
      assert.match(stopped, /stopped the verified runtime/)
      assert.doesNotMatch(stopped, /runId/)
    } finally {
      if (existsSync(pidFile) && child.exitCode === null) child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        if (child.exitCode !== null) resolve()
      })
    }
    assert.equal(existsSync(pidFile), false)

    const outside = mkdtempSync(join(tmpdir(), 'tars-ng-third-party-'))
    mkdirSync(join(outside, 'src'), { recursive: true })
    writeFileSync(join(outside, 'package.json'), `${JSON.stringify({
      name: 'text-reverse',
      version: '1.0.0',
      type: 'module',
      main: 'src/plugin.js',
      tarsNg: { capability: 'text.reverse', tools: ['text_reverse'] },
    }, null, 2)}\n`)
    writeFileSync(join(outside, 'src', 'plugin.js'), `export function apply(ctx) {
  const dispose = ctx.tools.register({
    name: 'text_reverse',
    description: 'Reverse text',
    parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: String(v) }] } },
    async execute(args) { return String(args.text ?? '').split('').reverse().join('') },
  })
  ctx.effect(() => dispose)
}
`)
    assert.equal(outside.startsWith(pkgRoot), false)
    const imported = execFileSync(bin, ['self-extension', 'import-local', outside], { encoding: 'utf8', env })
    assert.match(imported, /"status": "imported"/)
    assert.match(imported, /"owner": "third-party\/text-reverse"/)
    assert.match(imported, /"origin": "import"/)
    assert.doesNotMatch(imported, /src\/product|tsx/)
    const doctorAfter = execFileSync(bin, ['doctor', '--home', productHome], { encoding: 'utf8', env })
    assert.match(doctorAfter, /third-party-imported: 1/)
    assert.match(doctorAfter, /third-party-active: 0/)
  })
})
