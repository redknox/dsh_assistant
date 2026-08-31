import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function emitFontLicenses() {
  return {
    name: 'emit-font-licenses',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'licenses/Inter-OFL.txt',
        source: readFileSync(path.resolve(import.meta.dirname, 'src/fonts/LICENSE.txt'), 'utf8'),
      })
      this.emitFile({
        type: 'asset',
        fileName: 'licenses/Barlow-OFL.txt',
        source: readFileSync(path.resolve(import.meta.dirname, 'src/fonts/Barlow-OFL.txt'), 'utf8'),
      })
      this.emitFile({
        type: 'asset',
        fileName: 'licenses/ZCOOL-QingKe-HuangYou-OFL.txt',
        source: readFileSync(path.resolve(import.meta.dirname, '../node_modules/@fontsource/zcool-qingke-huangyou/LICENSE'), 'utf8'),
      })
    },
  }
}

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [react(), emitFontLicenses()],
  build: {
    outDir: path.resolve(import.meta.dirname, '../dist/web'),
    emptyOutDir: true,
    sourcemap: false,
    assetsDir: 'assets',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
})
