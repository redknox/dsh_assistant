import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { RecoveryRoot } from '../domain/governance/root.js'
import { acknowledgementOf } from '../domain/workspace/approvals.js'
import { redactText } from '../domain/workspace/redact.js'
import { AssistantControlSurface } from '../ui/controller.js'
import type { MissionControlView } from '../domain/workspace/types.js'
import { PRODUCT_UI_SESSION_ID } from './constants.js'
import type { LiveSessionHost } from './session-lifecycle.js'
import {
  originAllowed,
  resolveWebUiListen,
  type WebUiListenOptions,
} from './web-ui-protocol.js'
import { handleRuntimeControlRequest, type WebUiRuntimeControl } from './web-ui-runtime-control.js'
import { handleWebUiConversationRequest } from './web-ui-conversations.js'
import { handleWebUiApprovalRequest } from './web-ui-approvals.js'
import { handleWebUiActivationRequest } from './web-ui-activations.js'
import { handleWebUiGovernanceLifecycleRequest } from './web-ui-governance-lifecycle.js'
import { WebUiGovernanceMutations } from './web-ui-governance-mutations.js'
import { handleWebUiSkillRequest, type WebUiSkillCommand } from './web-ui-skills.js'
import { WebUiHttpTransport } from './web-ui-http.js'
import type { ProductSettings } from './settings.js'
import { handleWebUiSettingsRequest } from './web-ui-settings.js'
import { handleWebUiTaskControlRequest } from './web-ui-task-control.js'
import { handleWebUiWorkbenchRequest } from './web-ui-workbench.js'
import type { CandidateWorkbench } from '../domain/workbench/index.js'
import type { ExpenseRiskReviewModule } from '../domain/expense-review/index.js'
import { handleWebUiExpenseReviewRequest } from './web-ui-expense-review.js'

export type { WebUiRuntimeControl } from './web-ui-runtime-control.js'

export interface WebUiServerOptions extends WebUiListenOptions {
  readonly surface: AssistantControlSurface
  readonly recoveryRoot: RecoveryRoot
  readonly diagnostics?: unknown
  readonly assetRoot?: string
  readonly runtimeControl?: WebUiRuntimeControl
  readonly sessionHost?: LiveSessionHost
  readonly settings?: ProductSettings
  readonly workbench?: Pick<CandidateWorkbench,
    'list' | 'inspectSpecification' | 'inspectSpecificationEvaluation' | 'defineSpecification' | 'reviseSpecification' | 'compareSpecifications'>
  readonly workbenchMutable?: boolean
  readonly expenseReview?: Pick<ExpenseRiskReviewModule, 'inspect' | 'review'>
}

export interface WebUiServer {
  readonly url: string
  readonly host: string
  readonly port: number
  notify(): void
  close(): Promise<void>
}

export { defaultWebAssetRoot } from './web-ui-http.js'

