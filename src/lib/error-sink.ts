import { appendFile, readFile, rename, mkdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'

/**
 * 轻量错误落盘（计划 3.2 / 台账 Q-D32 的最小可用形态）。
 *
 * 为什么不做 Sentry：单实例 2G 服务器 + 无外部预算，先解决「重启后错误就查不到」
 * 这一最痛的点 —— 运维面板的 recentErrors 来自 api_usage_logs（只有上游调用错误），
 * 路由 500、未捕获异常只进 stdout，容器一重启就没了。
 *
 * 设计约束：
 *   - **绝不改变进程行为**：只在已存在的 catch 分支里附带记录，不注册
 *     uncaughtException/unhandledRejection 监听器（注册会压制 Node 默认崩溃语义）。
 *   - **绝不抛错**：记录失败最多丢一条日志，不能让主链路因监控挂掉。
 *   - **有界**：单文件 2MB，滚动一次（.1），最坏占用 ~4MB。
 *   - 生产通过 docker-compose 指到持久卷 /data/logs，重启/升级后仍可回查。
 */

const MAX_BYTES = 2 * 1024 * 1024

const SINK_FILE = resolve(process.env.ERROR_LOG_DIR || join(process.cwd(), '.runlogs'), 'app-errors.jsonl')

export interface ErrorSinkRecord {
  ts: string
  scope: string
  message: string
  stack?: string
  path?: string
  userId?: string
}

/** 记录一条服务端错误。fire-and-forget，内部吞掉一切异常。 */
export function recordError(rec: ErrorSinkRecord): void {
  void (async () => {
    const dir = dirname(SINK_FILE)
    if (!existsSync(dir)) await mkdir(dir, { recursive: true })
    if (existsSync(SINK_FILE)) {
      const { size } = await stat(SINK_FILE)
      if (size > MAX_BYTES) await rename(SINK_FILE, `${SINK_FILE}.1`)
    }
    await appendFile(SINK_FILE, JSON.stringify(rec) + '\n', 'utf8')
  })().catch(() => { /* 监控不得影响主流程 */ })
}

/** 从 Error/unknown 生成记录（统一截断，避免 stack 撑爆文件）。 */
export function errorRecord(scope: string, err: unknown, extra?: { path?: string; userId?: string }): ErrorSinkRecord {
  const e = err instanceof Error ? err : null
  return {
    ts: new Date().toISOString(),
    scope,
    message: e?.message || String(err).slice(0, 500),
    stack: e?.stack ? e.stack.slice(0, 2000) : undefined,
    ...extra,
  }
}

/** 读最近 limit 条（当前 + 滚动片段），供管理端展示。无文件返回空数组。 */
export async function readRecentErrors(limit = 50): Promise<ErrorSinkRecord[]> {
  const files = [`${SINK_FILE}.1`, SINK_FILE]
  const lines: string[] = []
  for (const f of files) {
    if (!existsSync(f)) continue
    try {
      const text = await readFile(f, 'utf8')
      for (const l of text.split('\n')) if (l.trim()) lines.push(l)
    } catch { /* 读失败按空处理 */ }
  }
  return lines
    .slice(-limit)
    .map((l) => {
      try {
        return JSON.parse(l) as ErrorSinkRecord
      } catch {
        return null
      }
    })
    .filter((x): x is ErrorSinkRecord => x !== null)
}

export const __internals = { SINK_FILE, MAX_BYTES }
