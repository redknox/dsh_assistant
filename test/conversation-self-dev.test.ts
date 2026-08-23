import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ConversationSelfDevAdapter, SLUGIFY_IMPLEMENTATION } from './helpers/conversation-self-dev-adapter.js'
import { bootAssistantControl, createAssistantAgent } from '../src/runtime/boot.js'
import { AssistantControlSurface } from '../src/ui/controller.js'
import { projectMissionControl } from '../src/domain/workspace/index.js'
import { gatherWorkspaceSnapshot } from '../src/domain/workspace/gather.js'

async function tool(
  ctx: { tools: { execute(input: unknown): Promise<{ isError: boolean; value?: unknown }> } },
  name: string,
  args: Record<string, unknown> = {},
) {
  return ctx.tools.execute({
    callId: CallId(`m6c-${name}-${Math.random().toString(16).slice(2)}`),
    name,
    arguments: args,
    signal: AbortSignal.timeout(30000),
  })
}

describe('conversation self-development', () => {
  it('E. scripted conversation authors text.slugify, restarts, and rolls back', { timeout: 120_000 }, async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-m6c-e2e-'))
    const first = await bootAssistantControl({ home })
    first.ctx.llm.registerAdapter(['fake'], new ConversationSelfDevAdapter())
    const handle = await createAssistantAgent(first.ctx, 'm6c-self-dev', { provider: 'fake', model: 'm6c' })
    const ui = new AssistantControlSurface(first.ctx, 'm6c-self-dev')
    const agent = first.ctx.agents.get(SessionId('m6c-self-dev'))
    assert.ok(agent)
    let candidateId = ''
    let fingerprint = ''
    try {
      assert.equal(first.ctx.capabilityRegistry.resolveActiveOwner('text.slugify').kind, 'unknown')
      assert.equal(first.ctx.tools.get('text_slugify'), undefined)
      assert.doesNotMatch(SLUGIFY_IMPLEMENTATION, /host\.text\.echo/)
      ui.sendMessage('Add a text.slugify tool that lowercases to a URL-safe slug')
      await agent.whenIdle()
      const snap = ui.snapshot()
      const tools = snap.conversation.filter((item) => item.kind === 'tool_call').map((item) => item.toolName)
      assert.ok(tools.includes('plan_capability_change'))
      assert.ok(tools.includes('inspect_authoring_contract'))
      assert.ok(tools.includes('scaffold_candidate'))
      assert.ok(tools.includes('inspect_validation_diagnostics'))
      assert.ok(tools.includes('write_candidate_file'))
      assert.ok(tools.includes('validate_candidate'))
      const inspectIdx = snap.conversation.findIndex((item) => item.kind === 'tool_result' && item.text.includes('"stages"'))
      const writeIdx = snap.conversation.findIndex((item) => item.kind === 'tool_call' && item.toolName === 'write_candidate_file')
      assert.ok(inspectIdx >= 0 && writeIdx > inspectIdx)
      assert.match(snap.conversation[inspectIdx]?.text ?? '', /tests|src\/plugin\.js/)
      assert.doesNotMatch(snap.conversation.slice(0, writeIdx).map((item) => item.text).join('\n'), /SLUGIFY_IMPLEMENTATION/)
      assert.ok(tools.includes('review_candidate'))
      assert.ok(tools.includes('request_extension_approval'))
      assert.ok(snap.conversation.some((item) => item.kind === 'assistant' && item.text.includes('human approval')))
      const listed = JSON.parse(String((await tool(first.ctx, 'list_workbench', {})).value)) as {
        candidates: { id: string; owner: string; states?: string[]; step?: string }[]
      }
      const generated = listed.candidates.find((item) => item.owner === 'generated/text-slugify')
      assert.ok(generated)
      assert.ok(generated.states?.includes('approval-requested') || generated.step === 'request')
      candidateId = generated.id
      const source = first.ctx.candidateWorkbench.readFile(candidateId, 'src/plugin.js')
      assert.match(source, /slugify/)
      assert.doesNotMatch(source, /host\.text\.echo/)
      const requested = first.ctx.extensionGovernance.inspectApproval(candidateId)
      assert.equal(requested?.decision, 'approval-requested')
      fingerprint = requested?.fingerprint ?? ''
      assert.ok(fingerprint)
      const view = projectMissionControl(gatherWorkspaceSnapshot({ ctx: first.ctx, sessionId: 'm6c-self-dev' }))
      const projected = view.candidates?.find((item) => item.id === candidateId)
      assert.ok(projected?.currentStep === 'request' || projected?.approvalState === 'approval-requested')
      assert.equal(first.ctx.tools.get('text_slugify'), undefined)
      const human = first.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
      first.recoveryRoot.recordApproval(human, {
        candidateId,
        fingerprint,
        decision: 'approved-for-exact-diff',
      })
      const activated = await first.recoveryRoot.activate(candidateId, human)
      assert.equal(activated.state, 'active', activated.lastFailure?.diagnostics)
      const afterActivate = JSON.parse(String((await tool(first.ctx, 'list_workbench', {})).value)) as {
        candidates: { id: string; states?: string[]; step?: string }[]
      }
      const active = afterActivate.candidates.find((item) => item.id === candidateId)
      assert.ok(active?.states?.includes('active') || active?.step === 'active')
      const slug = await tool(first.ctx, 'text_slugify', { text: 'Hello World' })
      assert.equal(slug.isError, false, String(slug.value))
      assert.equal(String(slug.value), 'hello-world')
    } finally {
      await handle.dispose()
      await first.ctx.fiber.dispose()
    }

    const second = await bootAssistantControl({ home })
    try {
      assert.ok(second.ctx.tools.get('text_slugify'))
      const again = await tool(second.ctx, 'text_slugify', { text: 'Hello World' })
      assert.equal(String(again.value), 'hello-world')
      const listed = JSON.parse(String((await tool(second.ctx, 'list_workbench', {})).value)) as {
        candidates: { id: string; states?: string[]; step?: string }[]
      }
      const restored = listed.candidates.find((item) => item.id === candidateId)
      assert.ok(restored?.states?.includes('active') || restored?.step === 'active')
      const human = second.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'operator-cli' })
      const rolled = await second.recoveryRoot.rollback(human)
      assert.equal(rolled.state, 'rolled-back')
      assert.equal(second.ctx.tools.get('text_slugify'), undefined)
      const afterRollback = JSON.parse(String((await tool(second.ctx, 'list_workbench', {})).value)) as {
        candidates: { id: string; states?: string[]; step?: string }[]
      }
      const rolledItem = afterRollback.candidates.find((item) => item.id === candidateId)
      assert.equal(rolledItem?.states?.includes('active'), false)
      assert.notEqual(rolledItem?.step, 'active')
    } finally {
      await second.ctx.fiber.dispose()
    }
  })
})
