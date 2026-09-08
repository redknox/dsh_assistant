import { createGoogleCalendarProvider, GOOGLE_CALENDAR_API_ORIGIN } from './provider.js'

function textOutput() {
  return {
    schema: { type: 'string' },
    render(_args, value) { return [{ type: 'text', text: String(value) }] },
  }
}

function json(value) { return JSON.stringify(value) }

export const name = 'generated-google-calendar'

const ALLOW_CREATE = false

export function apply(ctx) {
  const transport = {
    request(input) { return ctx.broker.request('host.google-calendar.read', { operation: 'request', ...input }) },
  }
  const provider = createGoogleCalendarProvider({ allowCreate: false, transport })
  const tools = [
    {
      name: 'google_calendar_provider',
      description: 'Inspect the host-managed Google Calendar connection without exposing credentials.',
      parameters: {},
      async execute() {
        const status = await ctx.broker.request('host.google-calendar.read', { operation: 'status' })
        return json({ ...status, seam: 'host.google-calendar.read', origin: GOOGLE_CALENDAR_API_ORIGIN, allowCreate: ALLOW_CREATE })
      },
    },
    {
      name: 'google_calendar_events_list',
      description: 'List Google Calendar events through the approved host Broker.',
      parameters: { from: { type: 'string', required: true }, to: { type: 'string', required: true } },
      async execute(args) { return json(await provider.listEvents(args)) },
    },
    {
      name: 'google_calendar_event_get',
      description: 'Read one Google Calendar event through the approved host Broker.',
      parameters: { id: { type: 'string', required: true } },
      async execute(args) { return json(await provider.getEvent(String(args.id))) },
    },
    {
      name: 'google_calendar_freebusy',
      description: 'Read Google Calendar busy windows through the approved host Broker.',
      parameters: { from: { type: 'string', required: true }, to: { type: 'string', required: true }, timeZone: { type: 'string' } },
      async execute(args) { return json(await provider.freeBusy(args)) },
    },
    {
      name: 'google_calendar_propose_event',
      description: 'Create a side-effect-free Google Calendar event proposal.',
      parameters: {
        title: { type: 'string', required: true }, start: { type: 'string', required: true }, end: { type: 'string', required: true },
        timeZone: { type: 'string' }, calendarId: { type: 'string' }, description: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' } },
      },
      async execute(args) { return json(await provider.proposeCreateEvent(args)) },
    },
  ]
  // @write-capability:start
  if (ALLOW_CREATE) tools.push({
    name: 'google_calendar_event_create',
    description: 'Request one governed Google Calendar event creation. Returns a pending confirmation until the user approves.',
    parameters: {
      title: { type: 'string', required: true }, start: { type: 'string', required: true }, end: { type: 'string', required: true },
      timeZone: { type: 'string' }, calendarId: { type: 'string' }, description: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' } }, idempotencyKey: { type: 'string' },
    },
    async execute(args) { return json(await ctx.broker.request('host.google-calendar.mutate', { operation: 'create', event: args })) },
  })
  // @write-capability:end
  const disposers = tools.map((tool) => ctx.tools.register({ ...tool, output: textOutput() }))
  ctx.effect(() => () => { for (const dispose of disposers.reverse()) dispose() })
}
