import { build } from 'esbuild'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

rmSync('dist', { recursive: true, force: true })
mkdirSync('dist', { recursive: true })

// No sourcemap: dist/ is committed so it can be installed straight from the
// repository, and the map was larger than the bundle it described.
const common = {
  bundle: true, format: 'esm', target: 'es2022',
  logLevel: 'warning',
}

await build({
  ...common,
  entryPoints: ['index.ts'],
  outfile: 'dist/index.js',
  platform: 'browser',
})

// initEngine resolves the module with new URL('./daepl.wasm', import.meta.url),
// so the binary has to sit beside the emitted entry, not under its source path
copyFileSync('src/daepl/wasm/daepl.wasm', 'dist/daepl.wasm')

// Rolled up into one declaration: tsc emits a .d.ts per module, which would
// publish every internal type alongside the public surface.
execFileSync('npx', [
  'dts-bundle-generator', '--no-banner', '--project', 'tsconfig.json',
  '-o', 'dist/index.d.ts', 'index.ts',
], { stdio: 'inherit' })
