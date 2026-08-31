import { useEffect, useMemo, useState } from 'react'
import type { SettingsSnapshot, SettingsUpdate } from '../../src/product/settings-types'
import { fetchSettings, saveSettings } from './api'

export interface SettingsControl {
  readonly snapshot?: SettingsSnapshot
  readonly draft: Readonly<Record<string, string>>
  readonly clearing: ReadonlySet<string>
  readonly loading: boolean
  readonly saving: boolean
  readonly error?: string
  readonly notice?: string
  readonly dirty: boolean
  readonly load: () => void
  readonly change: (id: string, value: string) => void
  readonly clear: (id: string) => void
  readonly save: () => void
}

export function useSettingsControl(active: boolean): SettingsControl {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>()
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [clearing, setClearing] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  const apply = (next: SettingsSnapshot) => {
    setSnapshot(next)
    setDraft(Object.fromEntries(next.fields.filter((field) => field.kind !== 'secret').map((field) => [field.id, field.value ?? ''])))
    setClearing(new Set())
  }

  const load = () => {
    if (loading) return
    setAttempted(true)
    setLoading(true)
    setError(undefined)
    void fetchSettings().then(apply, (caught: unknown) => {
      setError(caught instanceof Error ? caught.message : 'unable to load settings')
    }).finally(() => setLoading(false))
  }

  useEffect(() => {
    if (active && !attempted) load()
  }, [active, attempted])

  const dirty = useMemo(() => {
    if (!snapshot) return false
    if (clearing.size > 0) return true
    return snapshot.fields.some((field) => (
      field.kind === 'secret'
        ? Boolean(draft[field.id])
        : (draft[field.id] ?? '') !== (field.value ?? '')
    ))
  }, [snapshot, draft, clearing])

  const change = (id: string, value: string) => {
    setNotice(undefined)
    setDraft((current) => ({ ...current, [id]: value }))
    setClearing((current) => {
      const next = new Set(current)
      next.delete(id)
      return next
    })
  }

  const clear = (id: string) => {
    setNotice(undefined)
    setDraft((current) => ({ ...current, [id]: '' }))
    setClearing((current) => new Set(current).add(id))
  }

  const save = () => {
    if (!snapshot || !dirty || saving) return
    const changes: SettingsUpdate['changes'] = snapshot.fields.flatMap<SettingsUpdate['changes'][number]>((field) => {
      if (clearing.has(field.id)) return [{ id: field.id, clear: true }]
      const value = draft[field.id] ?? ''
      if (field.kind === 'secret') return value ? [{ id: field.id, value }] : []
      if (value === (field.value ?? '')) return []
      return value === '' ? [{ id: field.id, clear: true }] : [{ id: field.id, value }]
    })
    setSaving(true)
    setError(undefined)
    void saveSettings({ revision: snapshot.revision, changes }).then((next) => {
      apply(next)
      setNotice('Saved securely. Restart TARS-NG to apply these changes.')
    }, (caught: unknown) => {
      setError(caught instanceof Error ? caught.message : 'unable to save settings')
    }).finally(() => setSaving(false))
  }

  return { snapshot, draft, clearing, loading, saving, error, notice, dirty, load, change, clear, save }
}
