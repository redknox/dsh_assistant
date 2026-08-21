import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CARICATURE_MARKERS,
  DEFAULT_PERSONALITY_TRAITS,
  GENERIC_MARKERS,
  PERSONALITY_CORPUS,
  PERSONALITY_INVARIANTS,
  PersonalityService,
  USER_ADJUSTABLE_TRAITS,
  compilePersonality,
  evaluateCorpus,
  effectiveTraits,
} from '../src/domain/personality/index.js'
import { bootAssistantRuntime, bootSafeModeRuntime } from '../src/runtime/boot.js'

describe('TARS-NG personality contract', () => {
  it('compiles three layers instead of one opaque prompt blob', () => {
    const compiled = compilePersonality(DEFAULT_PERSONALITY_TRAITS)
    assert.match(compiled.core, /Personality Core/)
    assert.match(compiled.policy, /Behavior Policy/)
    assert.match(compiled.expression, /Contextual Expression/)
    assert.notEqual(compiled.core, compiled.policy)
    assert.notEqual(compiled.policy, compiled.expression)
    assert.match(compiled.core, /truth over agreement/i)
    assert.match(compiled.core, /uncertainty is explicit/i)
    assert.match(compiled.core, /challenge without obstruction/i)
    assert.match(compiled.core, /self-correction is strength/i)
    assert.match(compiled.core, /human remains the authority root/i)
    assert.equal(PERSONALITY_INVARIANTS.length, 5)
  })

  it('keeps truthfulness, skepticism floor, and authority as non-adjustable', () => {
    const service = new PersonalityService()
    service.setUserPrefs({ humor: 90, directness: 20, initiative: 10, verbosity: 'detailed' })
    const traits = service.effective({ kind: 'normal', systemState: 'READY' })
    assert.equal(traits.competence >= 80, true)
    assert.equal(traits.skepticism >= 60, true)
    assert.equal(traits.drama, 0)
    assert.deepEqual([...USER_ADJUSTABLE_TRAITS], ['humor', 'directness', 'initiative', 'verbosity'])
    assert.equal('skepticism' in (service.profile().prefs), false)
    assert.match(service.compile().policy, /cannot grant capability/)
  })

  it('suppresses humor in Safe Mode and serious situations', () => {
    const ready = effectiveTraits({ humor: 90 }, { kind: 'casual', systemState: 'READY' })
    const safe = effectiveTraits({ humor: 90 }, { kind: 'safety', systemState: 'SAFE_MODE' })
    const irreversible = effectiveTraits({ humor: 90 }, { kind: 'irreversible', systemState: 'NEEDS_APPROVAL' })
    assert.equal(ready.humor >= 80, true)
    assert.equal(safe.humor <= 10, true)
    assert.equal(irreversible.humor <= 10, true)
    assert.match(compilePersonality(safe, { kind: 'safety', systemState: 'SAFE_MODE' }).policy, /Humor is suppressed/)
  })

  it('previews user-adjustable changes without rewriting invariants', () => {
    const service = new PersonalityService()
    const preview = service.preview({ humor: 20, directness: 95 })
    assert.deepEqual([...preview.changed].sort(), ['directness', 'humor'])
    assert.match(service.compile().core, /human remains the authority root/i)
    assert.notEqual(preview.before, preview.after)
  })

  it('protects the evaluation corpus against generic-chatbot and caricature drift', () => {
    const result = evaluateCorpus()
    assert.equal(result.ok, true, result.failures.join('\n'))
    assert.equal(PERSONALITY_CORPUS.length >= 10, true)
    for (const item of PERSONALITY_CORPUS) {
      assert.equal(GENERIC_MARKERS.some((marker) => item.generic.toLowerCase().includes(marker)), true, item.id)
      assert.equal(CARICATURE_MARKERS.some((marker) => item.caricature.toLowerCase().includes(marker)), true, item.id)
      assert.equal(GENERIC_MARKERS.some((marker) => item.preferred.toLowerCase().includes(marker)), false, item.id)
    }
  })

  it('injects three public prompt layers and cannot mint approval', async () => {
    const ctx = await bootAssistantRuntime()
    try {
      assert.ok(ctx.tarsPersonality)
      const assembly = await ctx.systemPrompt.assemble()
      assert.ok(assembly.sections.some((item) => item.name === 'product:personality-core'))
      assert.ok(assembly.sections.some((item) => item.name === 'product:behavior-policy'))
      assert.ok(assembly.contexts.some((item) => item.name === 'product:contextual-expression'))
      ctx.tarsPersonality.setUserPrefs({ humor: 15 })
      assert.throws(() => ctx.extensionGovernance.recordUntrustedApproval({ approved: true }))
      assert.equal('activate' in ctx.tarsPersonality, false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps TARS-NG personality in Safe Mode with humor suppressed', async () => {
    const control = await bootSafeModeRuntime()
    try {
      assert.ok(control.ctx.tarsPersonality)
      control.ctx.tarsPersonality.setSituation({ kind: 'safety', systemState: 'SAFE_MODE' })
      assert.equal(control.ctx.tarsPersonality.effective().humor <= 10, true)
      assert.equal(control.ctx.get('personalMemory'), undefined)
    } finally {
      await control.ctx.fiber.dispose()
    }
  })
})
