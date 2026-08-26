import type { SkillProjection, WorkspaceSnapshotInput } from './types.js'

export function projectSkills(input: WorkspaceSnapshotInput): readonly SkillProjection[] {
  return [...(input.skills ?? [])]
}

export function skillActivity(input: WorkspaceSnapshotInput) {
  return (input.skillEvents ?? []).map((event) => ({
    id: `skill-event-${event.id}`,
    kind: event.kind === 'catalog-degraded' || event.kind === 'rejected' ? 'FAILED' as const
      : event.kind === 'recovery' ? 'RECOVERED' as const
        : event.kind === 'approval-requested' || event.kind === 'review' ? 'APPROVAL_REQUIRED' as const
          : event.kind === 'disable' || event.kind === 'uninstall' ? 'RECOVERED' as const
            : event.kind === 'activate' || event.kind === 'approved' || event.kind === 'rollback' ? 'COMPLETED' as const
              : event.kind === 'update' ? 'OBSERVED' as const
              : 'OBSERVED' as const,
    summary: [
      event.name && event.version ? `Skill ${event.name}@${event.version}` : 'Skill',
      event.kind,
      event.detail,
    ].filter((item): item is string => Boolean(item)).join(' '),
    source: 'skill.lifecycle',
  }))
}
