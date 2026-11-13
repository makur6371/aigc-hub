import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  loadDismissedUrls,
  rememberDismissedUrls,
  DISMISSED_LS_KEY,
  loadPersistedResults,
  RESULTS_LS_KEY,
  mergeRecoveredResults,
  resultUrlKey,
  type ResultItem,
} from '@/stores/useToolRunStore'

// 「删除后刷新又出现」的回归网。
//
// 根因：成果区有两个恢复源 —— 本地快照(localStorage) 与 服务端 CanvasRun 认领。
// 删除只改了本地列表，服务端那条 run 的产出还在，刷新时认领逻辑把它又插了回来。
// 修法是在**展示层**记一份删除名单，两条恢复路径都过它。这里锁住这份名单的语义。

/** 最小 localStorage 桩：node 环境没有 DOM，测试自己造一个 */
function installLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const ls = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size },
  }
  ;(globalThis as unknown as { window: unknown }).window = globalThis
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = ls
  return store
}

describe('成果区「已删除名单」—— 修「删除后刷新又出现」', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
    delete (globalThis as { localStorage?: unknown }).localStorage
  })

  it('无记录时返回空集合（且不抛）', () => {
    installLocalStorage()
    expect(loadDismissedUrls().size).toBe(0)
  })

  it('记住一批 url 后能读回来（幂等，不重复）', () => {
    installLocalStorage()
    rememberDismissedUrls(['a.png', 'b.png'])
    rememberDismissedUrls(['b.png', 'c.png'])
    const set = loadDismissedUrls()
    expect([...set].sort()).toEqual(['/a.png', '/b.png', '/c.png'])
  })

  it('脏数据/非数组/非字符串都能安全退化，不阻断恢复', () => {
    installLocalStorage({ [DISMISSED_LS_KEY]: '{not json' })
    expect(loadDismissedUrls().size).toBe(0)
    installLocalStorage({ [DISMISSED_LS_KEY]: JSON.stringify([1, null, 'ok.png', {}]) })
    expect([...loadDismissedUrls()]).toEqual(['/ok.png'])
    installLocalStorage({ [DISMISSED_LS_KEY]: JSON.stringify({ a: 1 }) })
    expect(loadDismissedUrls().size).toBe(0)
  })

  it('本地快照恢复时，被删掉的图不会复活', () => {
    // 快照里有两张，其中一张已被用户删除
    installLocalStorage({
      [RESULTS_LS_KEY]: JSON.stringify([
        { url: 'keep.png', kind: 'image', nodeId: 'n1', status: 'done' },
        { url: 'deleted.png', kind: 'image', nodeId: 'n2', status: 'done' },
      ]),
      [DISMISSED_LS_KEY]: JSON.stringify(['deleted.png']),
    })
    const restored = loadPersistedResults()
    expect(restored.map((r) => r.url)).toEqual(['keep.png'])
  })

  it('超出上限时 FIFO 淘汰最旧的（旧到被挤掉的图不再恢复）', () => {
    installLocalStorage()
    const many = Array.from({ length: 320 }, (_, i) => `img-${String(i).padStart(3, '0')}.png`)
    rememberDismissedUrls(many)
    const set = loadDismissedUrls()
    expect(set.size).toBe(300)
    // 最早 20 个被淘汰，最后的还在
    expect(set.has(resultUrlKey('img-000.png'))).toBe(false)
    expect(set.has(resultUrlKey('img-319.png'))).toBe(true)
  })

  it('代理地址、带重试参数的地址与上游原图视为同一张图', () => {
    const remote = 'https://cdn.example.com/a.png?token=1'
    expect(resultUrlKey('/api/asset-proxy?u=' + encodeURIComponent(remote)))
      .toBe(resultUrlKey(remote))
    expect(resultUrlKey(remote + '&_r=2')).toBe(resultUrlKey(remote))
  })

  it('服务端恢复结果必须过滤已删除项，并对同一 URL 去重', () => {
    installLocalStorage()
    const remote = 'https://cdn.example.com/a.png'
    const item = (url: string): ResultItem => ({
      url,
      kind: 'image',
      nodeId: 'n1',
      status: 'done',
    })
    const prev = [item(remote)]
    const recovered = [
      item('/api/asset-proxy?u=' + encodeURIComponent(remote)),
      item('https://cdn.example.com/deleted.png'),
      item('https://cdn.example.com/new.png'),
    ]
    const merged = mergeRecoveredResults(
      prev,
      recovered,
      new Set([resultUrlKey('https://cdn.example.com/deleted.png')]),
    )
    expect(merged.map((r) => r.url)).toEqual(['https://cdn.example.com/new.png', remote])
  })

  it('CanvasRun 与 Agent task 两条恢复链共用同一合并入口', async () => {
    const { readSource } = await import('./helpers/source-guard')
    expect(readSource('src/components/tools/ToolStudio.tsx')).toContain('useResultRecovery()')
    const recovery = readSource('src/components/tools/useResultRecovery.ts')
    expect(recovery).toContain('mergeRecoveredResults(')
    expect(recovery).toContain('claimedRunId: task.id')
    expect(readSource('src/app/api/results/recovery/route.ts')).toContain('`agent:${task.id}`')
  })
})
