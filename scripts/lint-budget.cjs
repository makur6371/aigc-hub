const fs = require('fs')
const path = require('path')

const BUDGET_FILE = path.join(__dirname, 'lint-budget.json')
const ROOT = path.resolve(__dirname, '..')

/**
 * 走 ESLint 的程序化 API，而不是 spawn `npx eslint`：
 * Windows 下 `npx` 其实是 `npx.cmd`，`execFileSync` 不带 shell 会直接 ENOENT
 * （本脚本第一版就在这里挂掉）。用 API 也省掉一次冷启动。
 */
async function runEslint() {
  const { ESLint } = require('eslint')
  const eslint = new ESLint({ cwd: ROOT })
  return eslint.lintFiles(['.'])
}

/** 把 eslint 的相对路径归一成 posix 风格，跨机器/跨平台都稳定。 */
function relKey(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join('/')
}

async function collect() {
  const results = await runEslint()
  const counts = new Map()
  const fatal = []
  let errors = 0
  for (const f of results) {
    for (const m of f.messages || []) {
      if (m.severity !== 2) continue
      errors++
      const text = String(m.message || '')
      if (!m.ruleId || /Definition for rule|Parsing error/.test(text)) {
        fatal.push(`${relKey(f.filePath)}:${m.line} ${text.slice(0, 100)}`)
        continue
      }
      const key = `${relKey(f.filePath)} :: ${m.ruleId}`
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  }
  return { counts, fatal, errors }
}

async function main() {
  const { counts, fatal, errors } = await collect()
  const budget = fs.existsSync(BUDGET_FILE)
    ? JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'))
    : {}

  if (fatal.length) {
    console.error('✖ lint 工具本身失效（这类问题不适用预算，必须当场修）：')
    for (const f of fatal) console.error('   ' + f)
    process.exit(1)
  }

  const over = []
  for (const [key, n] of counts) if (n > (budget[key] || 0)) over.push([key, budget[key] || 0, n])

  if (over.length) {
    console.error(`✖ 超出 lint 预算（棘轮只允许变少，不允许变多）：新增 ${over.length} 项`)
    for (const [key, allowed, got] of over) console.error(`   ${key}\n      预算 ${allowed} 条，实际 ${got} 条`)
    console.error('\n   正确做法是改掉它，不是把它加进 scripts/audit/lint-budget.json。')
    console.error('   确实要留（例如需要浏览器目视才能改的渲染时序问题）才跑：npm run check:lint-budget --update')
    process.exit(1)
  }

  const totalBudget = Object.values(budget).reduce((a, b) => a + b, 0)
  if (errors < totalBudget) {
    console.log(`✔ 通过，且已还掉 ${totalBudget - errors} 条（预算 ${totalBudget} → 实际 ${errors}）。`)
    console.log('  记得收紧预算，否则额度会被人白占：npm run check:lint-budget --update')
  } else {
    console.log(`✔ 通过：${errors} 条 error，均在预算内。`)
  }
}

async function updateBudget() {
  const { counts, fatal } = await collect()
  if (fatal.length) {
    console.error('✖ 存在 lint 工具级故障，先修它们再写预算：\n   ' + fatal.join('\n   '))
    process.exit(1)
  }
  const obj = Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)))
  fs.writeFileSync(BUDGET_FILE, JSON.stringify(obj, null, 2) + '\n')
  const total = Object.values(obj).reduce((a, b) => a + b, 0)
  console.log(`已写入预算：${Object.keys(obj).length} 个文件-规则组合，共 ${total} 条`)
}

const runner = process.argv.includes('--update') ? updateBudget() : main()
runner.catch((err) => {
  console.error('lint 运行失败：', err && err.message)
  process.exit(1)
})
