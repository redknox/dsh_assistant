import { useEffect, useMemo, useState } from 'react'
import type { CapabilitySpecificationDiffView, CapabilitySpecificationView } from '../../src/product/web-ui-workbench-types'
import {
  compareCapabilitySpecificationRevisions,
  fetchCapabilitySpecification,
  fetchWorkbench,
  reviseCapabilitySpecification,
  type WorkbenchSnapshot,
} from './api'

export interface CapabilitySpecificationDraft {
  readonly goal: string
  readonly nonGoals: string
  readonly businessRules: string
  readonly unresolved: string
}

export interface CapabilitySpecificationsControl {
  readonly snapshot?: WorkbenchSnapshot
  readonly selected?: CapabilitySpecificationView
  readonly comparison?: CapabilitySpecificationDiffView
  readonly draft: CapabilitySpecificationDraft
  readonly loading: boolean
  readonly saving: boolean
  readonly error?: string
  readonly notice?: string
  readonly dirty: boolean
  readonly load: () => void
  readonly select: (id: string) => void
  readonly change: (field: keyof CapabilitySpecificationDraft, value: string) => void
  readonly saveRevision: () => void
}

const EMPTY_DRAFT: CapabilitySpecificationDraft = { goal: '', nonGoals: '', businessRules: '', unresolved: '' }

export function useCapabilitySpecifications(active: boolean): CapabilitySpecificationsControl {
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>()
  const [selected, setSelected] = useState<CapabilitySpecificationView>()
  const [comparison, setComparison] = useState<CapabilitySpecificationDiffView>()
  const [draft, setDraft] = useState<CapabilitySpecificationDraft>(EMPTY_DRAFT)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  const applySpecification = (specification: CapabilitySpecificationView) => {
    setSelected(specification)
    setDraft(draftOf(specification))
    setComparison(undefined)
    if (specification.supersedesId) {
      void compareCapabilitySpecificationRevisions(specification.supersedesId, specification.id).then(setComparison, () => undefined)
    }
  }

  const select = (id: string) => {
    setLoading(true)
    setError(undefined)
    setNotice(undefined)
    void fetchCapabilitySpecification(id).then(applySpecification, fail(setError, 'unable to read capability specification')).finally(() => setLoading(false))
  }

  const load = () => {
    if (loading) return
    setAttempted(true)
    setLoading(true)
    setError(undefined)
    void fetchWorkbench().then((next) => {
      setSnapshot(next)
      const selectedId = selected && next.specifications.some((item) => item.id === selected.id)
        ? selected.id
        : next.specifications.at(-1)?.id
      if (selectedId) return fetchCapabilitySpecification(selectedId).then(applySpecification)
      setSelected(undefined)
      setDraft(EMPTY_DRAFT)
      setComparison(undefined)
      return undefined
    }).catch(fail(setError, 'unable to load capability specifications')).finally(() => setLoading(false))
  }

  useEffect(() => {
    if (active && !attempted) load()
  }, [active, attempted])

  const dirty = useMemo(() => selected !== undefined && JSON.stringify(draft) !== JSON.stringify(draftOf(selected)), [selected, draft])

  const change = (field: keyof CapabilitySpecificationDraft, value: string) => {
    setNotice(undefined)
    setDraft((current) => ({ ...current, [field]: value }))
  }

  const saveRevision = () => {
    if (!selected || !snapshot?.mutable || !dirty || saving) return
    setSaving(true)
    setError(undefined)
    void reviseCapabilitySpecification(selected.id, {
      goal: draft.goal,
      nonGoals: lines(draft.nonGoals),
      businessRules: lines(draft.businessRules),
      unresolved: lines(draft.unresolved),
    }).then((revised) => fetchWorkbench().then((next) => {
      setSnapshot(next)
      applySpecification(revised)
      setNotice(`Revision ${revised.revision} created. Existing Plans and Candidates remain bound to their prior digest.`)
    })).catch(fail(setError, 'unable to revise capability specification')).finally(() => setSaving(false))
  }

  return { snapshot, selected, comparison, draft, loading, saving, error, notice, dirty, load, select, change, saveRevision }
}

function draftOf(specification: CapabilitySpecificationView): CapabilitySpecificationDraft {
  return {
    goal: specification.goal,
    nonGoals: specification.nonGoals.join('\n'),
    businessRules: specification.businessRules.join('\n'),
    unresolved: specification.unresolved.join('\n'),
  }
}

function lines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean)
}

function fail(setError: (value: string) => void, fallback: string) {
  return (caught: unknown) => setError(caught instanceof Error ? caught.message : fallback)
}
