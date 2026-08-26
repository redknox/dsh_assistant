import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillService } from '../domain/skill/index.js'

function textOutput() {
  return {
    schema: { type: 'string' as const },
    render(_args: unknown, value: string) {
      return [{ type: 'text' as const, text: value }]
    },
  }
}

export const SKILL_INSPECT_TOOLS = ['inspect_skill'] as const

export const SKILL_WORKBENCH_TOOLS = [
  'plan_skill',
  'create_skill_candidate',
  'inspect_skill',
  'list_skill_files',
  'read_skill_file',
  'write_skill_file',
  'validate_skill',
  'seal_skill',
  'request_skill_review',
  'request_skill_approval',
] as const

function bounded(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return JSON.stringify({ error: message.split(/\r?\n/, 1)[0] })
}

export function registerSkillTools(
  ctx: Context,
  skills: SkillService,
  options: { readonly inspectOnly?: boolean } = {},
): void {
  ctx.tools.register(defineTool({
    name: 'inspect_skill',
    description: 'Inspect a Skill candidate lifecycle without computing an approval fingerprint.',
    parameters: { candidateId: { type: 'string', required: true } },
    output: textOutput(),
    async execute(args) {
      try {
        return JSON.stringify(skills.inspect(String(args.candidateId ?? '')))
      } catch (error) {
        return bounded(error)
      }
    },
  }))

  if (options.inspectOnly) return

  ctx.tools.register(defineTool({
    name: 'plan_skill',
    description: 'Plan an inactive Skill candidate. Does not approve or activate.',
    parameters: { name: { type: 'string', required: true } },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify({ kind: 'skill-plan', name: String(args.name ?? ''), grantsCapability: false, nextAction: 'create_skill_candidate' })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'create_skill_candidate',
    description: 'Create an inactive assistant-authored Skill candidate.',
    parameters: {
      name: { type: 'string', required: true },
      description: { type: 'string', required: true },
      body: { type: 'string', required: true },
    },
    output: textOutput(),
    async execute(args) {
      try {
        const created = skills.create({
          name: String(args.name ?? ''),
          description: String(args.description ?? ''),
          body: String(args.body ?? ''),
        })
        return JSON.stringify({ id: created.id, lifecycle: created.lifecycle, sealed: created.sealed, approval: 'NOT APPROVED' })
      } catch (error) {
        return bounded(error)
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'list_skill_files',
    description: 'List allowlisted files in an inactive Skill candidate.',
    parameters: { candidateId: { type: 'string', required: true } },
    output: textOutput(),
    async execute(args) {
      try {
        return JSON.stringify({ files: skills.listFiles(String(args.candidateId ?? '')) })
      } catch (error) {
        return bounded(error)
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'read_skill_file',
    description: 'Read one allowlisted Skill candidate file.',
    parameters: {
      candidateId: { type: 'string', required: true },
      path: { type: 'string', required: true },
    },
    output: textOutput(),
    async execute(args) {
      try {
        return skills.readFile(String(args.candidateId ?? ''), String(args.path ?? ''))
      } catch (error) {
        return bounded(error)
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'write_skill_file',
    description: 'Write one allowlisted Skill candidate file. A sealed edit creates a new revision.',
    parameters: {
      candidateId: { type: 'string', required: true },
      path: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
    output: textOutput(),
    async execute(args) {
      try {
        const record = skills.writeFile(
          String(args.candidateId ?? ''),
          String(args.path ?? ''),
          String(args.content ?? ''),
        )
        return JSON.stringify({ id: record.id, lifecycle: record.lifecycle, sealed: record.sealed, digest: record.digest })
      } catch (error) {
        return bounded(error)
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'validate_skill',
    description: 'Validate a Skill candidate through the DSH-native parser.',
    parameters: { candidateId: { type: 'string', required: true } },
    output: textOutput(),
    async execute(args) {
      try {
        const record = await skills.validate(String(args.candidateId ?? ''))
        return JSON.stringify({ id: record.id, lifecycle: record.lifecycle, validationPassed: record.validationPassed })
      } catch (error) {
        return bounded(error)
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'seal_skill',
    description: 'Seal exact Skill candidate bytes.',
    parameters: { candidateId: { type: 'string', required: true } },
    output: textOutput(),
    async execute(args) {
      try {
        const record = skills.seal(String(args.candidateId ?? ''))
        return JSON.stringify({ id: record.id, sealed: record.sealed, digest: record.digest })
      } catch (error) {
        return bounded(error)
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'request_skill_review',
    description: 'Submit a sealed Skill candidate to Independent Review. Does not self-certify review.',
    parameters: { candidateId: { type: 'string', required: true } },
    output: textOutput(),
    async execute(args) {
      try {
        const { record, report } = skills.requestReview(String(args.candidateId ?? ''))
        return JSON.stringify({
          id: record.id,
          lifecycle: record.lifecycle,
          reviewComplete: record.reviewComplete,
          reviewState: report.state,
          approvalStatus: report.approvalStatus,
        })
      } catch (error) {
        return bounded(error)
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'request_skill_approval',
    description: 'Request human approval for an exact Skill revision. Does not approve or activate.',
    parameters: { candidateId: { type: 'string', required: true } },
    output: textOutput(),
    async execute(args) {
      try {
        return JSON.stringify(skills.requestApproval(String(args.candidateId ?? '')))
      } catch (error) {
        return bounded(error)
      }
    },
  }))
}
