import { useEffect, useMemo, useState } from 'react'
import type { CapabilityEvaluationView, CapabilitySpecificationDiffView, CapabilitySpecificationView } from '../../src/product/web-ui-workbench-types'
import {
  compareCapabilitySpecificationRevisions,
  defineCapabilitySpecification,
  fetchCapabilityEvaluation,
  fetchCapabilitySpecification,
  fetchWorkbench,
  reviseCapabilitySpecification,
  stopCapabilityDelivery,
  type WorkbenchSnapshot,
} from './api'

export interface CapabilitySpecificationDraft {
  readonly goal: string
  readonly nonGoals: string
  readonly businessRules: string
  readonly unresolved: string
}

export interface NewCapabilitySpecificationDraft {
  readonly capability: string
  readonly goal: string
  readonly nonGoals: string
  readonly businessRules: string
  readonly permissions: string
  readonly remoteSideEffect: 'none' | 'read-only' | 'mutate'
  readonly filesystem: string
  readonly network: string
  readonly process: string
  readonly secrets: string
  readonly externalSystems: string
  readonly acceptanceName: string
  readonly acceptanceGiven: string
  readonly acceptanceWhen: string
  readonly acceptanceThen: string
  readonly unresolved: string
}

export interface CapabilitySpecificationsControl {
  readonly snapshot?: WorkbenchSnapshot
  readonly selected?: CapabilitySpecificationView
  readonly comparison?: CapabilitySpecificationDiffView
  readonly evaluation?: CapabilityEvaluationView
  readonly draft: CapabilitySpecificationDraft
  readonly creating: boolean
  readonly createDraft: NewCapabilitySpecificationDraft
  readonly canCreate: boolean
  readonly loading: boolean
  readonly saving: boolean
  readonly stopping: boolean
  readonly confirmingStopId?: string
  readonly error?: string
  readonly notice?: string
  readonly dirty: boolean
  readonly load: () => void
  readonly select: (id: string) => void
  readonly change: (field: keyof CapabilitySpecificationDraft, value: string) => void
  readonly saveRevision: () => void
  readonly beginCreate: () => void
  readonly cancelCreate: () => void
  readonly changeCreate: (field: keyof NewCapabilitySpecificationDraft, value: string) => void
  readonly createSpecification: () => void
  readonly askStop: (id: string) => void
  readonly cancelStop: () => void
  readonly stopDelivery: () => void
}

const EMPTY_DRAFT: CapabilitySpecificationDraft = { goal: '', nonGoals: '', businessRules: '', unresolved: '' }
const EMPTY_CREATE_DRAFT: NewCapabilitySpecificationDraft = {
  capability: '',
  goal: '',
  nonGoals: '',
  businessRules: '',
  permissions: '',
  remoteSideEffect: 'none',
  filesystem: '',
  network: '',
  process: '',
  secrets: '',
  externalSystems: '',
  acceptanceName: 'Initial acceptance',
  acceptanceGiven: '',
  acceptanceWhen: '',
  acceptanceThen: '',
  unresolved: '',
}

