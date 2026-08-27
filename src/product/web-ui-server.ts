import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SkillContractError } from '../domain/skill/errors.js'
import type { RecoveryRoot } from '../domain/governance/root.js'
import { acknowledgementOf } from '../domain/workspace/approvals.js'
import { redactText } from '../domain/workspace/redact.js'
import { AssistantControlSurface } from '../ui/controller.js'
import type { MissionControlView, SkillProjection } from '../domain/workspace/types.js'
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

  const bindSkillAction = (body: {
    action?: unknown
    id?: unknown
    name?: unknown
    version?: unknown
    digest?: unknown
    fingerprint?: unknown
    generation?: unknown
  }, view: MissionControlView): { error: string } | { skill: SkillProjection } => {
    const action = String(body.action ?? '')
    const allowed = new Set(['approve', 'reject', 'activate', 'disable', 'reactivate', 'uninstall', 'rollback'])
    if (!allowed.has(action)) return { error: 'malformed' }
    if (typeof body.generation !== 'number' || !Number.isInteger(body.generation)) return { error: 'malformed' }
    if (action === 'rollback') {
      const target = view.skillRollback
      if (target === undefined) return { error: 'unknown-skill' }
      if (typeof body.name !== 'string' || body.name !== target.name) return { error: 'stale-skill' }
      if (typeof body.version !== 'string' || body.version !== target.version) return { error: 'stale-skill' }
      if (typeof body.digest !== 'string' || body.digest !== target.digest) return { error: 'stale-digest' }
      if (body.generation !== target.generation) return { error: 'stale-generation' }
      const skill = (view.skills ?? []).find((item) => item.name === target.name && item.version === target.version)
      if (skill === undefined) return { error: 'unknown-skill' }
      return { skill }
    }
    if (typeof body.id !== 'string' || body.id === '') return { error: 'malformed' }
    const skill = (view.skills ?? []).find((item) => item.id === body.id)
    if (skill === undefined) return { error: 'unknown-skill' }
    if (typeof body.name !== 'string' || body.name !== skill.name) return { error: 'stale-skill' }
    if (typeof body.version !== 'string' || body.version !== skill.version) return { error: 'stale-skill' }
    if (typeof body.digest !== 'string' || body.digest !== skill.digest) return { error: 'stale-digest' }
    if (body.generation !== skill.generation) return { error: 'stale-generation' }
    if (action === 'approve' || action === 'reject') {
      if (skill.lifecycle !== 'approval-requested') return { error: 'stale-lifecycle' }
      if (typeof body.fingerprint !== 'string' || body.fingerprint !== skill.approvalFingerprint) return { error: 'stale-fingerprint' }
    }
    if (action === 'activate' && skill.lifecycle !== 'approved') return { error: 'stale-lifecycle' }
    if (action === 'disable' && skill.lifecycle !== 'active') return { error: 'stale-lifecycle' }
    if (action === 'reactivate' && skill.lifecycle !== 'disabled') return { error: 'stale-lifecycle' }
    if (action === 'uninstall' && skill.lifecycle === 'uninstalled') return { error: 'stale-lifecycle' }
    return { skill }
  }

  const withheldSkillCatalogMutation = (action: string, view: MissionControlView): string | undefined => {
    if (action !== 'activate' && action !== 'reactivate') return undefined
    if (view.skillCatalog?.state === 'withheld') return 'catalog-withheld'
    if (view.systemState === 'SAFE_MODE' || view.runtimeContext?.safeMode === true) return 'safe-mode'
    return undefined
  }

  const sameStringSet = (left: readonly string[], right: readonly string[]) => (
    left.length === right.length && left.every((item) => right.includes(item))
  )

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
      if (req.method === 'POST' && requestUrl.pathname === '/api/skill') {
        const body = JSON.parse(await readBody(req)) as {
          action?: unknown
          id?: unknown
          name?: unknown
          version?: unknown
          digest?: unknown
          fingerprint?: unknown
          generation?: unknown
          confirm?: unknown
          dependents?: unknown
          acknowledgeDependents?: unknown
        }
        if (body.confirm !== true) {
          sendJson(res, 409, { error: 'confirmation-required' })
          return
        }
        const action = String(body.action ?? '')
        const view = snapshot()
        const withheld = withheldSkillCatalogMutation(action, view)
        if (withheld !== undefined) {
          sendJson(res, 409, { error: withheld, view, webUi: url })
          return
        }
        const bound = bindSkillAction(body, view)
        if ('error' in bound) {
          sendJson(res, bound.error === 'malformed' ? 400 : 409, { error: bound.error })
          return
        }
        const human = options.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
        try {
          if (action === 'approve') {
            options.recoveryRoot.approveSkill(bound.skill.id, bound.skill.approvalFingerprint ?? '', human)
          } else if (action === 'reject') {
            options.recoveryRoot.rejectSkill(bound.skill.id, bound.skill.approvalFingerprint ?? '', human)
          } else if (action === 'activate') {
            options.recoveryRoot.activateSkill(bound.skill.id, human)
          } else if (action === 'reactivate') {
            options.recoveryRoot.reactivateSkill(bound.skill.name, bound.skill.version, human)
          } else if (action === 'disable' || action === 'uninstall') {
            const dependents = bound.skill.dependents
            if (dependents.length > 0 && body.acknowledgeDependents !== true) {
              sendJson(res, 409, {
                error: 'dependents-required',
                dependents,
                detail: `hard dependents must be acknowledged: ${dependents.join(', ')}`,
                view,
                webUi: url,
              })
              return
            }
            const acknowledged = Array.isArray(body.dependents) ? body.dependents.map((item) => String(item)) : []
            if (body.acknowledgeDependents === true && !sameStringSet(dependents, acknowledged)) {
              sendJson(res, 409, { error: 'stale-dependents', dependents, view, webUi: url })
              return
            }
            const ack = body.acknowledgeDependents === true ? acknowledged : []
            if (action === 'disable') options.recoveryRoot.disableSkill(bound.skill.name, human, ack)
            else options.recoveryRoot.uninstallSkill(bound.skill.id, human, ack)
          } else if (action === 'rollback') {
            options.recoveryRoot.rollbackSkill(human)
          } else {
            sendJson(res, 400, { error: 'malformed', detail: 'unknown skill action' })
            return
          }
          sendJson(res, 200, envelope({ acknowledgement: { text: `Skill ${action} recorded.` } }))
          broadcast()
        } catch (error) {
          const message = error instanceof Error ? error.message : 'skill action failed'
          const code = error instanceof SkillContractError
            && (error.code === 'catalog-degraded' || error.code === 'catalog-sync-failed')
            ? error.code
            : 'skill-action-denied'
          sendJson(res, 409, { error: code, detail: redactText(message), view: snapshot(), webUi: url })
        }
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
