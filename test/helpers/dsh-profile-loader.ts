import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  boot,
  composeEntries,
  healProfilesModuleFallback,
  initProfile,
  loadProfile,
  renderConfigDump,
  resolveProfileDir,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'

const root = join(import.meta.dirname, '../..')
const PROFILE_ROOT = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml.
[]
`

/** Smoke overlay: stop HMR (needs Node internals the test runner does not expose) and disable the local job ticker. */
const SMOKE_PROFILE_PATCH = `- id: hmr
  disabled: true
- id: dsh-assistant
  config:
    jobs:
      autoTickMs: null
`

function ensurePublishedEntry() {
  const dist = join(root, 'dist/index.js')
  const source = join(root, 'src/index.ts')
  if (!existsSync(dist) || statSync(source).mtimeMs > statSync(dist).mtimeMs) {
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' })
  }
}

function ensureHostPackageLink() {
  const link = join(root, 'node_modules', 'dsh-assistant')
  try {
    symlinkSync(root, link)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** Isolated $DSH_HOME profile composed through official rc.8 app-boot APIs. */
export async function withDshAssistantProfile<T>(
  run: (ready: {
    profile: Profile
    dump: string
    composedIds: string[]
    bootProfile: () => Promise<Context>
  }) => Promise<T>,
): Promise<T> {
  ensurePublishedEntry()
  ensureHostPackageLink()
  const home = await mkdtemp(join(tmpdir(), 'dsh-assistant-profile-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const dir = resolveProfileDir('assistant', home)
    initProfile(dir, ['@deepseek-ai/dsh-base', 'dsh-assistant'])
    writeFileSync(join(dir, 'cordis.yml'), PROFILE_ROOT)
    writeFileSync(join(dir, 'cordis.patch.yml'), SMOKE_PROFILE_PATCH)
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    const profileLink = join(dir, 'node_modules', 'dsh-assistant')
    if (!existsSync(profileLink)) symlinkSync(root, profileLink)

    const installAnchor = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-base/package.json'))
    healProfilesModuleFallback(installAnchor, home)
    const profile = loadProfile('dsh', 'assistant', installAnchor, home)
    const dump = renderConfigDump(
      'dsh',
      join(dir, 'cordis.yml'),
      [
        ...profile.layers.map((layer) => ({ label: layer.packageName, patches: layer.patches })),
        { label: profile.patchPath, patches: profile.patches },
      ],
      () => undefined,
    )
    const composedIds = composeEntries([
      ...profile.layers.map((layer) => layer.patches),
      profile.patches,
    ]).flatMap((row) => (typeof row.id === 'string' ? [row.id] : []))
    const patches = [
      ...profile.layers.flatMap((layer) => layer.patches),
      ...profile.patches,
    ]
    return await run({
      profile,
      dump,
      composedIds,
      bootProfile: () => boot('dsh', join(dir, 'cordis.yml'), structuredClone(patches)),
    })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
}
