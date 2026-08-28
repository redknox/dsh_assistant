import { Service, type Context } from '@deepseek-ai/cordis'
import { FakeIntegrationSuite } from '../adapters/integrations/fake-providers.js'
import { createGoogleCalendarProvider, createHostGoogleCalendarTransport } from '../adapters/integrations/google-calendar.js'
import { createSandboxFilesProvider } from '../adapters/integrations/sandbox-files.js'
import { createSandboxTasksProvider } from '../adapters/integrations/sandbox-tasks.js'
import { createFeishuCalendarProvider } from '../adapters/integrations/feishu-calendar.js'
import { createFeishuMeetingNotesProvider, type MeetingNotesProvider } from '../adapters/integrations/feishu-meeting-notes.js'
import {
  createFeishuContactsProvider,
  createFeishuMailProvider,
  createHostFeishuCliRunner,
  FEISHU_CALENDAR_SCOPES,
  FEISHU_MAIL_CONTACT_SCOPES,
  FEISHU_MEETING_NOTES_SCOPES,
  inspectFeishuCli,
} from '../adapters/integrations/feishu-cli.js'
import { applySandboxAuthorityStamp } from '../domain/files/sandbox-authority.js'
import { inspectSandboxRoot } from '../domain/files/sandbox-root.js'
import type { CapabilityRegistry } from '../domain/registry/index.js'
import { IntegrationHub } from '../domain/integrations/hub.js'
import type { BoundedGoogleCalendarTransport } from '../domain/integrations/google-api.js'
import { DEFAULT_FEISHU_PROFILE } from '../product/constants.js'
import { registerIntegrationTools } from './integration-tools.js'

function liveCalendarConfigured(): boolean {
  return process.env.DSH_ASSISTANT_GOOGLE_CALENDAR_MODE === 'live'
    && Boolean(process.env.DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    integrations: IntegrationsService
  }
}

export class IntegrationsService extends Service {
  constructor(
    ctx: Context,
    readonly hub: IntegrationHub,
    readonly googleCalendarTransport: BoundedGoogleCalendarTransport,
  ) {
    super(ctx, 'integrations')
  }
}

export interface IntegrationsPluginConfig {
  /** Default true for tests. Product CLI sets false so fixture data is not presented as live. */
  readonly allowFixtures?: boolean
}

export const name = 'dsh-assistant-integrations'
export const inject = ['systemPrompt', 'tools']

const FIXTURE_CAPABILITIES = ['calendar', 'mail', 'contacts', 'files', 'tasks'] as const

export async function apply(ctx: Context, config: IntegrationsPluginConfig = {}) {
  const fakes = new FakeIntegrationSuite()
  if (config.allowFixtures === false) {
    for (const capability of FIXTURE_CAPABILITIES) {
      fakes.state.unavailable[capability] = `${capability} is not configured`
      fakes.state.notConfigured.add(capability)
    }
  }
  const googleCalendarTransport = createHostGoogleCalendarTransport()
  let meetingNotes: MeetingNotesProvider | undefined
  if (liveCalendarConfigured()) {
    fakes.hub.replaceCalendar(createGoogleCalendarProvider({
      transport: googleCalendarTransport,
      allowCreate: true,
    }))
  }
  if (process.env.DSH_ASSISTANT_FEISHU_MODE === 'cli' || process.env.DSH_ASSISTANT_FEISHU_CALENDAR_MODE === 'cli') {
    const runner = createHostFeishuCliRunner({
      profile: process.env.DSH_ASSISTANT_FEISHU_PROFILE ?? DEFAULT_FEISHU_PROFILE,
    })
    if (process.env.DSH_ASSISTANT_FEISHU_MODE === 'cli') {
      fakes.state.notConfigured.delete('mail')
      fakes.state.notConfigured.delete('contacts')
      const availability = await inspectFeishuCli(runner, FEISHU_MAIL_CONTACT_SCOPES)
      if (availability.available) {
        fakes.hub.replaceMail(createFeishuMailProvider({ runner }))
        fakes.hub.replaceContacts(createFeishuContactsProvider({ runner }))
        delete fakes.state.unavailable.mail
        delete fakes.state.unavailable.contacts
      } else {
        fakes.state.unavailable.mail = availability.reason ?? 'Feishu user authorization is unavailable'
        fakes.state.unavailable.contacts = availability.reason ?? 'Feishu user authorization is unavailable'
      }
    }
    if (process.env.DSH_ASSISTANT_FEISHU_CALENDAR_MODE === 'cli') {
      const calendarAvailability = await inspectFeishuCli(runner, FEISHU_CALENDAR_SCOPES)
      if (calendarAvailability.available) {
        fakes.hub.replaceCalendar(createFeishuCalendarProvider({ runner, allowCreate: true }))
        delete fakes.state.unavailable.calendar
      } else {
        fakes.state.unavailable.calendar = calendarAvailability.reason ?? 'Feishu Calendar authorization is unavailable'
      }
      const meetingNotesAvailability = await inspectFeishuCli(runner, FEISHU_MEETING_NOTES_SCOPES)
      if (meetingNotesAvailability.available) meetingNotes = createFeishuMeetingNotesProvider({ runner })
    }
  }
  const sandbox = inspectSandboxRoot(process.env.DSH_ASSISTANT_SANDBOX_ROOT)
  if (sandbox.configured && sandbox.ok) {
    fakes.hub.replaceFiles(createSandboxFilesProvider(sandbox.root))
    fakes.hub.replaceTasks(createSandboxTasksProvider(sandbox.root))
  } else if (sandbox.configured && config.allowFixtures === false) {
    fakes.state.unavailable.files = sandbox.reason
    fakes.state.unavailable.tasks = sandbox.reason
  }
  const registry = ctx.get('capabilityRegistry') as CapabilityRegistry | undefined
  if (registry) applySandboxAuthorityStamp(registry, sandbox.configured && sandbox.ok)
  await ctx.plugin(class extends IntegrationsService {
    constructor(scope: Context) {
      super(scope, fakes.hub, googleCalendarTransport)
    }
  })
  ctx.systemPrompt.section({
    name: 'product:integrations',
    order: 40,
    text: sandbox.configured && sandbox.ok
      ? 'Personal integrations are provider-neutral. Files and tasks are confined to the configured operator sandbox. Use sandbox-relative paths only. Absolute paths and parent traversal are rejected. Prefer read tools for lookup. Proposal tools do not execute. Execution tools (files_write, files_delete, tasks_create) run only through the policy/confirmation path.'
      : 'Personal integrations are provider-neutral. Prefer read tools for lookup. Proposal tools do not execute. Execution tools run only through the policy/confirmation path.',
  })
  ctx.effect(() => registerIntegrationTools(ctx.tools, fakes.hub, meetingNotes))
}
