// Source files import siblings as './x.js' (the TypeScript convention). Node's
// type stripping resolves that literally and fails, so modules under test are
// bundled with esbuild first — the same resolver the real build uses.
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const OUT = mkdtempSync(path.join(tmpdir(), 'daepdf-tests-'))
const cache = new Map()

export async function load(rel) {
  if (cache.has(rel)) return cache.get(rel)
  const r = await build({
    entryPoints: [path.join(ROOT, rel)],
    bundle: true, write: false, format: 'esm', target: 'es2022', platform: 'neutral',
    external: ['node:*'],
  })
  const file = path.join(OUT, rel.replace(/[/.]/g, '_') + '.mjs')
  writeFileSync(file, r.outputFiles[0].text)
  const mod = await import(pathToFileURL(file).href)
  cache.set(rel, mod)
  return mod
}
