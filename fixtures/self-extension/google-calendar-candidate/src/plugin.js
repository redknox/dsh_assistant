import { createFixtureTransport, createGoogleCalendarProvider, GOOGLE_CALENDAR_API_ORIGIN } from './provider.js'

function textOutput() {
  return {
    schema: { type: 'string' },
    render(_args, value) {
      return [{ type: 'text', text: String(value) }]
    },
  }
}

function accessToken() {
  const value = process.env.DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN
  return typeof value === 'string' && value !== '' ? value : undefined
}

export const name = 'generated-google-calendar'
export const inject = ['tools', 'integrations']

const ALLOW_CREATE = false

export function apply(ctx) {
  const allowCreate = ALLOW_CREATE === true
  const mode = process.env.DSH_ASSISTANT_GOOGLE_CALENDAR_MODE ?? 'fixture'
  if (mode !== 'fixture') {
    throw new Error('live Google Calendar credentials are not available during candidate validation or offline tests')
  }
  const provider = createGoogleCalendarProvider({
    allowCreate,
    transport: createFixtureTransport(),
    getAccessToken: accessToken,
  })
  const restore = ctx.integrations.hub.replaceCalendar(provider)
  const dispose = ctx.tools.register({
    name: 'google_calendar_provider',
    description: 'Inspect the mounted Google Calendar provider identity. Does not return secret values.',
    parameters: {},
    output: textOutput(),
    async execute() {
      return JSON.stringify({
        provider: 'google',
        seam: 'integrations.calendar',
        origin: GOOGLE_CALENDAR_API_ORIGIN,
        allowCreate,
        credential: accessToken() === undefined ? 'absent' : 'injected',
      })
    },
  })
  ctx.effect(() => () => {
    dispose()
    restore()
  })
}
