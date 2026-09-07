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
  readonly operations?: SettingsOperationsView
}

export interface SettingsOperationsView {
  readonly backup?: {
    readonly state: 'ready' | 'failed' | 'not-run'
    readonly day?: string
    readonly createdAt?: string
    readonly restoreVerifiedAt?: string
    readonly assets?: readonly string[]
    readonly message: string
  }
  readonly feishu?: {
    readonly state: 'ready' | 'expiring' | 'expired' | 'unavailable' | 'not-configured'
    readonly expiresAt?: string
    readonly daysRemaining?: number
    readonly message: string
    readonly reauthenticateCommand: string
  }
  readonly reliability?: {
    readonly state: 'quiet' | 'attention'
    readonly since: string
    readonly p0: number
    readonly p1: number
    readonly total: number
    readonly byCategory: Readonly<Record<'startup' | 'tool' | 'approval' | 'compaction' | 'backup' | 'connector', number>>
    readonly recent: readonly {
      readonly id: string
      readonly occurredAt: string
      readonly severity: 'P0' | 'P1' | 'P2'
      readonly category: 'startup' | 'tool' | 'approval' | 'compaction' | 'backup' | 'connector'
      readonly code: string
      readonly message: string
      readonly sessionId?: string
    }[]
  }
}

export interface SettingsUpdate {
  readonly revision: string
  readonly changes: readonly {
    readonly id: string
    readonly value?: string
    readonly clear?: boolean
  }[]
}
