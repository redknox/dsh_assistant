import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** Public-seam test/demo adapter. Returns a fixed text reply; no live provider. */
export class FakeReplyAdapter extends LlmAdapter {
  invocations = 0

  constructor(private readonly reply = 'ok') {
    super()
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.invocations += 1
    if (options.signal?.aborted) throw options.signal.reason
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
