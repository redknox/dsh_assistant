import { CallId, LlmAdapter, type GenerateOptions, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'

export const PLAN_MY_DAY_FOCUS = {
  title: 'Focus block',
  start: '2026-08-21T09:00:00.000Z',
  end: '2026-08-21T10:00:00.000Z',
} as const

const DAY = {
  from: '2026-08-21T00:00:00.000Z',
  to: '2026-08-21T23:59:59.000Z',
}

/** Scripted model for the Plan My Day slice. Fake LLM; real DSH loop/tools. */
export class PlanMyDayAdapter extends LlmAdapter {
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (options.signal?.aborted) throw options.signal.reason
    const lastUser = lastUserText(options.messages)
    const toolResults = toolResultsAfterLastUser(options.messages)

    if (lastUser.includes('invalid calendar query')) {
      if (toolResults === 0) {
        yield* emitToolCalls([{
          name: 'calendar_list_events',
          arguments: { from: DAY.from, to: DAY.to, limit: -1 },
        }])
        return
      }
      yield* emitText('Calendar lookup failed: the provider rejected the invalid limit.')
      return
    }

    if (toolResults === 0) {
      yield* emitToolCalls([
        { name: 'recall_memory', arguments: { topicKey: 'briefing' } },
        { name: 'retrieve_knowledge', arguments: { query: 'print confirmation' } },
        { name: 'calendar_list_events', arguments: DAY },
      ])
      return
    }
    if (toolResults < 5) {
      yield* emitToolCalls([
        { name: 'calendar_propose_event', arguments: { ...PLAN_MY_DAY_FOCUS } },
        { name: 'calendar_create_event', arguments: { ...PLAN_MY_DAY_FOCUS } },
      ])
      return
    }
    yield* emitText('Morning brief: standup, office hours, and retro are on the calendar. A focus block is pending confirmation.')
  }
}

function lastUserText(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user' && message.source.kind === 'user') return textOf(message)
  }
  return ''
}

function toolResultsAfterLastUser(messages: readonly Message[]): number {
  let lastUser = -1
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message?.role === 'user' && message.source.kind === 'user') lastUser = index
  }
  return messages.slice(lastUser + 1).filter((message) => message.source.kind === 'tool').length
}

function textOf(message: Message): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.type === 'text' ? block.text : '')
    .join('')
}

function* emitToolCalls(calls: readonly { name: string; arguments: Record<string, unknown> }[]): Generator<StreamChunk> {
  for (const [index, call] of calls.entries()) {
    const id = CallId(`slice-${call.name}-${index}`)
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
