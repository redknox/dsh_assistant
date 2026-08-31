import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { inspectMaterialInput } from '../src/product/material-input.js'
import { bootAssistantControl, bootSafeModeRuntime, createAssistantAgent } from '../src/runtime/boot.js'
import { AssistantControlSurface } from '../src/ui/controller.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

describe('Material input', () => {
  it('discovers path-only references from the governed Files sandbox and persists immutable images', async () => {
    const previous = process.env.DSH_ASSISTANT_SANDBOX_ROOT
    const sandbox = mkdtempSync(path.join(tmpdir(), 'tars-material-sandbox-'))
    const home = mkdtempSync(path.join(tmpdir(), 'tars-material-home-'))
    mkdirSync(path.join(sandbox, 'Project Notes'), { recursive: true })
    writeFileSync(path.join(sandbox, 'Project Notes', 'Alpha.md'), 'secret body stays unread\n')
    writeFileSync(path.join(sandbox, 'plain.txt'), 'plain body\n')
    process.env.DSH_ASSISTANT_SANDBOX_ROOT = sandbox
    const control = await bootAssistantControl({ home, allowFixtures: false })
    const handle = await createAssistantAgent(control.ctx, 'material-input')
    try {
      const candidates = await control.ctx.fileReferences.list(handle.agent, 'alpha', AbortSignal.timeout(5_000))
      assert.deepEqual(candidates, [{ path: 'Project Notes/Alpha.md', kind: 'file' }])
      assert.equal(JSON.stringify(candidates).includes('secret body'), false)

      const directories = await control.ctx.fileReferences.list(handle.agent, 'Project', AbortSignal.timeout(5_000))
      assert.deepEqual(directories, [
        { path: 'Project Notes', kind: 'directory' },
        { path: 'Project Notes/Alpha.md', kind: 'file' },
      ])

      const ref = await control.ctx.attachments.saveImage({
        data: ONE_PIXEL_PNG,
        mediaType: 'image/png',
        name: '/browser/path/pixel.png',
      })
      assert.match(String(ref.attachmentId), /^sha256:[a-f0-9]{64}$/)
      assert.equal(ref.name, 'pixel.png')
      assert.deepEqual(Buffer.from((await control.ctx.attachments.readImage(ref)).data), ONE_PIXEL_PNG)
      assert.equal(statSync(path.join(home, 'attachments')).mode & 0o077, 0)

      assert.deepEqual(inspectMaterialInput(control.ctx), {
        fileReferences: 'active',
        imageStore: 'ready',
        imageInput: 'unsupported',
      })
      const view = new AssistantControlSurface(control.ctx, 'material-input').workspace()
      assert.equal(view.materialInput?.fileReferences, 'active')
      assert.equal(view.materialInput?.imageStore, 'ready')
    } finally {
      await handle.dispose()
      await control.ctx.fiber.dispose()
      if (previous === undefined) delete process.env.DSH_ASSISTANT_SANDBOX_ROOT
      else process.env.DSH_ASSISTANT_SANDBOX_ROOT = previous
    }
  })

  it('withholds optional material services in Safe Mode', async () => {
    const control = await bootSafeModeRuntime()
    try {
      assert.equal(control.ctx.get('fileReferences'), undefined)
      assert.equal(control.ctx.get('attachments'), undefined)
      assert.deepEqual(inspectMaterialInput(control.ctx), {
        fileReferences: 'unavailable',
        imageStore: 'unavailable',
        imageInput: 'unsupported',
      })
    } finally {
      await control.ctx.fiber.dispose()
    }
  })
})
