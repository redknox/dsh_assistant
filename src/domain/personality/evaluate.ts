import { CARICATURE_MARKERS, GENERIC_MARKERS, PERSONALITY_CORPUS, type PersonalityScenario } from './corpus.js'

export interface CorpusEvaluation {
  readonly ok: boolean
  readonly failures: readonly string[]
}

function includesAny(text: string, markers: readonly string[]): string | undefined {
  const lower = text.toLowerCase()
  return markers.find((marker) => lower.includes(marker))
}

export function evaluateScenario(item: PersonalityScenario): readonly string[] {
  const failures: string[] = []
  if (includesAny(item.preferred, GENERIC_MARKERS)) {
    failures.push(`${item.id}: preferred response matches generic-chatbot flattery`)
  }
  if (includesAny(item.preferred, CARICATURE_MARKERS)) {
    failures.push(`${item.id}: preferred response matches sarcastic-caricature markers`)
  }
  if (!includesAny(item.generic, GENERIC_MARKERS)) {
    failures.push(`${item.id}: generic anti-example is not marked as flattering chatbot`)
  }
  if (!includesAny(item.caricature, CARICATURE_MARKERS)) {
    failures.push(`${item.id}: caricature anti-example is not marked as sarcastic cosplay`)
  }
  if (item.preferred.trim() === item.generic.trim() || item.preferred.trim() === item.caricature.trim()) {
    failures.push(`${item.id}: preferred response is not distinct from anti-examples`)
  }
  return failures
}

export function evaluateCorpus(corpus: readonly PersonalityScenario[] = PERSONALITY_CORPUS): CorpusEvaluation {
  const failures = corpus.flatMap((item) => evaluateScenario(item))
  const kinds = new Set(corpus.map((item) => item.kind))
  if (corpus.length < 10) failures.push('corpus must cover at least 10 scenarios')
  if (!kinds.has('design-review') || !kinds.has('safety') || !kinds.has('irreversible') || !kinds.has('casual')) {
    failures.push('corpus must cover design-review, safety, irreversible, and casual kinds')
  }
  return { ok: failures.length === 0, failures }
}
