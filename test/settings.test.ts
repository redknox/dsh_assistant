import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ProductSettings } from '../src/product/settings.js'
import { handleWebUiSettingsRequest } from '../src/product/web-ui-settings.js'

function withSettings(
  contents: string,
  run: (settings: ProductSettings, envFile: string) => void,
  env: NodeJS.ProcessEnv = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'tars-settings-'))
  const envFile = join(root, 'config', 'env')
  try {
    mkdirSync(join(root, 'config'), { recursive: true })
    if (contents !== '') {
      writeFileSync(envFile, contents)
    }
    run(new ProductSettings(envFile, env), envFile)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('Product settings', () => {
  it('never exposes secrets and identifies where values are managed', () => {
    withSettings('DEEPSEEK_API_KEY=home-secret\nDSH_ASSISTANT_FEISHU_MODE=cli\n', (settings) => {
      const snapshot = settings.inspect()
      const secret = snapshot.fields.find((field) => field.id === 'DEEPSEEK_API_KEY')!
      const feishu = snapshot.fields.find((field) => field.id === 'DSH_ASSISTANT_FEISHU_MODE')!
      const external = snapshot.fields.find((field) => field.id === 'DSH_ASSISTANT_FEISHU_PROFILE')!
      assert.deepEqual({ present: secret.present, source: secret.source, editable: secret.editable }, { present: true, source: 'home', editable: true })
      assert.equal(secret.value, undefined)
      assert.equal(feishu.value, 'cli')
      assert.deepEqual({ present: external.present, source: external.source, editable: external.editable }, { present: true, source: 'environment', editable: false })
      assert.doesNotMatch(JSON.stringify(snapshot), /home-secret/)
      assert.match(JSON.stringify(snapshot), /external-profile/)
    }, { DSH_ASSISTANT_FEISHU_PROFILE: 'external-profile' })
  })

  it('atomically updates allowlisted fields while preserving unrelated configuration', () => {
    withSettings('# operator note\nUNRELATED=value\nDSH_ASSISTANT_FEISHU_MODE=cli\n', (settings, envFile) => {
      const before = settings.inspect()
      const after = settings.update({
        revision: before.revision,
        changes: [
          { id: 'DSH_ASSISTANT_FEISHU_MODE', clear: true },
          { id: 'DSH_ASSISTANT_KNOWLEDGE_OBSIDIAN_VAULT', value: '/srv/tars-vault' },
          { id: 'DEEPSEEK_API_KEY', value: 'replacement-secret' },
        ],
      })
      const contents = readFileSync(envFile, 'utf8')
      assert.match(contents, /# operator note\nUNRELATED=value/)
      assert.doesNotMatch(contents, /DSH_ASSISTANT_FEISHU_MODE/)
      assert.match(contents, /DSH_ASSISTANT_KNOWLEDGE_OBSIDIAN_VAULT=\/srv\/tars-vault/)
      assert.match(contents, /DEEPSEEK_API_KEY=replacement-secret/)
      assert.equal(statSync(envFile).mode & 0o777, 0o600)
      assert.equal(after.restartRequired, true)
      assert.doesNotMatch(JSON.stringify(after), /replacement-secret/)
    })
  })

  it('rejects stale, invalid, and externally managed updates', () => {
    withSettings('', (settings, envFile) => {
      const initial = settings.inspect()
      assert.throws(() => settings.update({ revision: initial.revision, changes: [{ id: 'UNKNOWN', value: 'x' }] }), /invalid-settings-field/)
      assert.throws(() => settings.update({ revision: initial.revision, changes: [{ id: 'DSH_ASSISTANT_SANDBOX_ROOT', value: 'relative' }] }), /invalid-settings-value/)
      writeFileSync(envFile, 'UNRELATED=changed\n')
      assert.throws(() => settings.update({ revision: initial.revision, changes: [{ id: 'DSH_ASSISTANT_FEISHU_MODE', value: 'cli' }] }), /stale-settings/)
    })
    withSettings('', (settings) => {
      const initial = settings.inspect()
      assert.throws(() => settings.update({ revision: initial.revision, changes: [{ id: 'DSH_ASSISTANT_FEISHU_PROFILE', value: 'local' }] }), /externally-managed-setting/)
    }, { DSH_ASSISTANT_FEISHU_PROFILE: 'global' })
  })
})

describe('Web UI settings handler', () => {
  it('supports snapshots and version-bound writes', async () => {
    const snapshot = { revision: 'r1', fields: [], restartRequired: false, envFileReady: true }
    let updated = false
    const context = {
      inspect: () => snapshot,
      update: () => { updated = true; return { ...snapshot, revision: 'r2', restartRequired: true } },
    }
    const get = await handleWebUiSettingsRequest({ method: 'GET', pathname: '/api/settings', readJson: async () => undefined }, context)
    assert.deepEqual(get, { status: 200, body: snapshot })
    const post = await handleWebUiSettingsRequest({
      method: 'POST',
      pathname: '/api/settings',
      readJson: async () => ({ revision: 'r1', changes: [{ id: 'DEEPSEEK_API_KEY', value: 'new' }] }),
    }, context)
    assert.equal(post?.status, 200)
    assert.equal(updated, true)
  })

  it('rejects malformed and stale writes', async () => {
    const context = {
      inspect: () => ({ revision: 'r1', fields: [], restartRequired: false, envFileReady: true }),
      update: () => { throw new Error('stale-settings') },
    }
    const malformed = await handleWebUiSettingsRequest({ method: 'POST', pathname: '/api/settings', readJson: async () => ({}) }, context)
    assert.equal(malformed?.status, 400)
    const stale = await handleWebUiSettingsRequest({ method: 'POST', pathname: '/api/settings', readJson: async () => ({ revision: 'r0', changes: [] }) }, context)
    assert.equal(stale?.status, 409)
  })
})
