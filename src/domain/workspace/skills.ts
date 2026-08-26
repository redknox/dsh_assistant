import type { SkillProjection, WorkspaceSnapshotInput } from './types.js'

export function projectSkills(input: WorkspaceSnapshotInput): readonly SkillProjection[] {
  return [...(input.skills ?? [])]
}

export function skillActivity(input: WorkspaceSnapshotInput) {
  return (input.skills ?? []).map((skill) => ({
    id: `skill-${skill.id}`,
    kind: skill.lifecycle === 'approval-requested' ? 'APPROVAL_REQUIRED' as const
      : skill.lifecycle === 'active' ? 'COMPLETED' as const
        : skill.lifecycle === 'disabled' || skill.lifecycle === 'uninstalled' ? 'RECOVERED' as const
          : 'OBSERVED' as const,
    summary: `Skill ${skill.name}@${skill.version} ${skill.lifecycle}`,
    source: 'skill.lifecycle',
  }))
}
