import { build } from 'esbuild'
import { copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(root, 'out', 'glass-preview')

await build({
  absWorkingDir: root,
  entryPoints: ['scripts/glass-preview/main.tsx'],
  outdir: outDir,
  bundle: true,
  minify: true,
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'linked',
})
await Promise.all([
  copyFile(join(root, 'scripts/glass-preview/index.html'), join(outDir, 'index.html')),
  copyFile(join(root, 'public/logo.svg'), join(outDir, 'logo.svg')),
  copyFile(join(root, 'LICENSE'), join(outDir, 'LICENSE')),
  copyFile(join(root, 'NOTICE'), join(outDir, 'NOTICE')),
])
console.log('WebGL preview built in out/glass-preview')