export function useCapabilitySpecifications(active: boolean): CapabilitySpecificationsControl {
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>()
  const [selected, setSelected] = useState<CapabilitySpecificationView>()
  const [comparison, setComparison] = useState<CapabilitySpecificationDiffView>()
  const [evaluation, setEvaluation] = useState<CapabilityEvaluationView>()
  const [draft, setDraft] = useState<CapabilitySpecificationDraft>(EMPTY_DRAFT)
  const [creating, setCreating] = useState(false)
  const [createDraft, setCreateDraft] = useState<NewCapabilitySpecificationDraft>(EMPTY_CREATE_DRAFT)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [confirmingStopId, setConfirmingStopId] = useState<string>()
  const [attempted, setAttempted] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  const applySpecification = (specification: CapabilitySpecificationView) => {
    setSelected(specification)
    setDraft(draftOf(specification))
    setComparison(undefined)
    setEvaluation(undefined)
    void fetchCapabilityEvaluation(specification.id).then(setEvaluation, () => undefined)
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
      setEvaluation(undefined)
      return undefined
    }).catch(fail(setError, 'unable to load capability specifications')).finally(() => setLoading(false))
  }

  useEffect(() => {
    if (active && !attempted) load()
  }, [active, attempted])

  const dirty = useMemo(() => selected !== undefined && JSON.stringify(draft) !== JSON.stringify(draftOf(selected)), [selected, draft])
  const canCreate = useMemo(() => (
    createDraft.capability.trim() !== ''
    && createDraft.goal.trim() !== ''
    && lines(createDraft.businessRules).length > 0
    && createDraft.acceptanceWhen.trim() !== ''
    && lines(createDraft.acceptanceThen).length > 0
  ), [createDraft])

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

  const beginCreate = () => {
    setCreating(true)
    setCreateDraft(EMPTY_CREATE_DRAFT)
    setError(undefined)
    setNotice(undefined)
  }

  const cancelCreate = () => {
    setCreating(false)
    setCreateDraft(EMPTY_CREATE_DRAFT)
  }

  const changeCreate = (field: keyof NewCapabilitySpecificationDraft, value: string) => {
    setNotice(undefined)
    setCreateDraft((current) => ({ ...current, [field]: value }))
  }

  const createSpecification = () => {
    if (!snapshot?.mutable || !canCreate || saving) return
    setSaving(true)
    setError(undefined)
    void defineCapabilitySpecification({
      capability: createDraft.capability,
      goal: createDraft.goal,
      nonGoals: lines(createDraft.nonGoals),
      businessRules: lines(createDraft.businessRules),
      permissions: lines(createDraft.permissions),
      effects: {
        filesystem: lines(createDraft.filesystem),
        network: lines(createDraft.network),
        process: lines(createDraft.process),
        secrets: lines(createDraft.secrets),
        externalSystems: lines(createDraft.externalSystems),
        remoteSideEffect: createDraft.remoteSideEffect,
      },
      acceptanceExamples: [{
        name: createDraft.acceptanceName,
        given: lines(createDraft.acceptanceGiven),
        when: createDraft.acceptanceWhen,
        then: lines(createDraft.acceptanceThen),
      }],
      unresolved: lines(createDraft.unresolved),
    }).then((created) => fetchWorkbench().then((next) => {
      setSnapshot(next)
      applySpecification(created)
      setCreating(false)
      setCreateDraft(EMPTY_CREATE_DRAFT)
      setNotice(`Specification ${created.id} created. Capability Resolution must run before any Candidate or Tool can exist.`)
    })).catch(fail(setError, 'unable to create capability specification')).finally(() => setSaving(false))
  }

  const askStop = (id: string) => {
    if (!snapshot?.mutable || stopping) return
    setConfirmingStopId(id)
    setError(undefined)
  }

  const cancelStop = () => setConfirmingStopId(undefined)

  const stopDelivery = () => {
    if (!confirmingStopId || !snapshot?.mutable || stopping) return
    const id = confirmingStopId
    setStopping(true)
    setError(undefined)
    void stopCapabilityDelivery(id).then(() => fetchWorkbench()).then((next) => {
      setSnapshot(next)
      setConfirmingStopId(undefined)
      setNotice('Development stopped. The immutable specification and governance evidence remain available in History.')
    }).catch(fail(setError, 'unable to stop capability delivery')).finally(() => setStopping(false))
  }

  return {
    snapshot, selected, comparison, evaluation, draft, creating, createDraft, canCreate,
    loading, saving, stopping, confirmingStopId, error, notice, dirty, load, select, change, saveRevision,
    beginCreate, cancelCreate, changeCreate, createSpecification,
    askStop, cancelStop, stopDelivery,
  }
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
