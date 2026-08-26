import type { Context } from '@deepseek-ai/cordis'
import { FileSystemSkillProvider, type Config } from '@deepseek-ai/dsh-skill-filesystem'

export interface MountedSkillFilesystem {
  readonly invalidate: () => void
  readonly provider: FileSystemSkillProvider
}

/** Register the official filesystem provider and retain its registration-scoped invalidate. */
export async function mountGovernedSkillFilesystem(
  ctx: Context,
  config: Config,
): Promise<MountedSkillFilesystem> {
  let mounted: MountedSkillFilesystem | undefined
  await ctx.plugin({
    name: 'skill-filesystem',
    inject: ['skills'],
    apply(scope: Context) {
      let provider: FileSystemSkillProvider
      scope.skills.registerProvider((control) => {
        provider = new FileSystemSkillProvider(scope, control, config)
        mounted = { invalidate: control.invalidate, provider }
        return provider
      })
      scope.effect(function* () {
        yield async () => {
          await provider.dispose()
        }
      }, 'skill-filesystem watcher')
    },
  })
  if (mounted === undefined) {
    throw new Error('skill-filesystem provider did not register')
  }
  return mounted
}
