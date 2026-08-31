import { useEffect, useState } from 'react'
import type {
  ExpenseReviewAvailability,
  ExpenseReviewInput,
  ExpenseReviewRecord,
} from '../../src/domain/expense-review/types'
import { fetchExpenseReviewAvailability, submitExpenseReview } from './api'

export interface ExpenseReviewControl {
  readonly availability?: ExpenseReviewAvailability
  readonly draft: ExpenseReviewInput
  readonly result?: ExpenseReviewRecord
  readonly loading: boolean
  readonly running: boolean
  readonly error?: string
  readonly load: () => void
  readonly change: <K extends keyof ExpenseReviewInput>(field: K, value: ExpenseReviewInput[K]) => void
  readonly submit: () => void
}

const INITIAL_DRAFT: ExpenseReviewInput = {
  claimId: '',
  entity: '',
  employee: '',
  category: 'Travel',
  amount: 0,
  currency: 'CNY',
  receiptAttached: false,
  purpose: '',
}

export function useExpenseReview(active: boolean): ExpenseReviewControl {
  const [availability, setAvailability] = useState<ExpenseReviewAvailability>()
  const [draft, setDraft] = useState<ExpenseReviewInput>(INITIAL_DRAFT)
  const [result, setResult] = useState<ExpenseReviewRecord>()
  const [loading, setLoading] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string>()

  const load = () => {
    if (loading) return
    setAttempted(true)
    setLoading(true)
    setError(undefined)
    void fetchExpenseReviewAvailability().then(setAvailability, (caught: unknown) => {
      setError(caught instanceof Error ? caught.message : 'unable to inspect expense review capability')
    }).finally(() => setLoading(false))
  }

  useEffect(() => {
    if (active && !attempted) load()
  }, [active, attempted])

  const change = <K extends keyof ExpenseReviewInput>(field: K, value: ExpenseReviewInput[K]) => {
    setDraft((current) => ({ ...current, [field]: value }))
    setResult(undefined)
    setError(undefined)
  }

  const submit = () => {
    if (running || availability?.status !== 'ready') return
    setRunning(true)
    setResult(undefined)
    setError(undefined)
    void submitExpenseReview(draft).then(setResult, (caught: unknown) => {
      setError(caught instanceof Error ? caught.message : 'expense review failed')
    }).finally(() => setRunning(false))
  }

  return { availability, draft, result, loading, running, error, load, change, submit }
}
