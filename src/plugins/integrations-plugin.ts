import { Service, type Context } from '@deepseek-ai/cordis'
import { FakeIntegrationSuite } from '../adapters/integrations/fake-providers.js'
import { createGoogleCalendarProvider, createHostGoogleCalendarTransport } from '../adapters/integrations/google-calendar.js'
import { createSandboxFilesProvider } from '../adapters/integrations/sandbox-files.js'
import { createSandboxTasksProvider } from '../adapters/integrations/sandbox-tasks.js'
import { applySandboxAuthorityStamp } from '../domain/files/sandbox-authority.js'
import { inspectSandboxRoot } from '../domain/files/sandbox-root.js'
import type { CapabilityRegistry } from '../domain/registry/index.js'
import { IntegrationHub } from '../domain/integrations/hub.js'
import type { BoundedGoogleCalendarTransport } from '../domain/integrations/google-api.js'
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
    }
  }
  const googleCalendarTransport = createHostGoogleCalendarTransport()
  if (liveCalendarConfigured()) {
    fakes.hub.replaceCalendar(createGoogleCalendarProvider({
      transport: googleCalendarTransport,
      allowCreate: true,
    }))
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
  ctx.effect(() => registerIntegrationTools(ctx.tools, fakes.hub))
}
