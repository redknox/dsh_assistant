export const name = 'third-party-text-reverse'

export function apply(ctx) {
  const dispose = ctx.tools.register({
    name: 'text_reverse',
    description: 'Reverse a text string inside the isolated extension runtime.',
    parameters: { text: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: String(value) }] },
    },
    async execute(args) {
      return String(args.text ?? '').split('').reverse().join('')
    },
  })
  ctx.effect(() => dispose)
}
