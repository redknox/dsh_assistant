export type SettingsFieldKind = 'secret' | 'text' | 'path' | 'select'
export type SettingsGroup = 'AI' | 'Feishu' | 'Calendar' | 'Knowledge' | 'Workspace'

export interface SettingsFieldView {
  readonly id: string
  readonly label: string
  readonly group: SettingsGroup
  readonly kind: SettingsFieldKind
  readonly description: string
  readonly present: boolean
  readonly source: 'home' | 'environment' | 'none'
  readonly editable: boolean
  readonly value?: string
  readonly options?: readonly { readonly value: string; readonly label: string }[]
}

export interface SettingsSnapshot {
  readonly revision: string
  readonly fields: readonly SettingsFieldView[]
  readonly restartRequired: boolean
  readonly envFileReady: boolean
}

export interface SettingsUpdate {
  readonly revision: string
  readonly changes: readonly {
    readonly id: string
    readonly value?: string
    readonly clear?: boolean
  }[]
}
