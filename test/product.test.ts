import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { CallId } from '@deepseek-ai/dsh-llm'
import { createLiveGoogleCalendarTransport } from '../src/adapters/integrations/google-calendar-transport.js'
import { IntegrationError } from '../src/domain/integrations/types.js'
import { runProductCli } from '../src/product/cli.js'
import { inspectEnvFile } from '../src/product/env.js'
import { ensureProductHome, resolveProductHome } from '../src/product/home.js'
import { bootAssistantControl } from '../src/runtime/boot.js'

function isolatedHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'tars-ng-product-'))
}

describe('TARS-NG product runtime', () => {
  it('resolves TARS_NG_HOME before DSH_ASSISTANT_HOME and does not use cwd', () => {
    const previousTars = process.env.TARS_NG_HOME
    const previousLegacy = process.env.DSH_ASSISTANT_HOME
    const tars = isolatedHome()
    const legacy = isolatedHome()
    try {
      process.env.TARS_NG_HOME = tars
      process.env.DSH_ASSISTANT_HOME = legacy
      assert.equal(resolveProductHome(), path.resolve(tars))
      delete process.env.TARS_NG_HOME
      assert.equal(resolveProductHome(), path.resolve(legacy))
      assert.notEqual(resolveProductHome(), process.cwd())
    } finally {
      if (previousTars === undefined) delete process.env.TARS_NG_HOME
      else process.env.TARS_NG_HOME = previousTars
      if (previousLegacy === undefined) delete process.env.DSH_ASSISTANT_HOME
      else process.env.DSH_ASSISTANT_HOME = previousLegacy
    }
  })

  it('loads env-file keys without exposing secret values in doctor output', async () => {
    const home = isolatedHome()
    const userHome = isolatedHome()
    const layout = ensureProductHome(home)
    writeFileSync(layout.envFile, 'DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN=ya29.pack-test-secret\nGOOGLE_SEARCH_API_KEY=search-secret-value\n', { mode: 0o600 })
    chmodSync(layout.envFile, 0o600)
    const previous = {
      token: process.env.DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN,
      search: process.env.GOOGLE_SEARCH_API_KEY,
      home: process.env.HOME,
      xdgConfig: process.env.XDG_CONFIG_HOME,
      tarsHome: process.env.TARS_NG_HOME,
    }
    delete process.env.DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN
    delete process.env.GOOGLE_SEARCH_API_KEY
    process.env.HOME = userHome
    process.env.XDG_CONFIG_HOME = path.join(userHome, '.config')
    const lines: string[] = []
    try {
      const code = await runProductCli(['doctor', '--home', home], {
        log: (text) => lines.push(text),
        error: (text) => lines.push(text),
      })
      const text = lines.join('\n')
      assert.equal(code, 0)
      assert.match(text, /DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN: present/)
      assert.match(text, /GOOGLE_SEARCH_API_KEY: present/)
      assert.match(text, /GOOGLE_SEARCH_ENGINE_ID: missing/)
      assert.doesNotMatch(text, /ya29\.pack-test-secret|search-secret-value/)
    } finally {
      if (previous.token === undefined) delete process.env.DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN
      else process.env.DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN = previous.token
      if (previous.search === undefined) delete process.env.GOOGLE_SEARCH_API_KEY
      else process.env.GOOGLE_SEARCH_API_KEY = previous.search
      if (previous.home === undefined) delete process.env.HOME
      else process.env.HOME = previous.home
      if (previous.xdgConfig === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous.xdgConfig
      if (previous.tarsHome === undefined) delete process.env.TARS_NG_HOME
      else process.env.TARS_NG_HOME = previous.tarsHome
    }
  })

  it('warns when an env file is group/world readable', () => {
    const dir = isolatedHome()
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'env')
    writeFileSync(file, 'FOO=bar\n', { mode: 0o644 })
    chmodSync(file, 0o644)
    const loaded = inspectEnvFile(file)
    assert.equal(loaded.loaded, true)
    assert.equal(loaded.insecurePermissions, true)
  })

  it('keeps fixture calendar unavailable in product mode', async () => {
    const { ctx } = await bootAssistantControl({ allowFixtures: false })
    try {
      const result = await ctx.tools.execute({
        callId: CallId('product-cal-unavail'),
        name: 'calendar_list_events',
        arguments: { from: '2026-08-21T00:00:00.000Z', to: '2026-08-22T00:00:00.000Z' },
        signal: AbortSignal.timeout(5000),
      })
      const body = JSON.parse(String(result.value)) as { error?: { code?: string } }
      assert.equal(body.error?.code, 'unavailable')
      assert.doesNotMatch(String(result.value), /Team standup|Google standup/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses live Calendar calls when the access token is missing and does not fetch', async () => {
    const transport = createLiveGoogleCalendarTransport({
      getAccessToken: () => undefined,
      fetchImpl: async () => {
        throw new Error('fetch must not run without a token')
      },
    })
    await assert.rejects(
      () => transport.request({ method: 'GET', path: '/calendar/v3/calendars/primary/events' }),
      (error: unknown) => error instanceof IntegrationError
        && error.code === 'unavailable'
        && /DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN/.test(error.message)
        && !/ya29|Bearer /.test(error.message),
    )
  })
})
