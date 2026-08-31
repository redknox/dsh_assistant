import React from 'react'
import type { SettingsFieldView, SettingsGroup } from '../../src/product/settings-types'
import type { SettingsControl } from './useSettingsControl'
import { Glyph } from './icons'

const GROUPS: readonly SettingsGroup[] = ['AI', 'Feishu', 'Calendar', 'Knowledge', 'Workspace']

export function SettingsWorkspace(props: { readonly control: SettingsControl; readonly locked: boolean }) {
  const { control } = props
  return (
    <main className="conversation-panel instrument-panel settings-workspace" aria-label="Settings">
      <header className="workspace-title settings-title">
        <div>
          <span className="eyebrow">LOCAL CONTROL / CONFIGURATION</span>
          <h1>SETTINGS</h1>
          <p>Connector settings are stored in the private TARS-NG Home. Secrets are write-only.</p>
        </div>
        <button type="button" className="button button--secondary" disabled={control.loading} onClick={control.load}>REFRESH</button>
      </header>
      {control.loading && !control.snapshot ? <p className="settings-state">Reading local configuration…</p> : null}
      {control.error ? <p className="settings-alert" role="alert">{control.error}</p> : null}
      {control.notice ? <p className="settings-notice" role="status">{control.notice}</p> : null}
      {control.snapshot && !control.snapshot.envFileReady ? <p className="settings-alert">The Home env file has unsafe permissions. Saving will repair it to owner-only mode.</p> : null}
      {control.snapshot ? (
        <div className="settings-groups">
          {GROUPS.map((group) => {
            const fields = control.snapshot!.fields.filter((field) => field.group === group)
            if (fields.length === 0) return null
            return (
              <section className="settings-group" key={group} aria-labelledby={`settings-${group}`}>
                <div className="settings-group-heading">
                  <span className="control-lamp" aria-hidden="true" />
                  <h2 id={`settings-${group}`}>{group.toUpperCase()}</h2>
                </div>
                {fields.map((field) => <SettingsField key={field.id} field={field} control={control} locked={props.locked} />)}
              </section>
            )
          })}
        </div>
      ) : null}
      <footer className="settings-footer">
        <p><Glyph name="shield" /> Changes are version-bound and take effect after restart.</p>
        <button type="button" className="button button--approval" disabled={props.locked || control.saving || !control.dirty} onClick={control.save}>
          {control.saving ? 'SAVING…' : 'SAVE CONFIGURATION'}
        </button>
      </footer>
    </main>
  )
}

function SettingsField(props: { readonly field: SettingsFieldView; readonly control: SettingsControl; readonly locked: boolean }) {
  const { field, control } = props
  const value = control.draft[field.id] ?? ''
  const cleared = control.clearing.has(field.id)
  const disabled = props.locked || !field.editable
  const status = field.source === 'environment'
    ? 'EXTERNALLY MANAGED · READ ONLY'
    : cleared ? 'WILL CLEAR' : field.present ? 'CONFIGURED · HOME' : 'NOT CONFIGURED'
  return (
    <div className="settings-field" data-setting-id={field.id}>
      <label htmlFor={`setting-${field.id}`}>
        <strong>{field.label}</strong>
        <span>{field.description}</span>
      </label>
      <div className="settings-input-row">
        {field.kind === 'select' ? (
          <select id={`setting-${field.id}`} value={value} disabled={disabled} onChange={(event) => event.target.value === '' ? control.clear(field.id) : control.change(field.id, event.target.value)}>
            {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        ) : (
          <input
            id={`setting-${field.id}`}
            type={field.kind === 'secret' ? 'password' : 'text'}
            autoComplete="off"
            value={value}
            placeholder={field.kind === 'secret' && field.present ? 'Stored — enter to replace' : field.kind === 'path' ? '/absolute/path' : ''}
            disabled={disabled}
            onChange={(event) => control.change(field.id, event.target.value)}
          />
        )}
        {field.editable && field.present && !cleared ? <button type="button" className="button button--secondary settings-clear" disabled={props.locked} onClick={() => control.clear(field.id)}>CLEAR</button> : null}
      </div>
      <small className={field.present && !cleared ? 'settings-status settings-status--ready' : 'settings-status'}>{status}</small>
    </div>
  )
}
