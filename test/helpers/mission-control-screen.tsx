import React from 'react'
import type { MissionControlView } from '../../src/domain/workspace/types.js'
import {
  MissionControlScreen as MissionControlScreenView,
} from '../../web/src/MissionControlScreen.js'
import type { WorkspacePane } from '../../web/src/WorkspaceNavigation.js'

interface LegacyMissionControlScreenProps {
  readonly view: MissionControlView
  readonly connected?: boolean
  readonly sending?: boolean
  readonly error?: string
  readonly draft?: string
  readonly acknowledgement?: { readonly text: string }
  readonly armedRecovery?: 'diagnostics' | 'rollback' | 'exit-safe-mode'
  readonly deferredActivations?: readonly string[]
  readonly armedActivation?: string
  readonly armedAbandonment?: string
  readonly deferredRollback?: boolean
  readonly armedRollback?: boolean
  readonly pane?: WorkspacePane
  readonly confirmingSession?: string
  readonly inspectingExtension?: string
  readonly confirmingPlugin?: string
  readonly confirmingSkill?: string
  readonly armedSkill?: string
  readonly skillDependents?: { readonly id: string; readonly dependents: readonly string[] }
  readonly [key: string]: unknown
}

export function MissionControlScreen(props: LegacyMissionControlScreenProps) {
  return (
    <MissionControlScreenView
      view={props.view}
      runtime={{
        connected: props.connected ?? false,
        error: props.error,
        acknowledgement: props.acknowledgement,
        dismissAcknowledgement() {},
      }}
      conversation={{
        sending: props.sending ?? false,
        draft: props.draft ?? '',
        dispatch() {},
      }}
      governance={{
        state: {
          armedRecovery: props.armedRecovery,
          deferredActivations: props.deferredActivations ?? [],
          armedActivation: props.armedActivation,
          armedAbandonment: props.armedAbandonment,
          deferredRollback: props.deferredRollback ?? false,
          armedRollback: props.armedRollback ?? false,
        },
        dispatch() {},
      }}
      workspace={{
        state: {
          confirmingSession: props.confirmingSession,
          inspectingExtension: props.inspectingExtension,
          confirmingPlugin: props.confirmingPlugin
            ? props.view.plugins.find((plugin) => plugin.id === props.confirmingPlugin)
            : undefined,
        },
        dispatch() {},
      }}
      skill={{
        state: {
          confirmingSkill: props.confirmingSkill,
          armedSkill: props.armedSkill,
          dependents: props.skillDependents
            ? { id: props.skillDependents.id, values: props.skillDependents.dependents }
            : undefined,
        },
        dispatch() {},
      }}
      settings={{
        draft: {},
        clearing: new Set(),
        loading: false,
        saving: false,
        dirty: false,
        load() {},
        change() {},
        clear() {},
        save() {},
      }}
      specifications={{
        draft: { goal: '', nonGoals: '', businessRules: '', unresolved: '' },
        loading: false,
        saving: false,
        dirty: false,
        load() {},
        select() {},
        change() {},
        saveRevision() {},
      }}
      expenseReview={{
        draft: {
          claimId: '', entity: '', employee: '', category: 'Travel', amount: 0,
          currency: 'CNY', receiptAttached: false, purpose: '',
        },
        loading: false,
        running: false,
        load() {},
        change() {},
        submit() {},
      }}
      navigation={{ pane: props.pane ?? 'today', navigate() {} }}
    />
  )
}
