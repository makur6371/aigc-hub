const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')

if (process.loadEnvFile) {
  try { process.loadEnvFile() } catch (error) { if (error.code !== 'ENOENT') throw error }
}
function run(entry, args) {
  const result = spawnSync(process.execPath, [resolve(entry), ...args], { stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
if (process.env.JWT_SECRET?.length < 32 || !process.env.JWT_SECRET) {
  console.error('Set JWT_SECRET to a random value of at least 32 characters before setup.')
  process.exit(1)
}
run('node_modules/prisma/build/index.js', ['db', 'push'])
run('node_modules/prisma/build/index.js', ['generate'])
run('node_modules/tsx/dist/cli.mjs', ['scripts/bootstrap.ts', ...process.argv.slice(2)])
