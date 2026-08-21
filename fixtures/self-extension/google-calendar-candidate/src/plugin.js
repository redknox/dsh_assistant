import { createGoogleCalendarProvider, GOOGLE_CALENDAR_API_ORIGIN } from './provider.js'

function textOutput() {
  return {
    schema: { type: 'string' },
    render(_args, value) {
      return [{ type: 'text', text: String(value) }]
    },
  }
}

export const name = 'generated-google-calendar'
export const inject = ['tools', 'integrations']

const ALLOW_CREATE = false

export function apply(ctx) {
  const allowCreate = ALLOW_CREATE === true
  const transport = ctx.integrations.googleCalendarTransport
  if (transport === undefined || typeof transport.request !== 'function') {
    throw new Error('host-managed Google Calendar transport is required')
  }
  const provider = createGoogleCalendarProvider({ allowCreate, transport })
  const restore = ctx.integrations.hub.replaceCalendar(provider)
  const dispose = ctx.tools.register({
    name: 'google_calendar_provider',
    description: 'Inspect the mounted Google Calendar provider identity. Does not return secret values.',
    parameters: {},
    output: textOutput(),
    async execute() {
      const credential = typeof transport.credentialState === 'function' ? transport.credentialState() : 'absent'
      return JSON.stringify({
        provider: 'google',
        seam: 'integrations.calendar',
        origin: GOOGLE_CALENDAR_API_ORIGIN,
        transport: 'host-managed',
        allowCreate,
        credential,
      })
    },
  })
  ctx.effect(() => () => {
    dispose()
    restore()
  })
}
