export const name = 'generated-r0-transform'
export const inject = ['tools']

export function apply(ctx) {
  const dispose = ctx.tools.register({
    name: 'r0_transform',
    description: 'Pure text transform isolated from the host process.',
    parameters: { text: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: String(value) }] },
    },
    async execute(args) {
      return String(args.text ?? '').toUpperCase()
    },
  })
  ctx.effect(() => dispose)
}
