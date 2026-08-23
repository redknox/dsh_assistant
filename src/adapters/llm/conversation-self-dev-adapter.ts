import { CallId, LlmAdapter, type GenerateOptions, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'

export const SLUGIFY_IMPLEMENTATION = `export const name = 'generated/text-slugify'

export function slugify(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function apply(ctx) {
  const dispose = ctx.tools.register({
    name: 'text_slugify',
    description: 'Lowercase URL-safe slug',
    parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: String(value) }] } },
    async execute(args) {
      return slugify(String(args.text ?? ''))
    },
  })
  ctx.effect(() => dispose)
}
`

/** Scripted model for the conversation self-development slice. Fake LLM; real DSH loop/tools. */
export class ConversationSelfDevAdapter extends LlmAdapter {
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (options.signal?.aborted) throw options.signal.reason
    const parsed = toolJsons(options.messages)
    const plan = parsed.find((item) => typeof item.planId === 'string' && item.kind === 'new-plugin')
    const views = parsed.filter((item) => typeof item.id === 'string' && typeof item.owner === 'string')
    const candidate = views.at(-1)
    const stamped = views.filter((item) => item.contractVersion === 'generated-extension-api/v1')
    const validation = [...views].reverse().find((item) => item.validation && typeof item.validation === 'object')
    const reviewed = parsed.find((item) => item.state === 'review-complete')
    const requested = parsed.find((item) => item.decision === 'approval-requested')

    if (requested) {
      yield* emitText('The slugify candidate is ready for human approval. I cannot approve or activate it.')
      return
    }
    if (reviewed && candidate) {
      yield* emitToolCalls([{ name: 'request_extension_approval', arguments: { candidateId: candidate.id } }])
      return
    }
    if (candidate?.sealed === true && !reviewed) {
      yield* emitToolCalls([{ name: 'review_candidate', arguments: { candidateId: candidate.id } }])
      return
    }
    if (candidate && validationPassed(validation) && candidate.sealed !== true) {
      yield* emitToolCalls([{ name: 'seal_candidate', arguments: { candidateId: candidate.id } }])
      return
    }
    if (candidate && validation && !validationPassed(validation)) {
      yield* emitToolCalls([
        { name: 'inspect_validation_diagnostics', arguments: { candidateId: candidate.id } },
        {
          name: 'write_candidate_file',
          arguments: { candidateId: candidate.id, path: 'src/plugin.js', content: SLUGIFY_IMPLEMENTATION },
        },
        { name: 'validate_candidate', arguments: { candidateId: candidate.id } },
      ])
      return
    }
    if (candidate && stamped.length >= 2 && !validation) {
      yield* emitToolCalls([{ name: 'validate_candidate', arguments: { candidateId: candidate.id } }])
      return
    }
    if (candidate && stamped.length === 1 && !validation) {
      yield* emitToolCalls([{
        name: 'write_candidate_file',
        arguments: { candidateId: candidate.id, path: 'src/plugin.js', content: SLUGIFY_IMPLEMENTATION },
      }])
      return
    }
    if (candidate) {
      yield* emitToolCalls([{
        name: 'scaffold_candidate',
        arguments: {
          candidateId: candidate.id,
          toolName: 'text_slugify',
          toolDescription: 'Lowercase URL-safe slug',
        },
      }])
      return
    }
    if (plan) {
      yield* emitToolCalls([
        { name: 'list_workbench', arguments: { limit: 20 } },
        { name: 'create_candidate', arguments: { planId: plan.planId } },
      ])
      return
    }
    yield* emitToolCalls([
      {
        name: 'plan_capability_change',
        arguments: {
          capability: 'text.slugify',
          need: 'lowercase URL-safe slug',
          behavior: 'slug',
        },
      },
      { name: 'inspect_authoring_contract', arguments: { version: 'generated-extension-api/v1' } },
    ])
  }
}

function validationPassed(value: Record<string, unknown> | undefined): boolean {
  const validation = value?.validation
  return Boolean(validation && typeof validation === 'object' && (validation as { passed?: boolean }).passed === true)
}

function toolJsons(messages: readonly Message[]): Record<string, unknown>[] {
  return messages
    .filter((message) => message.source.kind === 'tool')
    .map((message) => {
      const text = textOf(message)
      try {
        return JSON.parse(text) as Record<string, unknown>
      } catch {
        return { raw: text }
      }
    })
}

function textOf(message: Message): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
    if (block.type === 'tool-result') {
      for (const inner of block.content) {
        if (inner.type === 'text') parts.push(inner.text)
      }
    }
  }
  return parts.join('')
}

function* emitToolCalls(calls: readonly { name: string; arguments: Record<string, unknown> }[]): Generator<StreamChunk> {
  for (const [index, call] of calls.entries()) {
    const id = CallId(`m6c-${call.name}-${index}`)
    const args = JSON.stringify(call.arguments)
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
    yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } }
  }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

function* emitText(text: string): Generator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
