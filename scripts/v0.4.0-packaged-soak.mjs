#!/usr/bin/env node
/**
 * Isolated v0.4.0 packaged cross-slice soak. Does not touch 127.0.0.1:8787.
 * Fail-closed: every Issue #96 step is asserted; any failure exits non-zero.
 * Default run is credential-free (offline placeholder key only; no operator env copy, no /api/message).
 * Writes evidence JSON; never prints secret values.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const OPERATOR_HOME = process.env.HOME
const PORT = process.env.TARS_NG_UI_PORT || '8803'
const evidence = { steps: {}, errors: [] }
const PROFILE_IDENTITY = 'v1:f151980e5483a185518db82be340a1d4b2ae06441fe3c73f2c8f3236761e5b81'
const EXPECTED_TARBALL = 'dsh-assistant-0.4.0.tgz'
const EXPECTED_FILES = 459
const EXPECTED_BYTES = 966603
const EXPECTED_SHA256 = 'e7552afd3a6cd1f566b14e12b0f55059eaca360f8ae9e4ecb5961656b05563c1'
const SESSION_MARKER = 'marker-session-B-only'
const OFFLINE_KEY = 'sk-offline-not-a-live-key'
const FORBIDDEN_ENV = [
  'DEEPSEEK_API_KEY',
  'DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN',
  'DSH_ASSISTANT_GOOGLE_CALENDAR_MODE',
  'GOOGLE_SEARCH_API_KEY',
  'GOOGLE_SEARCH_ENGINE_ID',
  'DSH_ASSISTANT_SANDBOX_ROOT',
  'TARS_NG_ALLOW_FIXTURES',
  'TARS_NG_HOME',
  'DSH_ASSISTANT_HOME',
  'TARS_NG_PROFILE',
  'TARS_NG_WORKSPACE',
  'TARS_NG_SESSION_ROOT',
  'TARS_NG_SESSION_ID',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
]

function scrubInheritedCredentials() {
  for (const name of FORBIDDEN_ENV) delete process.env[name]
  for (const name of Object.keys(process.env)) {
    if (name === 'TARS_NG_UI_HOST' || name === 'TARS_NG_UI_PORT') continue
    if (/^(TARS_NG_|DSH_ASSISTANT_|AWS_|AZURE_|OPENAI_|ANTHROPIC_|NPM_TOKEN|NODE_AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)/.test(name)) {
      delete process.env[name]
    }
  }
}

scrubInheritedCredentials()

function platformEnv() {
  const out = {}
  for (const name of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ']) {
    if (process.env[name]) out[name] = process.env[name]
  }
  return out
}

let isolatedChildEnv = () => ({ ...platformEnv() })

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    ...opts,
    env: { ...isolatedChildEnv(), ...(opts.env ?? {}) },
  })
  if (r.status !== 0 && opts.allowFail !== true) {
    const err = `${cmd} ${args.join(' ')} (status=${r.status})\n${r.stderr || r.stdout}`
    evidence.errors.push(err.slice(0, 2000))
    throw new Error(err.slice(0, 800))
  }
  return r
}

function redact(text) {
  return String(text ?? '')
    .replace(/sk-[A-Za-z0-9]+/g, 'sk-REDACTED')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, 'ya29.REDACTED')
}

function expect(ok, message) {
  if (ok) return
  evidence.errors.push(message)
}

function assertForbiddenEnvAbsent(where, bag) {
  for (const name of FORBIDDEN_ENV) {
    const value = bag[name]
    if (name === 'TARS_NG_HOME' || name === 'DSH_ASSISTANT_HOME') {
      expect(value === undefined || value === home, `${where} ${name} must be absent or the isolated Home`)
      continue
    }
    expect(value === undefined || value === '' || (name === 'DEEPSEEK_API_KEY' && value === OFFLINE_KEY), `${where} must not inherit ${name}`)
  }
  expect(bag.HOME === undefined || bag.HOME === userHome, `${where} HOME must be the isolated user Home`)
  expect(bag.HOME !== OPERATOR_HOME, `${where} HOME must not be the operator login Home`)
}

function workspaceIdentityOf(dir) {
  return createHash('sha256').update(realpathSync(dir)).digest('hex').slice(0, 16)
}

function assertCatalogMembers(view, topicA, topicB, when) {
  const active = (view.sessions?.sessions ?? []).filter((s) => s.archived !== true)
  const ids = new Set(active.map((s) => s.id))
  expect(ids.has('main'), `${when}: catalog must include main`)
  expect(ids.has(topicA.id), `${when}: catalog must include Topic-A`)
  expect(ids.has(topicB.id), `${when}: catalog must include Topic-B`)
  expect(active.length === 3, `${when}: catalog must have exactly three active sessions`)
  expect(active.find((s) => s.id === topicA.id)?.title === 'Topic-A', `${when}: Topic-A title must match`)
  expect(active.find((s) => s.id === topicB.id)?.title === 'Topic-B', `${when}: Topic-B title must match`)
}

function normalizeSessionEvents(events) {
  return JSON.stringify((events ?? []).map((event) => ({ type: event.type, data: event.data })))
}

function equalTails(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function conversationHas(view, text) {
  return JSON.stringify(view?.conversation ?? []).includes(text)
}

let v2InstructionBody = ''

function assertBoundedPayload(label, value, { allowIsolatedHome = false } = {}) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  expect(!text.includes(OFFLINE_KEY), `${label} must not print the placeholder key`)
  expect(!/sk-[A-Za-z0-9]{8,}/.test(text), `${label} must not include secret prefixes`)
  expect(!/ya29\./.test(text), `${label} must not include OAuth token prefixes`)
  expect(!/chain-of-thought|hidden.?reason/i.test(text), `${label} must not include chain-of-thought`)
  expect(!text.includes(join(REPO, 'src')), `${label} must not dump repo src/ paths`)
  expect(!text.includes(REPO), `${label} must not dump the repository path`)
  expect(!text.includes(OPERATOR_HOME), `${label} must not dump the operator Home`)
  if (!allowIsolatedHome) {
    expect(!text.includes(home), `${label} must not dump the isolated Home path`)
    expect(!text.includes(workspace), `${label} must not dump the isolated Workspace path`)
    expect(!text.includes(userHome), `${label} must not dump the isolated user Home path`)
  }
  if (v2InstructionBody) {
    expect(!text.includes(v2InstructionBody), `${label} must not include the v1.0.1 Skill instruction body`)
    expect(!text.includes('v2-marker'), `${label} must not include the v1.0.1 Skill instruction marker`)
  }
}

async function loadProduct(pkgRoot) {
  return import(pathToFileURL(join(pkgRoot, 'dist/index.js')).href)
}

async function writeSessionMarkerThroughProduct(pkgRoot, product, sessionId) {
  const require = createRequire(join(pkgRoot, 'package.json'))
  const { createUserMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
  const { ensureProductHome } = await import(pathToFileURL(join(pkgRoot, 'dist/product/home.js')).href)
  const { resolveRuntimeContext } = await import(pathToFileURL(join(pkgRoot, 'dist/product/runtime-context.js')).href)
  const layout = ensureProductHome(home)
  const context = resolveRuntimeContext(layout, {
    workspace,
    sessionRoot,
    sessionId,
  }, undefined, { allowFixtures: false })
  const control = await product.bootAssistantControl({
    home,
    sessionRoot: context.sessionPersistenceDir,
    sessionId,
    workspace: context.workspace.value,
    allowFixtures: false,
  })
  try {
    const handle = await product.createAssistantAgent(control.ctx, sessionId, undefined, context.workspace.value)
    handle.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: SESSION_MARKER }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await control.ctx.sessions.flush(handle.agent.session)
    await handle.dispose()
    return context
  } finally {
    await control.ctx.fiber.dispose()
  }
}

async function readSessionTails(pkgRoot, product, sessionIds) {
  const { ensureProductHome } = await import(pathToFileURL(join(pkgRoot, 'dist/product/home.js')).href)
  const { resolveRuntimeContext } = await import(pathToFileURL(join(pkgRoot, 'dist/product/runtime-context.js')).href)
  const layout = ensureProductHome(home)
  const context = resolveRuntimeContext(layout, {
    workspace,
    sessionRoot,
    sessionId: sessionIds[0],
  }, undefined, { allowFixtures: false })
  const control = await product.bootAssistantControl({
    home,
    sessionRoot: context.sessionPersistenceDir,
    sessionId: sessionIds[0],
    workspace: context.workspace.value,
    allowFixtures: false,
  })
  try {
    const tails = {}
    for (const sessionId of sessionIds) {
      const handle = await product.createAssistantAgent(control.ctx, sessionId, undefined, context.workspace.value)
      tails[sessionId] = normalizeSessionEvents(handle.agent.session.events)
      await handle.dispose()
    }
    return tails
  } finally {
    await control.ctx.fiber.dispose()
  }
}

function cookieFrom(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie()[0] : res.headers.get('set-cookie')
  return (raw ?? '').split(';')[0]
}

async function waitUrl(bin, env, home, timeoutMs = 60_000) {
  const child = spawn(bin, ['start', '--home', home, '--workspace', workspace, '--session-root', sessionRoot], { env, encoding: 'utf8' })
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
const isolatedNpmrc = join(userHome, '.npmrc')
const isolatedGlobalNpmrc = join(userHome, '.npmrc-global')
const isolatedNpmCache = join(userHome, '.cache', 'npm')
mkdirSync(join(userHome, '.config', 'tars-ng'), { recursive: true })
mkdirSync(join(userHome, '.local', 'share'), { recursive: true })
mkdirSync(isolatedNpmCache, { recursive: true })
writeFileSync(isolatedNpmrc, '')
writeFileSync(isolatedGlobalNpmrc, '')

isolatedChildEnv = () => ({
  ...platformEnv(),
  HOME: userHome,
  XDG_CONFIG_HOME: join(userHome, '.config'),
  XDG_CACHE_HOME: join(userHome, '.cache'),
  XDG_DATA_HOME: join(userHome, '.local', 'share'),
  npm_config_userconfig: isolatedNpmrc,
  npm_config_globalconfig: isolatedGlobalNpmrc,
  npm_config_cache: isolatedNpmCache,
  npm_config_fund: 'false',
  npm_config_audit: 'false',
  TARS_NG_HOME: home,
  DSH_ASSISTANT_HOME: home,
  TARS_NG_UI_HOST: '127.0.0.1',
  TARS_NG_UI_PORT: PORT,
})

function applyProcessAllowlist() {
  const allowed = isolatedChildEnv()
  for (const name of Object.keys(process.env)) {
    if (!(name in allowed)) delete process.env[name]
  }
  Object.assign(process.env, allowed)
}

applyProcessAllowlist()
assertForbiddenEnvAbsent('runner process.env before first subprocess', process.env)

const npmUserconfig = sh('npm', ['config', 'get', 'userconfig']).stdout.trim().split('\n').at(-1).trim()
const npmCache = sh('npm', ['config', 'get', 'cache']).stdout.trim().split('\n').at(-1).trim()
expect(npmUserconfig === isolatedNpmrc || (existsSync(npmUserconfig) && realpathSync(npmUserconfig) === realpathSync(isolatedNpmrc)), 'npm userconfig must be the isolated empty npmrc')
expect(npmCache === isolatedNpmCache || npmCache.startsWith(userHome), 'npm cache must be inside the isolated user Home')
expect(!String(npmUserconfig).startsWith(`${OPERATOR_HOME}/`), 'npm userconfig must not resolve under the operator Home')
expect(readFileSync(isolatedNpmrc, 'utf8').trim() === '', 'isolated npmrc must not contain operator registry auth')

sh('npm', ['run', 'build'], { cwd: REPO })
const dry = sh('npm', ['pack', '--dry-run', '--json'], { cwd: REPO })
let packedFileCount
try {
  const jsonLine = dry.stdout.trim().split('\n').filter((l) => l.startsWith('{') || l.startsWith('[')).at(-1)
  const dryJson = JSON.parse(jsonLine)
  const dryMeta = Array.isArray(dryJson) ? dryJson[0] : dryJson
  packedFileCount = Array.isArray(dryMeta?.files) ? dryMeta.files.length : undefined
} catch {
  packedFileCount = undefined
}
const packOut = sh('npm', ['pack', '--pack-destination', packDir], { cwd: REPO })
const tarballName = packOut.stdout.trim().split('\n').at(-1)
const tarball = tarballName.startsWith('/') ? tarballName : join(packDir, tarballName)
const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
const st = (await import('node:fs')).statSync(tarball)
if (packedFileCount === undefined) {
  packedFileCount = sh('tar', ['-tzf', tarball]).stdout.trim().split('\n').filter(Boolean).length
}

sh('npm', ['init', '-y'], { cwd: prefix })
sh('npm', ['install', tarball, '--omit=dev'], { cwd: prefix, timeout: 360_000 })
const pkgRoot = join(prefix, 'node_modules', 'dsh-assistant')
const bin = join(prefix, 'node_modules', '.bin', 'tars-ng')
const installedVer = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version

applyProcessAllowlist()
assertForbiddenEnvAbsent('runner process.env before product load', process.env)

const env = isolatedChildEnv()
assertForbiddenEnvAbsent('child env', env)

try {
const missingDoctor = sh(bin, ['doctor', '--home', home, '--workspace', workspace, '--session-root', sessionRoot], { env })
evidence.doctorMissingKey = redact(missingDoctor.stdout).split('\n').slice(0, 40)
expect(/TARS-NG 0\.4\.0/.test(missingDoctor.stdout), 'doctor must project TARS-NG 0.4.0')
expect(/DEEPSEEK_API_KEY: missing/.test(missingDoctor.stdout), 'isolated doctor must report missing DEEPSEEK_API_KEY')
expect(!existsSync(join(home, 'config', 'env')), 'must not copy operator ~/.config/tars-ng/env')

const failedOnce = sh(bin, ['start', '--once', '--home', home, '--workspace', workspace, '--session-root', sessionRoot], { env, allowFail: true })
expect(failedOnce.status !== 0, 'start --once without a key must fail')
expect(/LLM not configured\/unavailable|missing DEEPSEEK_API_KEY/.test(`${failedOnce.stdout}\n${failedOnce.stderr}`), 'start without a key must name the missing credential')

writeFileSync(join(home, 'config', 'env'), `DEEPSEEK_API_KEY=${OFFLINE_KEY}\n`, { mode: 0o600 })
chmodSync(join(home, 'config', 'env'), 0o600)
const withKeyDoctor = sh(bin, ['doctor', '--home', home, '--workspace', workspace, '--session-root', sessionRoot], { env })
evidence.doctorConfigured = redact(withKeyDoctor.stdout).split('\n').filter((l) => !/token|key/i.test(l) || /present|missing/.test(l)).slice(0, 50)
expect(/DEEPSEEK_API_KEY: present/.test(withKeyDoctor.stdout), 'offline placeholder key must be diagnosed present')
expect(!withKeyDoctor.stdout.includes(OFFLINE_KEY), 'doctor must not print the placeholder key value')
expect(withKeyDoctor.stdout.includes(`profile-identity: ${PROFILE_IDENTITY}`), 'doctor must report the shipped assistant Profile identity')
expect(/workspace: .+ \(cli\)/.test(withKeyDoctor.stdout), 'workspace must be bound from CLI')
expect(/session-persistence: persistent/.test(withKeyDoctor.stdout), 'session persistence must be persistent under the isolated Session root')

const once = sh(bin, ['start', '--once', '--home', home, '--workspace', workspace, '--session-root', sessionRoot], { env })
evidence.startOnce = redact(once.stdout).split('\n').slice(0, 20)
expect(/TARS-NG 0\.4\.0/.test(once.stdout), 'start --once must project 0.4.0')
expect(!/Web UI:/.test(once.stdout), 'start --once must not start the Web UI')

const product = await loadProduct(pkgRoot)
assertForbiddenEnvAbsent('runner process.env after loadProduct', process.env)

// --- 1–3 sessions + WUI DTOs ---
let runtime = await waitUrl(bin, env, home)
let topicA
let topicB
try {
  const cookie = cookieFrom(await fetch(`${runtime.url}/api/session`))
  const headers = { 'content-type': 'application/json', cookie }
  const view1 = await fetch(`${runtime.url}/api/view`).then((r) => r.json())
  const rc = view1.view.runtimeContext
  evidence.steps[1] = {
    profile: rc?.profile,
    profileIdentity: rc?.profileIdentity,
    workspaceSource: rc?.sources?.workspace,
    workspaceIdentity: rc?.workspaceIdentity,
    sessionId: rc?.sessionId,
    sessionPersistence: rc?.sessionPersistence,
    identity: view1.view.identity,
  }
  expect(rc?.profile === 'assistant', 'bound Profile must be assistant')
  expect(rc?.profileIdentity === PROFILE_IDENTITY, 'bound Profile identity must match the shipped assistant composition')
  expect(rc?.sources?.workspace === 'cli', 'Workspace source must be cli')
  expect(rc?.workspaceIdentity === workspaceIdentityOf(workspace), 'Workspace identity must match the explicit Workspace bind')
  expect(rc?.sessionPersistence === 'persistent', 'Session persistence must be persistent')
  expect(typeof rc?.workspaceIdentity === 'string' && rc.workspaceIdentity.length > 0, 'Workspace identity must be present')
  const rev = view1.view.sessions?.revision ?? 0
  const current = view1.view.sessions?.currentId ?? view1.view.runtimeContext?.sessionId
  const created = await fetch(`${runtime.url}/api/conversations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'create', title: 'Topic-A', sessionId: current, revision: rev }),
  })
  const createdBody = await created.json()
  topicA = createdBody.view.sessions?.sessions?.find((s) => s.title === 'Topic-A')
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
  topicB = created2Body.view.sessions?.sessions?.find((s) => s.title === 'Topic-B')
  expect(Boolean(topicA?.id && topicB?.id), 'WUI must create Topic-A and Topic-B')
  expect(created.status === 200, 'Topic-A create must be HTTP 200')
  evidence.steps[2] = {
    httpCreate: created.status,
    topicA: topicA?.id,
    topicB: topicB?.id,
    currentAfterCreateB: created2Body.view.runtimeContext?.sessionId,
  }
  expect(evidence.steps[2].currentAfterCreateB === topicB.id, 'creating Topic-B must select Topic-B')
  assertCatalogMembers(created2Body.view, topicA, topicB, 'after creating Topic-A and Topic-B')
  evidence.steps[3] = {
    identity: created2Body.view.identity,
    runtimeContextKeys: Object.keys(created2Body.view.runtimeContext ?? {}),
    systemState: created2Body.view.systemState ?? created2Body.view.runtime?.systemState,
    webUi: view1.webUi,
    dtoFromView: true,
  }
  expect(evidence.steps[3].identity === 'TARS-NG', 'WUI identity must be TARS-NG')
  for (const key of ['profile', 'profileIdentity', 'workspaceLabel', 'workspaceIdentity', 'sessionId', 'sessionPersistence', 'safeMode', 'sources']) {
    expect(evidence.steps[3].runtimeContextKeys.includes(key), `runtimeContext must include ${key}`)
  }
  expect(String(evidence.steps[3].webUi ?? '').includes('127.0.0.1:8803') || String(evidence.steps[3].webUi ?? '').startsWith('http://127.0.0.1:'), 'WUI must be loopback')
} finally {
  stop(bin, env, home)
  runtime.child.kill('SIGTERM')
}

const persistedContext = await writeSessionMarkerThroughProduct(pkgRoot, product, topicB.id)
evidence.steps[1].sessionPersistenceDirBound = persistedContext.sessionRoot.source
expect(persistedContext.sessionRoot.source === 'cli' || persistedContext.sessionRoot.source === 'product-config', 'Session root must be the isolated CLI bind')
expect(persistedContext.sessionPersistenceDir.includes('.tars-ng-sessions'), 'product Session persistence must use the managed Session partition')

runtime = await waitUrl(bin, env, home)
try {
  const cookie = cookieFrom(await fetch(`${runtime.url}/api/session`))
  const headers = { 'content-type': 'application/json', cookie }
  const onB = await fetch(`${runtime.url}/api/view`).then((r) => r.json())
  evidence.steps[2].afterMarkerSession = onB.view.runtimeContext?.sessionId
  evidence.steps[2].markerVisibleOnB = conversationHas(onB.view, SESSION_MARKER)
  expect(onB.view.runtimeContext?.sessionId === topicB.id, 'after marker write, current session must be Topic-B')
  expect(evidence.steps[2].markerVisibleOnB === true, 'Topic-B conversation must contain the persisted marker')
  const switched = await fetch(`${runtime.url}/api/conversations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action: 'switch',
      id: topicA.id,
      sessionId: onB.view.runtimeContext.sessionId,
      revision: onB.view.sessions.revision,
    }),
  })
  const switchedBody = await switched.json()
  evidence.steps[2].afterSwitch = switchedBody.view.runtimeContext?.sessionId
  evidence.steps[2].titles = (switchedBody.view.sessions?.sessions ?? []).map((s) => s.title)
  evidence.steps[2].activeAfterSwitch = (switchedBody.view.sessions?.sessions ?? []).filter((s) => s.archived !== true).length
  evidence.steps[2].markerOnAAfterSwitch = conversationHas(switchedBody.view, SESSION_MARKER)
  expect(evidence.steps[2].afterSwitch === topicA.id, 'switch must select Topic-A')
  expect(evidence.steps[2].markerOnAAfterSwitch === false, 'Topic-A must not contain the Topic-B marker after switch')
  assertCatalogMembers(switchedBody.view, topicA, topicB, 'after switch to Topic-A')
} finally {
  stop(bin, env, home)
  runtime.child.kill('SIGTERM')
}

runtime = await waitUrl(bin, env, home)
try {
  const after = await fetch(`${runtime.url}/api/view`).then((r) => r.json())
  evidence.steps[2].afterRestartSession = after.view.runtimeContext?.sessionId
  evidence.steps[2].afterRestartTitles = (after.view.sessions?.sessions ?? []).map((s) => ({ id: s.id, title: s.title }))
  evidence.steps[2].activeAfterRestart = (after.view.sessions?.sessions ?? []).filter((s) => s.archived !== true).length
  evidence.steps[2].sessionBBleedIntoCurrent = conversationHas(after.view, SESSION_MARKER)
  expect(after.view.runtimeContext?.sessionId === topicA.id, 'restart must keep Topic-A current')
  expect(evidence.steps[2].sessionBBleedIntoCurrent === false, 'Topic-B marker must not bleed into Topic-A after restart')
  assertCatalogMembers(after.view, topicA, topicB, 'after restart')
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
    expect(evidence.steps[4].validatePassed === true, 'plugin validation must pass')
    expect(evidence.steps[4].reviewState === 'review-complete', 'Independent Review must be review-complete')
    expect(typeof evidence.steps[4].fingerprint === 'string' && evidence.steps[4].fingerprint.length === 64, 'approve fingerprint must be a 64-char digest')
  } finally {
    await control.ctx.fiber.dispose()
  }
}

const sessionIds = ['main', topicA.id, topicB.id]
const tailsBeforeApprove = await readSessionTails(pkgRoot, product, sessionIds)
const approved = sh(bin, ['self-extension', 'approve', evidence.steps[4].import.candidateId, evidence.steps[4].fingerprint], { env })
evidence.steps[4].approve = JSON.parse(approved.stdout)
evidence.steps[4].approveIsNotActivate = evidence.steps[4].approve.decision === 'approved-for-exact-diff'
expect(evidence.steps[4].approveIsNotActivate, 'approve must record approved-for-exact-diff and not activate')
const tailsAfterApprove = await readSessionTails(pkgRoot, product, sessionIds)
evidence.steps[11] = {
  beforeApprove: Object.keys(tailsBeforeApprove),
  tailsUnchangedAfterApprove: equalTails(tailsBeforeApprove, tailsAfterApprove),
}
expect(evidence.steps[11].tailsUnchangedAfterApprove === true, 'approval must not append main/Topic-A/Topic-B conversation tails')

runtime = await waitUrl(bin, env, home)
try {
  const v = await fetch(`${runtime.url}/api/view`).then((r) => r.json())
  const ext = (v.view.extensions ?? []).find((e) => e.candidateId === evidence.steps[4].import.candidateId)
  evidence.steps[4].wuiAfterApprove = { lifecycle: ext?.lifecycle, mounted: ext?.mounted, approved: ext?.approval }
  expect(ext?.lifecycle === 'APPROVED_NOT_ACTIVE', 'WUI after approve must be APPROVED_NOT_ACTIVE')
  expect(ext?.mounted === false, 'WUI after approve must have mounted=false')
} finally {
  stop(bin, env, home)
  runtime.child.kill('SIGTERM')
}

const activated = sh(bin, ['self-extension', 'activate', evidence.steps[4].import.candidateId], { env })
evidence.steps[4].activate = { state: JSON.parse(activated.stdout).state }
expect(evidence.steps[4].activate.state === 'active', 'plugin activate must reach state=active')
const tailsAfterActivate = await readSessionTails(pkgRoot, product, sessionIds)
evidence.steps[11].tailsUnchangedAfterActivate = equalTails(tailsAfterApprove, tailsAfterActivate)
expect(evidence.steps[11].tailsUnchangedAfterActivate === true, 'activation must not append main/Topic-A/Topic-B conversation tails')

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
    expect(evidence.steps[5].used === true && evidence.steps[5].value === 'cba', 'text_reverse must reverse abc → cba')
    expect(evidence.steps[5].afterDisable.registry === 'disabled', 'disable must set registry disabled')
    expect(evidence.steps[5].afterDisable.toolPresent === false, 'disable must unmount text_reverse')
    expect(evidence.steps[5].afterDisable.pluginsActive === false, 'disable must drop the active plugin card')
    expect(evidence.steps[5].afterDisable.lifecycle === 'DISABLED_REACTIVATABLE', 'disable lifecycle must be DISABLED_REACTIVATABLE')
    expect(evidence.steps[5].afterDisable.mounted === false, 'disable must record mounted=false')
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
    expect(evidence.steps[5].afterRestart.registry === 'disabled', 'restart must keep registry disabled')
    expect(evidence.steps[5].afterRestart.toolPresent === false, 'restart must keep text_reverse absent')
    expect(evidence.steps[5].afterRestart.mounted === false, 'restart must keep mounted=false')
    expect(evidence.steps[5].afterRestart.lifecycle === 'DISABLED_REACTIVATABLE', 'restart lifecycle must stay DISABLED_REACTIVATABLE')
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
  expect(evidence.steps[5].wuiDisabled.lifecycle === 'DISABLED_REACTIVATABLE', 'packed WUI after disable must be DISABLED_REACTIVATABLE')
  expect(evidence.steps[5].wuiDisabled.mounted === false, 'packed WUI after disable must have mounted=false')
  expect(evidence.steps[5].wuiDisabled.pluginsActive === false, 'packed WUI after disable must drop the active plugin card')
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
    expect(evidence.steps[6].review === 'review-complete', 'Skill Independent Review must be review-complete')
    expect(typeof evidence.steps[6].fingerprint === 'string' && evidence.steps[6].fingerprint.length === 64, 'Skill approval fingerprint must be a 64-char digest')
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
    expect(evidence.steps[6].dshNative.loadedName === 'weekly-review', 'DSH must load weekly-review')
    expect(evidence.steps[6].dshNative.catalogNames.includes('weekly-review'), 'DSH catalog must list weekly-review')
    expect(evidence.steps[6].dshNative.skillToolPresent === true, 'host skill tool must be present')
    expect(evidence.steps[6].dshNative.recallOk === true, 'recall_memory must succeed')
    expect(evidence.steps[6].dshNative.recallRecordCount === 0, 'recall_memory records must be 0')
    expect(evidence.steps[6].dshNative.skillDidNotAddPluginTools === true, 'Skill must not add plugin tools')
  } finally {
    await control.ctx.fiber.dispose()
  }
}

runtime = await waitUrl(bin, env, home)
try {
  const v = await fetch(`${runtime.url}/api/view`).then((r) => r.json())
  const skill = (v.view.skills ?? []).find((s) => s.id === evidence.steps[6].import.candidateId)
  evidence.steps[6].wui = { lifecycle: skill?.lifecycle, userInvocable: skill?.userInvocable, catalog: v.view.skillCatalog }
  expect(skill?.lifecycle === 'active', 'WUI Skill v1 must be active')
  expect(v.view.skillCatalog?.state === 'ok', 'Skill catalog must be ok after activate')
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
v2InstructionBody = readFileSync(join(skillV2, 'SKILL.md'), 'utf8')
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
  expect(evidence.steps[7].afterRestartActive.some((s) => s.id === 'weekly-review@1.0.1' && s.digest === evidence.steps[7].digest), 'restart must keep weekly-review@1.0.1')
  assertBoundedPayload('WUI after Skill v1.0.1 restart', v)
  evidence.steps[12] = { afterV2Restart: true }
} finally {
  stop(bin, env, home)
  runtime.child.kill('SIGTERM')
}

const reactivated = sh(bin, ['self-extension', 'activate', evidence.steps[4].import.candidateId], { env })
evidence.steps[8] = { reactivated: JSON.parse(reactivated.stdout).state }
expect(evidence.steps[8].reactivated === 'active', 'plugin must reactivate before Safe Mode')
{
  const { bootAssistantControl, gatherWorkspaceSnapshot, projectMissionControl } = product
  const control = await bootAssistantControl({ home })
  try {
    const view = projectMissionControl(gatherWorkspaceSnapshot({ ctx: control.ctx, sessionId: 'soak' }))
    evidence.steps[8].pluginActiveBeforeSafe = {
      registry: control.ctx.capabilityRegistry.get('third-party/text-reverse', '1.0.0')?.status,
      toolPresent: Boolean(control.ctx.tools.get('text_reverse')),
      pluginsActive: (view.plugins ?? []).some((p) => p.owner === 'third-party/text-reverse'),
    }
    expect(evidence.steps[8].pluginActiveBeforeSafe.registry === 'active', 'plugin registry must be active before Safe Mode')
    expect(evidence.steps[8].pluginActiveBeforeSafe.toolPresent === true, 'text_reverse must be present before Safe Mode')
    expect(evidence.steps[8].pluginActiveBeforeSafe.pluginsActive === true, 'plugin card must be active before Safe Mode')
  } finally {
    await control.ctx.fiber.dispose()
  }
}

sh(bin, ['self-extension', 'safe-mode', 'enter'], { env })
runtime = await waitUrl(bin, env, home)
try {
  const cookie = cookieFrom(await fetch(`${runtime.url}/api/session`))
  const v = await fetch(`${runtime.url}/api/view`).then((r) => r.json())
  const doctor = sh(bin, ['doctor', '--home', home], { env })
  const skill = (v.view.skills ?? []).find((s) => s.id === 'weekly-review@1.0.1')
  const invoke = await fetch(`${runtime.url}/api/skill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      action: 'activate',
      confirm: true,
      id: skill?.id,
      name: skill?.name,
      version: skill?.version,
      digest: skill?.digest,
      generation: skill?.generation,
    }),
  })
  const invokeBody = await invoke.json()
  evidence.steps[8] = {
    ...evidence.steps[8],
    wuiSafe: v.view.systemState ?? v.view.runtime?.safeMode ?? v.view.safeMode,
    skillCatalog: v.view.skillCatalog ?? (v.view.skillsHealth && v.view.skillsHealth.catalog),
    invocable: (v.view.skills ?? []).filter((s) => s.userInvocable).map((s) => s.id),
    doctorSafe: redact(doctor.stdout).split('\n').filter((l) => /safe|skill|catalog/i.test(l)).slice(0, 12),
    recoveryPresent: Boolean(v.view.recovery?.actions?.length || v.view.rollback),
    invokeDenied: { status: invoke.status, error: invokeBody.error },
    pluginDuringSafe: {
      lifecycle: (v.view.extensions ?? []).find((e) => e.candidateId === evidence.steps[4].import.candidateId)?.lifecycle,
      mounted: (v.view.extensions ?? []).find((e) => e.candidateId === evidence.steps[4].import.candidateId)?.mounted,
      pluginsActive: (v.view.plugins ?? []).some((p) => p.owner === 'third-party/text-reverse'),
    },
  }
  expect(evidence.steps[8].wuiSafe === 'SAFE_MODE', 'WUI must report SAFE_MODE')
  expect(evidence.steps[8].skillCatalog?.state === 'withheld', 'Safe Mode catalog must be withheld')
  expect(evidence.steps[8].doctorSafe.some((l) => /safe-mode: true/.test(l)), 'doctor must report safe-mode: true')
  expect(evidence.steps[8].doctorSafe.some((l) => /catalog=withheld/.test(l)), 'doctor must report catalog=withheld')
  expect(evidence.steps[8].recoveryPresent === true, 'Safe Mode must keep Recovery/diagnostics visible')
  expect(invoke.status === 409 && invokeBody.error === 'catalog-withheld', 'active Skill must not be invokable while catalog is withheld')
  expect(evidence.steps[8].pluginDuringSafe.pluginsActive === false, 'Safe Mode must drop the active plugin card')
  expect(evidence.steps[8].pluginDuringSafe.lifecycle !== 'READY' && evidence.steps[8].pluginDuringSafe.lifecycle !== 'ACTIVE', 'Safe Mode must not present the plugin as active')
  assertBoundedPayload('WUI during Safe Mode', v)
} finally {
  stop(bin, env, home)
  runtime.child.kill('SIGTERM')
}

{
  const safe = await product.bootSafeModeRuntime({ home })
  try {
    const listed = await safe.ctx.skills.list({ cwd: home })
    evidence.steps[8].skillToolPresent = Boolean(safe.ctx.tools.get('skill'))
    evidence.steps[8].pluginToolDuringSafe = Boolean(safe.ctx.tools.get('text_reverse'))
    evidence.steps[8].dshListsWeeklyReview = listed.some((item) => item.name === 'weekly-review')
    expect(evidence.steps[8].skillToolPresent === false, 'Safe Mode must withhold the skill tool')
    expect(evidence.steps[8].pluginToolDuringSafe === false, 'Safe Mode must withhold the generated plugin tool')
    expect(evidence.steps[8].dshListsWeeklyReview === false, 'Safe Mode DSH catalog must not list weekly-review')
  } finally {
    await safe.ctx.fiber.dispose()
  }
}

const exited = sh(bin, ['self-extension', 'safe-mode', 'exit'], { env })
evidence.steps[9] = { exit: JSON.parse(exited.stdout) }
const doctorAfterExit = sh(bin, ['doctor', '--home', home], { env })
evidence.steps[9].doctor = redact(doctorAfterExit.stdout).split('\n').filter((l) => /safe|skill|catalog/i.test(l)).slice(0, 12)
expect(evidence.steps[9].exit.safeMode === false, 'safe-mode exit must clear Safe Mode')
expect(evidence.steps[9].doctor.some((l) => /catalog=ok(?:\s+candidates=\d+)?\s+active=weekly-review@1\.0\.1/.test(l)), 'after recover doctor must show catalog=ok and active=weekly-review@1.0.1')
{
  const { bootAssistantControl, gatherWorkspaceSnapshot, projectMissionControl } = product
  const control = await bootAssistantControl({ home })
  try {
    const view = projectMissionControl(gatherWorkspaceSnapshot({ ctx: control.ctx, sessionId: 'soak' }))
    const rec = control.ctx.candidateWorkspace.get(evidence.steps[4].import.candidateId)
    const approval = control.ctx.extensionGovernance.inspectApproval(rec.id)
    const row = (view.extensions ?? []).find((e) => e.candidateId === rec.id)
    evidence.steps[9].recoveredPlugin = {
      registry: control.ctx.capabilityRegistry.get('third-party/text-reverse', '1.0.0')?.status,
      toolPresent: Boolean(control.ctx.tools.get('text_reverse')),
      pluginsActive: (view.plugins ?? []).some((p) => p.owner === 'third-party/text-reverse'),
      lifecycle: row?.lifecycle,
      mounted: row?.mounted,
    }
    evidence.steps[10] = {
      backedUpPlugin: {
        id: rec.id,
        digest: rec.digest,
        lifecycle: row?.lifecycle,
        mounted: row?.mounted,
        registry: control.ctx.capabilityRegistry.get('third-party/text-reverse', '1.0.0')?.status,
        approval: approval?.decision,
        fingerprint: approval?.fingerprint,
      },
    }
    expect(evidence.steps[9].recoveredPlugin.registry === 'disabled', 'after Safe Mode exit the plugin must return to last-known-good disabled')
    expect(evidence.steps[9].recoveredPlugin.toolPresent === false, 'after Safe Mode exit text_reverse must stay absent with last-known-good')
    expect(evidence.steps[9].recoveredPlugin.pluginsActive === false, 'after Safe Mode exit the plugin card must not be active')
  } finally {
    await control.ctx.fiber.dispose()
  }
}

const backup = join(root, 'backup')
mkdirSync(backup)
sh(bin, ['self-extension', 'backup', backup], { env })
evidence.steps[10].backupOk = existsSync(join(backup, 'authority.json')) || existsSync(join(backup, 'authority'))
expect(evidence.steps[10].backupOk === true, 'self-extension backup must write Recovery Root artifacts')

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
    evidence.steps[10].tamperRejected = restoreError === 'PersistenceIntegrityError'
    evidence.steps[10].tamperError = restoreError
    expect(tampered === true, 'soak must tamper a backed-up plugin.js')
    expect(restoreError === 'PersistenceIntegrityError', 'tampered restore must throw PersistenceIntegrityError')
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
    expect(evidence.steps[10].goodRestore === true, 'untampered restore into a second empty Home must succeed')
  } finally {
    await control.ctx.fiber.dispose()
  }
}
{
  const restored = await product.bootAssistantControl({ home: destGood })
  try {
    const weekly = restored.ctx.skillLifecycle.list().find((s) => s.id === 'weekly-review@1.0.1')
    const plugin = restored.ctx.candidateWorkspace.list().find((c) => c.id === 'third-party--text-reverse@1.0.0')
    const { gatherWorkspaceSnapshot, projectMissionControl } = product
    const view = projectMissionControl(gatherWorkspaceSnapshot({ ctx: restored.ctx, sessionId: 'soak' }))
    const row = (view.extensions ?? []).find((e) => e.candidateId === plugin?.id)
    const approval = restored.ctx.extensionGovernance.inspectApproval(plugin.id)
    evidence.steps[10].restoredSkill = weekly
      ? { id: weekly.id, version: weekly.version, digest: weekly.digest, lifecycle: weekly.lifecycle }
      : null
    evidence.steps[10].restoredPlugin = {
      id: plugin?.id,
      digest: plugin?.digest,
      lifecycle: row?.lifecycle,
      mounted: row?.mounted,
      registry: restored.ctx.capabilityRegistry.get('third-party/text-reverse', '1.0.0')?.status,
      approval: approval?.decision,
      fingerprint: approval?.fingerprint,
    }
    const backed = evidence.steps[10].backedUpPlugin
    expect(weekly?.digest === evidence.steps[7].digest, 'restored Home must keep weekly-review@1.0.1 digest')
    expect(weekly?.lifecycle === 'active', 'restored Skill must remain active')
    expect(plugin?.id === 'third-party--text-reverse@1.0.0', 'restored Home must keep the plugin candidate')
    expect(evidence.steps[10].restoredPlugin.digest === backed.digest, 'restored plugin digest must match the backup')
    expect(evidence.steps[10].restoredPlugin.registry === backed.registry, 'restored plugin registry must match the backup')
    expect(evidence.steps[10].restoredPlugin.approval === backed.approval, 'restored plugin approval must match the backup')
    expect(evidence.steps[10].restoredPlugin.fingerprint === backed.fingerprint, 'restored plugin fingerprint must match the backup')
    const disabledLife = (lc) => lc === 'DISABLED_REACTIVATABLE' || lc === 'DISABLED_BLOCKED'
    expect(
      backed.registry === 'active'
        ? evidence.steps[10].restoredPlugin.lifecycle === backed.lifecycle
        : disabledLife(backed.lifecycle) && disabledLife(evidence.steps[10].restoredPlugin.lifecycle),
      'restored plugin disabled/active lifecycle must match the backup',
    )
  } finally {
    await restored.ctx.fiber.dispose()
  }
}

const help = sh(bin, ['--help'], { env })
const status = sh(bin, ['status', '--home', home], { env })
assertBoundedPayload('doctor after recover', doctorAfterExit.stdout, { allowIsolatedHome: true })
assertBoundedPayload('status', status.stdout, { allowIsolatedHome: true })
evidence.steps[12].finalDoctorStatus = true
evidence.identity = {
  tarball: tarballName.split('/').at(-1),
  sha256,
  bytes: st.size,
  files: packedFileCount,
  installedVersion: installedVer,
  helpMentionsTars: /tars-ng/i.test(help.stdout),
  packedHasSrc: existsSync(join(pkgRoot, 'src')),
  packedHasWebSrc: existsSync(join(pkgRoot, 'web')),
  layout: 'isolated prefix/home/workspace/sessions port 8803',
}
expect(evidence.identity.tarball === EXPECTED_TARBALL, 'packed filename must be dsh-assistant-0.4.0.tgz')
expect(evidence.identity.files === EXPECTED_FILES, 'packed file count must match the seal')
expect(evidence.identity.bytes === EXPECTED_BYTES, 'packed byte size must match the seal')
expect(evidence.identity.sha256 === EXPECTED_SHA256, 'packed SHA-256 must match the seal')
expect(evidence.identity.installedVersion === '0.4.0', 'installed package version must be 0.4.0')
expect(evidence.identity.packedHasSrc === false, 'packed install must not include src/')
expect(evidence.identity.packedHasWebSrc === false, 'packed install must not include web/ source')
expect(evidence.identity.helpMentionsTars === true, 'installed tars-ng --help must mention tars-ng')
expect(evidence.steps[7].doctorBeforeRestart.some((l) => /catalog=ok(?:\s+candidates=\d+)?\s+active=weekly-review@1\.0\.1/.test(l)), 'doctor before restart must show catalog=ok and active=weekly-review@1.0.1')
assertForbiddenEnvAbsent('runner process.env at end', process.env)
} catch (error) {
  evidence.errors.push(String(error?.stack ?? error).slice(0, 2000))
}

writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2))
console.log(JSON.stringify({ root, evidenceFile: join(root, 'evidence.json'), identity: evidence.identity, errors: evidence.errors }, null, 2))
process.exit(evidence.errors.length ? 1 : 0)
