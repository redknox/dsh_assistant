import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RecoveryRoot } from '../domain/governance/root.js'
import { acknowledgementOf } from '../domain/workspace/approvals.js'
import { redactText } from '../domain/workspace/redact.js'
import { AssistantControlSurface } from '../ui/controller.js'
import type { MissionControlView } from '../domain/workspace/types.js'
import { PRODUCT_UI_SESSION_ID } from './constants.js'
import type { LiveSessionHost } from './session-lifecycle.js'
import {
  assertSafePayload,
  createUiSessionToken,
  originAllowed,
  resolveWebUiListen,
  sessionCookieHeader,
  sessionMatches,
  type WebUiListenOptions,
} from './web-ui-protocol.js'
import { handleRuntimeControlRequest, type WebUiRuntimeControl } from './web-ui-runtime-control.js'
import { handleWebUiConversationRequest } from './web-ui-conversations.js'
import { handleWebUiApprovalRequest } from './web-ui-approvals.js'
import { handleWebUiActivationRequest } from './web-ui-activations.js'
import { handleWebUiGovernanceLifecycleRequest } from './web-ui-governance-lifecycle.js'
import { WebUiGovernanceMutations } from './web-ui-governance-mutations.js'
import { handleWebUiSkillRequest, type WebUiSkillCommand } from './web-ui-skills.js'

export type { WebUiRuntimeControl } from './web-ui-runtime-control.js'

export interface WebUiServerOptions extends WebUiListenOptions {
  readonly surface: AssistantControlSurface
  readonly recoveryRoot: RecoveryRoot
  readonly diagnostics?: unknown
  readonly assetRoot?: string
  readonly runtimeControl?: WebUiRuntimeControl
  readonly sessionHost?: LiveSessionHost
}

export interface WebUiServer {
  readonly url: string
  readonly host: string
  readonly port: number
  notify(): void
  close(): Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function defaultWebAssetRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '../../dist/web')
}

export function startWebUiServer(options: WebUiServerOptions): Promise<WebUiServer> {
  const listen = resolveWebUiListen(process.env, options)
  const assetRoot = path.resolve(options.assetRoot ?? defaultWebAssetRoot())
  const sessionToken = createUiSessionToken()
  const clients = new Set<ServerResponse>()
  let url = ''
  let lastPayload = ''
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
    ...(extra.acknowledgement ? { acknowledgement: extra.acknowledgement } : {}),
  })

  const acknowledgementFor = (confirmationId: string) => {
    const resolution = snapshot().approvalResolutions.find((item) => item.confirmationId === confirmationId)
    return resolution ? { text: redactText(acknowledgementOf(resolution).text) } : undefined
  }

  const sendJson = (res: ServerResponse, status: number, body: unknown, setSession = false) => {
    const payload = assertSafePayload(JSON.stringify(body))
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'close',
    }
    if (setSession) headers['set-cookie'] = sessionCookieHeader(sessionToken)
    res.writeHead(status, headers)
    res.end(payload)
  }

  const rejectOrigin = (req: IncomingMessage, res: ServerResponse): boolean => {
    const origin = req.headers.origin
    if (originAllowed(typeof origin === 'string' ? origin : undefined, listen.host, boundPort())) return false
    sendJson(res, 403, { error: 'unsupported origin' })
    return true
  }

  const rejectUntrustedMutation = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!MUTATING.has(req.method ?? 'GET')) return false
    if (sessionMatches(req.headers.cookie, sessionToken)) return false
    sendJson(res, 403, { error: 'untrusted session' })
    return true
  }

  const boundPort = (): number => {
    const address = server.address()
    return typeof address === 'object' && address ? address.port : listen.port
  }

  const broadcast = () => {
    let payload: string
    try {
      payload = assertSafePayload(JSON.stringify(envelope()))
    } catch {
      return
    }
    if (payload === lastPayload) return
    lastPayload = payload
    for (const client of clients) {
      client.write(`event: view\ndata: ${payload}\n\n`)
    }
  }

  const readBody = async (req: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 65_536) throw new Error('request too large')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
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

  const serveAsset = (reqPath: string, res: ServerResponse, setSession: boolean) => {
    const relative = reqPath === '/' ? 'index.html' : reqPath.replace(/^\//, '')
    const target = path.resolve(assetRoot, relative)
    if (!target.startsWith(`${assetRoot}${path.sep}`) && target !== assetRoot) {
      res.writeHead(403).end()
      return
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      if (reqPath === '/' || !path.extname(reqPath)) {
        const index = path.join(assetRoot, 'index.html')
        if (existsSync(index)) {
          res.writeHead(200, {
            'content-type': MIME['.html'],
            ...(setSession ? { 'set-cookie': sessionCookieHeader(sessionToken) } : {}),
          })
          createReadStream(index).pipe(res)
          return
        }
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Web UI assets are not installed')
      return
    }
    const mime = MIME[path.extname(target)] ?? 'application/octet-stream'
    res.writeHead(200, {
      'content-type': mime,
      'cache-control': 'no-store',
      ...(setSession && target.endsWith(`${path.sep}index.html`) ? { 'set-cookie': sessionCookieHeader(sessionToken) } : {}),
    })
    createReadStream(target).pipe(res)
  }

  const server: Server = createServer(async (req, res) => {
    try {
      if (rejectOrigin(req, res)) return
      const hostHeader = req.headers.host ?? `${listen.host}:${boundPort()}`
      const requestUrl = new URL(req.url ?? '/', `http://${hostHeader}`)
      const runtimeControl = await handleRuntimeControlRequest({
        method: req.method,
        pathname: requestUrl.pathname,
        readJson: async () => JSON.parse(await readBody(req)) as unknown,
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
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        clients.add(res)
        const payload = assertSafePayload(JSON.stringify(envelope()))
        lastPayload = payload
        res.write(`event: view\ndata: ${payload}\n\n`)
        req.on('close', () => {
          clients.delete(res)
        })
        return
      }
      const conversation = await handleWebUiConversationRequest({
        method: req.method,
        pathname: requestUrl.pathname,
        readJson: async () => JSON.parse(await readBody(req)) as unknown,
      }, {
        currentSessionId: () => options.surface.sessionId,
        sendMessage: (text) => options.surface.sendMessage(text),
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
        readJson: async () => JSON.parse(await readBody(req)) as unknown,
      }, {
        approvals: () => snapshot().approvals,
        resolvePolicy: async (id, decision) => {
          if (decision === 'approve') return options.surface.approve(id)
          if (decision === 'deny') return options.surface.deny(id)
          return options.surface.cancelConfirmation(id)
        },
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
        readJson: async () => JSON.parse(await readBody(req)) as unknown,
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
        readJson: async () => JSON.parse(await readBody(req)) as unknown,
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
        readJson: async () => JSON.parse(await readBody(req)) as unknown,
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
        serveAsset(requestUrl.pathname, res, requestUrl.pathname === '/' || requestUrl.pathname === '/index.html')
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
          for (const client of clients) client.end()
          clients.clear()
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
