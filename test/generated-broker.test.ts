import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  GeneratedBrokerError,
  GeneratedHostBroker,
  HOST_KNOWLEDGE_RETRIEVE,
  type GeneratedBrokerOperation,
} from '../src/domain/generated-runtime/index.js'

const operation: GeneratedBrokerOperation = {
  capability: HOST_KNOWLEDGE_RETRIEVE,
  execute(args) {
    return { accepted: args.query }
  },
}

describe('generated host Broker', () => {
  it('binds dispatch to the exact approved operation and detaches JSON results', async () => {
    const broker = new GeneratedHostBroker([operation])
    const result = await broker.request(
      { capability: HOST_KNOWLEDGE_RETRIEVE, args: { query: 'policy' } },
      [HOST_KNOWLEDGE_RETRIEVE],
      { signal: new AbortController().signal, sessionId: 'main' },
    )
    assert.deepEqual(result, { accepted: 'policy' })
    await assert.rejects(
      () => broker.request(
        { capability: HOST_KNOWLEDGE_RETRIEVE, args: { query: 'policy' } },
        [],
        { signal: new AbortController().signal },
      ),
      /not approved/,
    )
  })

  it('enforces argument and result limits at the module interface', async () => {
    const broker = new GeneratedHostBroker([operation])
    await assert.rejects(
      () => broker.request(
        { capability: HOST_KNOWLEDGE_RETRIEVE, args: { query: 'x'.repeat(17 * 1024) } },
        [HOST_KNOWLEDGE_RETRIEVE],
        { signal: new AbortController().signal },
      ),
      /broker arguments exceeds/,
    )
    const oversize: GeneratedBrokerOperation = {
      capability: HOST_KNOWLEDGE_RETRIEVE,
      execute: () => 'x'.repeat(49 * 1024),
    }
    await assert.rejects(
      () => new GeneratedHostBroker([oversize]).request(
        { capability: HOST_KNOWLEDGE_RETRIEVE, args: { query: 'policy' } },
        [HOST_KNOWLEDGE_RETRIEVE],
        { signal: new AbortController().signal },
      ),
      /broker result exceeds/,
    )
  })

  it('rejects duplicate operations and propagates invocation cancellation', async () => {
    assert.throws(() => new GeneratedHostBroker([operation, operation]), GeneratedBrokerError)
    const controller = new AbortController()
    controller.abort(new Error('cancelled by caller'))
    await assert.rejects(
      () => new GeneratedHostBroker([operation]).request(
        { capability: HOST_KNOWLEDGE_RETRIEVE, args: { query: 'policy' } },
        [HOST_KNOWLEDGE_RETRIEVE],
        { signal: controller.signal },
      ),
      /cancelled by caller/,
    )
  })
})