export function startWebUiServer(options: WebUiServerOptions): Promise<WebUiServer> {
  const listen = resolveWebUiListen(process.env, options)
  let url = ''
  let poll: ReturnType<typeof setInterval> | undefined

  const snapshot = (): MissionControlView => {
    const view = options.surface.workspace()
    const pending = view.approvals.filter((card) => card.status === 'pending').map((card) => card.id)
    if (pending.length > 0) options.sessionHost?.noteApprovals(pending)
    return options.surface.workspace()
  }

  const envelope = (extra: { readonly acknowledgement?: { readonly text: string } } = {}) => ({
    view: snapshot(),
    webUi: url,
    commands: options.surface.listCommands(),
    toolCatalog: options.surface.listTools(),
    ...(extra.acknowledgement ? { acknowledgement: extra.acknowledgement } : {}),
  })

  const transport = new WebUiHttpTransport(options.assetRoot, envelope)
  const sendJson = transport.sendJson.bind(transport)
  const broadcast = transport.broadcast.bind(transport)

  const acknowledgementFor = (confirmationId: string) => {
    const resolution = snapshot().approvalResolutions.find((item) => item.confirmationId === confirmationId)
    return resolution ? { text: redactText(acknowledgementOf(resolution).text) } : undefined
  }

  const rejectOrigin = (req: IncomingMessage, res: ServerResponse): boolean => {
    const origin = req.headers.origin
    if (originAllowed(typeof origin === 'string' ? origin : undefined, listen.host, boundPort())) return false
    sendJson(res, 403, { error: 'unsupported origin' })
    return true
  }

  const rejectUntrustedMutation = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (transport.mutationTrusted(req.method, req.headers.cookie)) return false
    sendJson(res, 403, { error: 'untrusted session' })
    return true
  }

  const boundPort = (): number => {
    const address = server.address()
    return typeof address === 'object' && address ? address.port : listen.port
  }

  const mutations = new WebUiGovernanceMutations(() => options.recoveryRoot.inspect())

  const executeSkillCommand = (command: WebUiSkillCommand) => {
    const human = options.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
    switch (command.action) {
      case 'approve':
        return options.recoveryRoot.approveSkill(command.id, command.fingerprint, human)
      case 'reject':
        return options.recoveryRoot.rejectSkill(command.id, command.fingerprint, human)
      case 'activate':
        return options.recoveryRoot.activateSkill(command.id, human)
      case 'reactivate':
        return options.recoveryRoot.reactivateSkill(command.name, command.version, human)
      case 'disable':
        return options.recoveryRoot.disableSkill(command.name, human, command.dependents)
      case 'uninstall':
        return options.recoveryRoot.uninstallSkill(command.id, human, command.dependents)
      case 'rollback':
        return options.recoveryRoot.rollbackSkill(human)
    }
  }

  const server: Server = createServer(async (req, res) => {
    try {
      if (rejectOrigin(req, res)) return
      const hostHeader = req.headers.host ?? `${listen.host}:${boundPort()}`
      const requestUrl = new URL(req.url ?? '/', `http://${hostHeader}`)
      const runtimeControl = await handleRuntimeControlRequest({
        method: req.method,
        pathname: requestUrl.pathname,
        readJson: () => transport.readJson(req),
      }, options.runtimeControl)
      if (runtimeControl) {
        sendJson(res, runtimeControl.status, runtimeControl.body)
        if (runtimeControl.afterSend) setImmediate(runtimeControl.afterSend)
        return
      }
      if (rejectUntrustedMutation(req, res)) return
      if (req.method === 'GET' && requestUrl.pathname === '/api/session') {
        sendJson(res, 200, { ok: true, webUi: url }, true)
        return
      }
      if (req.method === 'GET' && requestUrl.pathname === '/api/view') {
        sendJson(res, 200, envelope())
        return
      }
      if (req.method === 'GET' && requestUrl.pathname === '/api/events') {
        transport.openEvents(req, res)
        return
      }
      if (requestUrl.pathname === '/api/settings') {
        if (!transport.sessionTrusted(req.headers.cookie)) {
          sendJson(res, 403, { error: 'untrusted session' })
          return
        }
        if (!options.settings) {
          sendJson(res, 503, { error: 'settings-unavailable' })
          return
        }
        const settings = await handleWebUiSettingsRequest({
          method: req.method,
          pathname: requestUrl.pathname,
          readJson: () => transport.readJson(req),
        }, {
          inspect: () => options.settings!.inspect(),
          update: (input) => options.settings!.update(input),
        })
        if (settings) sendJson(res, settings.status, settings.body)
        return
      }
      if (req.method === 'GET' && requestUrl.pathname === '/api/session-search' && !transport.sessionTrusted(req.headers.cookie)) {
        sendJson(res, 403, { error: 'untrusted session' })
        return
      }
      if (requestUrl.pathname.startsWith('/api/workbench')) {
        if (!transport.sessionTrusted(req.headers.cookie)) {
          sendJson(res, 403, { error: 'untrusted session' })
          return
        }
        if (!options.workbench) {
          sendJson(res, 503, { error: 'workbench-unavailable' })
          return
        }
        const workbench = await handleWebUiWorkbenchRequest({
          method: req.method,
          pathname: requestUrl.pathname,
          query: (name) => requestUrl.searchParams.get(name) ?? undefined,
          readJson: () => transport.readJson(req),
        }, {
          workbench: options.workbench,
          mutable: options.workbenchMutable === true,
        })
        if (workbench) {
          sendJson(res, workbench.status, workbench.body)
          if (workbench.broadcast) broadcast()
          return
        }
      }
      if (requestUrl.pathname === '/api/expense-review') {
        if (!transport.sessionTrusted(req.headers.cookie)) {
          sendJson(res, 403, { error: 'untrusted session' })
          return
        }
        if (!options.expenseReview) {
          sendJson(res, 503, { error: 'expense-review-unavailable' })
          return
        }
        const expenseReview = await handleWebUiExpenseReviewRequest({
          method: req.method,
          pathname: requestUrl.pathname,
          readJson: () => transport.readJson(req),
        }, options.expenseReview)
        if (expenseReview) sendJson(res, expenseReview.status, expenseReview.body)
        return
      }
      const taskControl = await handleWebUiTaskControlRequest({
        method: req.method,
        pathname: requestUrl.pathname,
        readJson: () => transport.readJson(req),
      }, {
        controlGoal: (action, id, revision) => options.surface.controlGoal(action, id, revision),
        controlPlan: (active) => options.surface.controlPlan(active),
        answerQuestion: (id, selected, custom) => options.surface.answerTaskQuestion(id, selected, custom),
        project: (acknowledgement) => envelope({ acknowledgement }),
      })
      if (taskControl) {
        sendJson(res, taskControl.status, taskControl.body)
        if (taskControl.broadcast) broadcast()
        return
      }
      const conversation = await handleWebUiConversationRequest({
        method: req.method,
        pathname: requestUrl.pathname,
        query: requestUrl.searchParams.get('query') ?? undefined,
        readJson: () => transport.readJson(req),
      }, {
        currentSessionId: () => options.surface.sessionId,
        sendMessage: (text) => options.surface.sendMessage(text),
        listCommands: () => options.surface.listCommands(),
        executeCommand: (line, signal) => options.surface.executeCommand(line, signal),
        listFileReferences: (query, signal) => options.surface.listFileReferences(query, signal),
        searchSessions: (query, signal) => options.surface.searchSessions(query, signal),
        ...(options.sessionHost ? { sessionHost: options.sessionHost } : {}),
        project: (acknowledgement) => envelope(acknowledgement ? { acknowledgement } : {}),
      })
      if (conversation) {
        sendJson(res, conversation.status, conversation.body)
        if (conversation.broadcast) broadcast()
        return
      }
      const approval = await handleWebUiApprovalRequest({
        method: req.method,
        pathname: requestUrl.pathname,
        readJson: () => transport.readJson(req),
      }, {
        approvals: () => snapshot().approvals,
        resolveApproval: (card, decision) => options.surface.resolveApproval(card, decision),
        recordSelfExtensionApproval: (input) => {
          const human = options.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
          options.recoveryRoot.recordApproval(human, input)
        },
        acknowledgementFor,
        project: (acknowledgement) => envelope(acknowledgement ? { acknowledgement } : {}),
      })
      if (approval) {
        sendJson(res, approval.status, approval.body)
        if (approval.broadcast) broadcast()
        return
      }
      const activation = await handleWebUiActivationRequest({
        method: req.method,
        pathname: requestUrl.pathname,
        readJson: () => transport.readJson(req),
      }, {
        authority: {
          activate: (candidateId) => {
            const human = options.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
            return options.recoveryRoot.activate(candidateId, human)
          },
          abandon: (candidateId, fingerprint) => {
            const human = options.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
            options.recoveryRoot.abandonFailedActivation(candidateId, fingerprint, human)
          },
        },
        mutations,
        activations: () => snapshot().activations,
        project: envelope,
      })
      if (activation) {
        sendJson(res, activation.status, activation.body)
        if (activation.broadcast) broadcast()
        return
      }
      const skill = await handleWebUiSkillRequest({
        method: req.method,
        pathname: requestUrl.pathname,
        readJson: () => transport.readJson(req),
      }, {
        authority: { execute: executeSkillCommand },
        project: (acknowledgement) => envelope(acknowledgement ? { acknowledgement } : {}),
      })
      if (skill) {
        sendJson(res, skill.status, skill.body)
        if (skill.broadcast) broadcast()
        return
      }
      const governanceLifecycle = await handleWebUiGovernanceLifecycleRequest({
        method: req.method,
        pathname: requestUrl.pathname,
        readJson: () => transport.readJson(req),
      }, {
        authority: {
          inspect: () => options.recoveryRoot.inspect(),
          uninstall: (owner, version, acknowledgeDependents) => {
            const human = options.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
            return options.recoveryRoot.uninstall(human, owner, version, { acknowledgeDependents })
          },
          rollback: () => {
            const human = options.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
            return options.recoveryRoot.rollback(human)
          },
          exitSafeMode: () => {
            const human = options.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
            return options.recoveryRoot.exitSafeMode(human)
          },
        },
        mutations,
        diagnostics: options.diagnostics,
        project: envelope,
      })
      if (governanceLifecycle) {
        sendJson(res, governanceLifecycle.status, governanceLifecycle.body)
        if (governanceLifecycle.broadcast) broadcast()
        return
      }
      if (req.method === 'GET' && !requestUrl.pathname.startsWith('/api/')) {
        transport.serveAsset(requestUrl.pathname, res, requestUrl.pathname === '/' || requestUrl.pathname === '/index.html')
        return
      }
      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed'
      if (message.includes('fingerprint')) {
        sendJson(res, 409, { error: 'stale-fingerprint' })
        return
      }
      if (message.includes('unknown') || message.includes('not found')) {
        sendJson(res, 409, { error: 'unknown-candidate' })
        return
      }
      sendJson(res, 400, { error: message.startsWith('refusing') ? 'unsafe payload' : 'malformed' })
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(listen.port, listen.host, () => {
      const port = boundPort()
      const host = listen.host === '::1' ? '[::1]' : listen.host
      url = `http://${host}:${port}`
      poll = setInterval(() => broadcast(), 750)
      resolve({
        url,
        host: listen.host,
        port,
        notify: broadcast,
        close: () => new Promise((done, fail) => {
          if (poll) clearInterval(poll)
          transport.close()
          server.close((error) => error ? fail(error) : done())
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
        }),
      })
    })
  })
}

export function attachWebUiBroadcast(ctx: { on(event: string, listener: (...args: never[]) => void): unknown }, push: () => void): () => void {
  // Observe-only. tools/pre-execute is a waterfall gate; a void listener returns
  // undefined and every tool then fails with "Cannot read properties of undefined (reading 'kind')".
  const names = ['agent/status', 'session/event', 'session/flush', 'tools/result']
  const offs = names.map((name) => ctx.on(name, push))
  return () => {
    for (const off of offs) {
      if (typeof off === 'function') off()
    }
  }
}

export { PRODUCT_UI_SESSION_ID }
