const { readFileSync } = require('node:fs')
const { extname } = require('node:path')
const { execFileSync } = require('node:child_process')

const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
const disallowed = [
  ['unredacted credential', /(?:\{\{(?:SECRET|API_KEY)_[^}]+\}\}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ghp_|github_pat_|sk-proj-|sk-live-)[\w-]{16,})/i],
  ['operator contact or address', /(?:\b1[3-9]\d{9}\b|(?:ssh:\/\/|scp\s+)[^\s]+)/i],
  ['private runtime files', /(?:^|[\\/])(?:\.env(?!\.example$)|[^\\/]+\.(?:db|sqlite3?|pem|pfx)(?:$|[.-]))/i],
]
const failures = []
function visit(path) {
  if (disallowed[2][1].test(path)) {
    failures.push(path + ': ' + disallowed[2][0])
    return
  }
  if (/^\.(?:png|mp4|jpg|jpeg|gif|webp|ico)$/i.test(extname(path))) return
  const content = readFileSync(path, 'utf8')
  for (const [label, pattern] of disallowed.slice(0, 2)) {
    if (pattern.test(content)) failures.push(path + ': ' + label)
  }
}
for (const path of new Set(tracked)) {
  try { visit(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else {
  console.log('Export scan passed.')
}
