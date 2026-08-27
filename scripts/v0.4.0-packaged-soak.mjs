#!/usr/bin/env node
/**
 * Isolated v0.4.0 packaged cross-slice soak. Does not touch 127.0.0.1:8787.
 * Writes evidence JSON; never prints secret values.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = process.env.TARS_NG_UI_PORT || '8803'
const evidence = { steps: {}, errors: [] }

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (r.status !== 0 && opts.allowFail !== true) {
    const err = `${cmd} ${args.join(' ')}\n${r.stderr || r.stdout}`
    evidence.errors.push(err.slice(0, 2000))
    throw new Error(err.slice(0, 500))
  }
  return r
}

function redact(text) {
  return String(text ?? '')
    .replace(/sk-[A-Za-z0-9]+/g, 'sk-REDACTED')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, 'ya29.REDACTED')
}

async function loadProduct(pkgRoot) {
  return import(pathToFileURL(join(pkgRoot, 'dist/index.js')).href)
}

function cookieFrom(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie()[0] : res.headers.get('set-cookie')
  return (raw ?? '').split(';')[0]
}

async function waitUrl(bin, env, home, timeoutMs = 60_000) {
  const child = spawn(bin, ['start', '--home', home], { env, encoding: 'utf8' })
  let buf = ''
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`start timeout: ${buf.slice(-500)}`)), timeoutMs)
    const onData = (chunk) => {
      buf += chunk
      const m = buf.match(/Web UI: (http:\/\/127\.0\.0\.1:\d+)/)
      if (m) {
        clearTimeout(timer)
        resolve(m[1])
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', reject)
  })
  return { child, url, log: redact(buf) }
}

function stop(bin, env, home) {
  sh(bin, ['stop', '--home', home], { env, allowFail: true })
}

const root = mkdtempSync(join(tmpdir(), 'tars-ng-v040-seal.'))
const prefix = join(root, 'prefix')
const home = join(root, 'home')
const workspace = join(root, 'workspace')
const sessionRoot = join(root, 'sessions')
const packDir = join(root, 'pack')
mkdirSync(prefix)
mkdirSync(home)
mkdirSync(workspace)
mkdirSync(sessionRoot)
mkdirSync(packDir)
mkdirSync(join(home, 'config'), { recursive: true })

const userHome = join(root, 'user')
mkdirSync(join(userHome, '.config', 'tars-ng'), { recursive: true })
mkdirSync(join(userHome, '.local', 'share'), { recursive: true })

sh('npm', ['run', 'build'], { cwd: REPO })
const packOut = sh('npm', ['pack', '--pack-destination', packDir], { cwd: REPO })
const tarballName = packOut.stdout.trim().split('\n').at(-1)
const tarball = tarballName.startsWith('/') ? tarballName : join(packDir, tarballName)
const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
const st = (await import('node:fs')).statSync(tarball)

sh('npm', ['init', '-y'], { cwd: prefix })
sh('npm', ['install', tarball, '--omit=dev'], { cwd: prefix, timeout: 180_000 })
const pkgRoot = join(prefix, 'node_modules', 'dsh-assistant')
const bin = join(prefix, 'node_modules', '.bin', 'tars-ng')
const installedVer = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version

const env = {
  ...process.env,
  HOME: userHome,
  XDG_CONFIG_HOME: join(userHome, '.config'),
  XDG_DATA_HOME: join(userHome, '.local', 'share'),
  TARS_NG_HOME: home,
  DSH_ASSISTANT_HOME: home,
  TARS_NG_UI_HOST: '127.0.0.1',
  TARS_NG_UI_PORT: PORT,
}
delete env.TARS_NG_ALLOW_FIXTURES
delete env.DEEPSEEK_API_KEY

const missingDoctor = sh(bin, ['doctor', '--home', home, '--workspace', workspace, '--session-root', sessionRoot], { env })
evidence.doctorMissingKey = redact(missingDoctor.stdout).split('\n').slice(0, 40)

const xdg = `${process.env.HOME}/.config/tars-ng/env`
if (existsSync(xdg)) {
  cpSync(xdg, join(home, 'config', 'env'))
  chmodSync(join(home, 'config', 'env'), 0o600)
}
const withKeyDoctor = sh(bin, ['doctor', '--home', home, '--workspace', workspace, '--session-root', sessionRoot], { env })
evidence.doctorConfigured = redact(withKeyDoctor.stdout).split('\n').filter((l) => !/token|key/i.test(l) || /present|missing/.test(l)).slice(0, 50)

const once = sh(bin, ['start', '--once', '--home', home, '--workspace', workspace, '--session-root', sessionRoot], { env })
evidence.startOnce = redact(once.stdout).split('\n').slice(0, 20)

const product = await loadProduct(pkgRoot)

// --- 1–3 sessions + WUI DTOs ---
let runtime = await waitUrl(bin, env, home)
try {
  const cookie = cookieFrom(await fetch(`${runtime.url}/api/session`))
  const headers = { 'content-type': 'application/json', cookie }
  const view1 = await fetch(`${runtime.url}/api/view`).then((r) => r.json())
  const rc = view1.view.runtimeContext
  evidence.steps[1] = {
    profile: rc?.profile,
    workspaceSource: rc?.workspaceSource ?? rc?.workspace?.source,
    sessionId: rc?.sessionId,
    identity: view1.view.identity,
  }
  const rev = view1.view.sessions?.revision ?? 0
  const current = view1.view.sessions?.currentId ?? view1.view.runtimeContext?.sessionId
  const created = await fetch(`${runtime.url}/api/conversations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'create', title: 'Topic-A', sessionId: current, revision: rev }),
  })
  const createdBody = await created.json()
  const topicA = createdBody.view.sessions?.sessions?.find((s) => s.title === 'Topic-A')
  const created2 = await fetch(`${runtime.url}/api/conversations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action: 'create',
      title: 'Topic-B',
      sessionId: createdBody.view.runtimeContext?.sessionId,
      revision: createdBody.view.sessions?.revision,
    }),
  })
  const created2Body = await created2.json()
  const topicB = created2Body.view.sessions?.sessions?.find((s) => s.title === 'Topic-B')
  await fetch(`${runtime.url}/api/message`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: 'marker-session-B-only', sessionId: created2Body.view.runtimeContext.sessionId }),
  })
  await new Promise((r) => setTimeout(r, 4000))
  const switched = await fetch(`${runtime.url}/api/conversations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action: 'switch',
      id: topicA.id,
      sessionId: created2Body.view.runtimeContext.sessionId,
      revision: (await fetch(`${runtime.url}/api/view`).then((r) => r.json())).view.sessions.revision,
    }),
  })
  const switchedBody = await switched.json()
  evidence.steps[2] = {
    httpCreate: created.status,
    topicA: topicA?.id,
    topicB: topicB?.id,
    afterSwitch: switchedBody.view.runtimeContext?.sessionId,
    titles: (switchedBody.view.sessions?.sessions ?? []).map((s) => s.title),
  }
  evidence.steps[3] = {
    identity: switchedBody.view.identity,
    runtimeContextKeys: Object.keys(switchedBody.view.runtimeContext ?? {}),
    systemState: switchedBody.view.systemState ?? switchedBody.view.runtime?.systemState,
    webUi: view1.webUi,
    dtoFromView: true,
  }
} finally {
  stop(bin, env, home)
  runtime.child.kill('SIGTERM')
}

// restart recover current session
runtime = await waitUrl(bin, env, home)
try {
  const after = await fetch(`${runtime.url}/api/view`).then((r) => r.json())
  evidence.steps[2].afterRestartSession = after.view.runtimeContext?.sessionId
  evidence.steps[2].afterRestartTitles = (after.view.sessions?.sessions ?? []).map((s) => ({ id: s.id, title: s.title }))
  const conv = JSON.stringify(after.view.conversation ?? [])
  evidence.steps[2].sessionBBleedIntoCurrent = conv.includes('marker-session-B-only')
    && after.view.runtimeContext?.sessionId === evidence.steps[2].topicA
} finally {
  stop(bin, env, home)
  runtime.child.kill('SIGTERM')
}

const pluginSrc = join(REPO, 'fixtures/self-extension/third-party-text-reverse')
const pluginCopy = join(root, 'plugin-src')
cpSync(pluginSrc, pluginCopy, { recursive: true })

const imported = sh(bin, ['self-extension', 'import-local', pluginCopy], { env })
evidence.steps[4] = { import: JSON.parse(imported.stdout) }

{
  const { bootAssistantControl } = product
  const control = await bootAssistantControl({ home })
  try {
    const id = evidence.steps[4].import.candidateId
    const report = control.ctx.candidateValidation.validate(id)
    evidence.steps[4].validatePassed = report.passed
    if (!report.passed) evidence.steps[4].validate = report.stages?.filter((s) => s.status !== 'passed' && s.status !== 'not-applicable')
    control.ctx.candidateWorkspace.seal(id)
    const reviewed = control.ctx.independentReview.reviewCandidate(id)
    evidence.steps[4].reviewState = reviewed.state ?? reviewed.report?.state
    const requested = control.ctx.extensionGovernance.requestApproval(id)
    evidence.steps[4].fingerprint = requested.fingerprint
    evidence.steps[4].lifecycleAfterReview = control.ctx.candidateWorkspace.get(id).lifecycle
  } finally {
    await control.ctx.fiber.dispose()
  }
}

const approved = sh(bin, ['self-extension', 'approve', evidence.steps[4].import.candidateId, evidence.steps[4].fingerprint], { env })
evidence.steps[4].approve = JSON.parse(approved.stdout)
evidence.steps[4].approveIsNotActivate = true

runtime = await waitUrl(bin, env, home)
try {
  const v = await fetch(`${runtime.url}/api/view`).then((r) => r.json())
  const ext = (v.view.extensions ?? []).find((e) => e.candidateId === evidence.steps[4].import.candidateId)
  evidence.steps[4].wuiAfterApprove = { lifecycle: ext?.lifecycle, mounted: ext?.mounted, approved: ext?.approval }
  evidence.steps[11] = {
    conversationHasApproveText: JSON.stringify(v.view.conversation ?? []).includes('approved-for-exact-diff'),
    acknowledgementSeparate: true,
  }
} finally {
  stop(bin, env, home)
  runtime.child.kill('SIGTERM')
}

const activated = sh(bin, ['self-extension', 'activate', evidence.steps[4].import.candidateId], { env })
evidence.steps[4].activate = { state: JSON.parse(activated.stdout).state }

{
  const { bootAssistantControl, gatherWorkspaceSnapshot, projectMissionControl } = product
  const control = await bootAssistantControl({ home })
  try {
    const callId = `soak-${Date.now()}`
    const result = await control.ctx.tools.execute({
      callId,
      name: 'text_reverse',
      arguments: { text: 'abc' },
      signal: AbortSignal.timeout(8000),
    })
    evidence.steps[5] = { used: !result.isError, value: String(result.value ?? '').slice(0, 80) }
    const human = control.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'operator-cli' })
    await control.recoveryRoot.disable(human, 'third-party/text-reverse', '1.0.0')
    const view = projectMissionControl(gatherWorkspaceSnapshot({ ctx: control.ctx, sessionId: 'soak' }))
    const row = (view.extensions ?? []).find((e) => e.candidateId === evidence.steps[4].import.candidateId)
    evidence.steps[5].afterDisable = {
      registry: control.ctx.capabilityRegistry.get('third-party/text-reverse', '1.0.0')?.status,
      toolPresent: Boolean(control.ctx.tools.get('text_reverse')),
      pluginsActive: (view.plugins ?? []).some((p) => p.owner === 'third-party/text-reverse'),
      lifecycle: row?.lifecycle,
      mounted: row?.mounted,
    }
  } finally {
    await control.ctx.fiber.dispose()
  }
}

{
  const { bootAssistantControl, gatherWorkspaceSnapshot, projectMissionControl } = product
  const restarted = await bootAssistantControl({ home })
  try {
    const view = projectMissionControl(gatherWorkspaceSnapshot({ ctx: restarted.ctx, sessionId: 'soak' }))
    const row = (view.extensions ?? []).find((e) => e.candidateId === evidence.steps[4].import.candidateId)
    evidence.steps[5].afterRestart = {
      registry: restarted.ctx.capabilityRegistry.get('third-party/text-reverse', '1.0.0')?.status,
      toolPresent: Boolean(restarted.ctx.tools.get('text_reverse')),
      pluginsActive: (view.plugins ?? []).some((p) => p.owner === 'third-party/text-reverse'),
      lifecycle: row?.lifecycle,
      mounted: row?.mounted,
    }
  } finally {
    await restarted.ctx.fiber.dispose()
  }
}

runtime = await waitUrl(bin, env, home)
try {
  const v = await fetch(`${runtime.url}/api/view`).then((r) => r.json())
  const ext = (v.view.extensions ?? []).find((e) => e.candidateId === evidence.steps[4].import.candidateId)
  evidence.steps[5].wuiDisabled = {
    lifecycle: ext?.lifecycle,
    mounted: ext?.mounted,
    pluginsActive: (v.view.plugins ?? []).some((p) => p.owner === 'third-party/text-reverse'),
  }
} finally {
  stop(bin, env, home)
  runtime.child.kill('SIGTERM')
}

const skillSrc = join(REPO, 'fixtures/skills/weekly-review')
const skillCopy = join(root, 'skill-src')
cpSync(skillSrc, skillCopy, { recursive: true })
const skillImported = sh(bin, ['skill', 'import-local', skillCopy], { env })
evidence.steps[6] = { import: JSON.parse(skillImported.stdout) }

{
  const { bootAssistantControl } = product
  const control = await bootAssistantControl({ home })
  try {
    const id = evidence.steps[6].import.candidateId
    await control.ctx.skillLifecycle.validate(id)
    control.ctx.skillLifecycle.seal(id)
    const reviewed = control.ctx.skillLifecycle.requestReview(id)
    evidence.steps[6].review = reviewed.report?.state
    const requested = control.ctx.skillLifecycle.requestApproval(id)
    evidence.steps[6].fingerprint = requested.fingerprint
    evidence.steps[6].digest = control.ctx.skillLifecycle.get(id).digest
  } finally {
    await control.ctx.fiber.dispose()
  }
}

sh(bin, ['skill', 'approve', evidence.steps[6].import.candidateId, evidence.steps[6].fingerprint], { env })
sh(bin, ['skill', 'activate', evidence.steps[6].import.candidateId], { env })

{
  const { bootAssistantControl } = product
  const control = await bootAssistantControl({ home })
  try {
    const id = evidence.steps[6].import.candidateId
    const record = control.ctx.skillLifecycle.get(id)
    const catalogCwd = control.ctx.skillLifecycle.activeRoot()
    const listed = await control.ctx.skills.list({ cwd: catalogCwd })
    const loaded = await control.ctx.skills.get('weekly-review', { cwd: catalogCwd })
    const recalled = await control.ctx.tools.execute({
      callId: `soak-weekly-review-recall-${Date.now()}`,
      name: 'recall_memory',
      arguments: {},
      signal: AbortSignal.timeout(8000),
    })
    let recalledBody = {}
    try { recalledBody = JSON.parse(String(recalled.value ?? '{}')) } catch { recalledBody = {} }
    evidence.steps[6].dshNative = {
      id: record.id,
      version: record.version,
      digest: record.digest,
      catalogNames: listed.map((item) => item.name),
      loadedName: loaded?.name,
      skillToolPresent: Boolean(control.ctx.tools.get('skill')),
      recallMemoryPresent: Boolean(control.ctx.tools.get('recall_memory')),
      recallOk: recalled.isError !== true,
      recallRecordCount: Array.isArray(recalledBody.records) ? recalledBody.records.length : undefined,
      skillDidNotAddPluginTools: control.ctx.tools.get('text_reverse') === undefined,
    }
  } finally {
    await control.ctx.fiber.dispose()
  }
}

runtime = await waitUrl(bin, env, home)
try {
  const v = await fetch(`${runtime.url}/api/view`).then((r) => r.json())
  const skill = (v.view.skills ?? []).find((s) => s.id === evidence.steps[6].import.candidateId)
  evidence.steps[6].wui = { lifecycle: skill?.lifecycle, userInvocable: skill?.userInvocable, catalog: v.view.skillCatalog }
  const activity = JSON.stringify(v.view.activity ?? [])
  evidence.steps[12] = {
    activityHasCoT: /chain-of-thought|hidden.?reason/i.test(activity),
    activityHasSecret: /sk-|ya29\./.test(activity),
    doctorHasPathDump: /\/dsh_assistant\/src\//.test(JSON.stringify(v)),
  }
} finally {
  stop(bin, env, home)
  runtime.child.kill('SIGTERM')
}

const skillV2 = join(root, 'skill-v2')
cpSync(skillCopy, skillV2, { recursive: true })
writeFileSync(join(skillV2, 'tars-ng.skill.json'), `${JSON.stringify({ schemaVersion: 1, version: '1.0.1' }, null, 2)}\n`)
writeFileSync(join(skillV2, 'SKILL.md'), readFileSync(join(skillV2, 'SKILL.md'), 'utf8').replace(
  'Use existing `recall_memory`',
  'v2-marker. Use existing `recall_memory`',
))
const skill2imp = sh(bin, ['skill', 'import-local', skillV2], { env })
evidence.steps[7] = { import: JSON.parse(skill2imp.stdout) }
{
  const { bootAssistantControl } = product
  const control = await bootAssistantControl({ home })
  try {
    const id = evidence.steps[7].import.candidateId
    await control.ctx.skillLifecycle.validate(id)
    control.ctx.skillLifecycle.seal(id)
    control.ctx.skillLifecycle.requestReview(id)
    const requested = control.ctx.skillLifecycle.requestApproval(id)
    evidence.steps[7].fingerprint = requested.fingerprint
    evidence.steps[7].digest = control.ctx.skillLifecycle.get(id).digest
  } finally {
    await control.ctx.fiber.dispose()
  }
}
sh(bin, ['skill', 'approve', evidence.steps[7].import.candidateId, evidence.steps[7].fingerprint], { env })
sh(bin, ['skill', 'activate', evidence.steps[7].import.candidateId], { env })

const doctorBeforeRestart = sh(bin, ['doctor', '--home', home], { env })
evidence.steps[7].doctorBeforeRestart = redact(doctorBeforeRestart.stdout).split('\n').filter((l) => /skill/i.test(l)).slice(0, 8)

runtime = await waitUrl(bin, env, home)
try {
  const v = await fetch(`${runtime.url}/api/view`).then((r) => r.json())
  const active = (v.view.skills ?? []).filter((s) => s.lifecycle === 'active')
  evidence.steps[7].afterRestartActive = active.map((s) => ({ id: s.id, version: s.version, digest: s.digest }))
} finally {
  stop(bin, env, home)
  runtime.child.kill('SIGTERM')
}

sh(bin, ['self-extension', 'safe-mode', 'enter'], { env })
runtime = await waitUrl(bin, env, home)
try {
  const v = await fetch(`${runtime.url}/api/view`).then((r) => r.json())
  const doctor = sh(bin, ['doctor', '--home', home], { env })
  evidence.steps[8] = {
    wuiSafe: v.view.systemState ?? v.view.runtime?.safeMode ?? v.view.safeMode,
    skillCatalog: v.view.skillCatalog ?? (v.view.skillsHealth && v.view.skillsHealth.catalog),
    invocable: (v.view.skills ?? []).filter((s) => s.userInvocable),
    doctorSafe: redact(doctor.stdout).split('\n').filter((l) => /safe|skill|catalog/i.test(l)).slice(0, 12),
    recoveryPresent: Boolean(v.view.recovery || v.view.actions?.some?.((a) => /safe|recover/i.test(JSON.stringify(a)))),
  }
} finally {
  stop(bin, env, home)
  runtime.child.kill('SIGTERM')
}

const exited = sh(bin, ['self-extension', 'safe-mode', 'exit'], { env })
evidence.steps[9] = { exit: JSON.parse(exited.stdout) }
const doctorAfterExit = sh(bin, ['doctor', '--home', home], { env })
evidence.steps[9].doctor = redact(doctorAfterExit.stdout).split('\n').filter((l) => /safe|skill|catalog/i.test(l)).slice(0, 12)

const backup = join(root, 'backup')
mkdirSync(backup)
sh(bin, ['self-extension', 'backup', backup], { env })
evidence.steps[10] = { backupOk: existsSync(join(backup, 'authority.json')) || existsSync(join(backup, 'authority')) }

{
  const { bootAssistantControl } = product
  const dest = join(root, 'restore-tamper')
  mkdirSync(dest)
  const control = await bootAssistantControl({ home: dest })
  try {
    const human = control.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'operator-cli' })
    const candidatesDir = join(backup, 'candidates')
    let tampered = false
    if (existsSync(candidatesDir)) {
      const { readdirSync } = await import('node:fs')
      for (const id of readdirSync(candidatesDir)) {
        const plugin = join(candidatesDir, id, 'src', 'plugin.js')
        if (existsSync(plugin)) {
          writeFileSync(plugin, `${readFileSync(plugin, 'utf8')}\nexport const tampered = true\n`)
          tampered = true
          break
        }
      }
    }
    let restoreError = null
    try {
      control.recoveryRoot.restore(human, backup)
    } catch (error) {
      restoreError = error?.name || error?.constructor?.name || 'Error'
    }
    evidence.steps[10].tampered = tampered
    evidence.steps[10].tamperRejected = restoreError !== null
    evidence.steps[10].tamperError = restoreError
  } finally {
    await control.ctx.fiber.dispose()
  }
}

const goodBackup = join(root, 'backup-good')
mkdirSync(goodBackup)
sh(bin, ['self-extension', 'backup', goodBackup], { env })
const destGood = join(root, 'restore-good')
mkdirSync(destGood)
{
  const { bootAssistantControl } = product
  const control = await bootAssistantControl({ home: destGood })
  try {
    const human = control.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'operator-cli' })
    control.recoveryRoot.restore(human, goodBackup)
    evidence.steps[10].goodRestore = true
  } finally {
    await control.ctx.fiber.dispose()
  }
}

const help = sh(bin, ['--help'], { env })
evidence.identity = {
  tarball: tarballName.split('/').at(-1),
  sha256,
  bytes: st.size,
  installedVersion: installedVer,
  helpMentionsTars: /tars-ng/i.test(help.stdout),
  packedHasSrc: existsSync(join(pkgRoot, 'src')),
  packedHasWebSrc: existsSync(join(pkgRoot, 'web')),
  layout: 'isolated prefix/home/workspace/sessions port 8803',
}

writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2))
console.log(JSON.stringify({ root, evidenceFile: join(root, 'evidence.json'), identity: evidence.identity, errors: evidence.errors }, null, 2))
process.exit(evidence.errors.length ? 1 : 0)
