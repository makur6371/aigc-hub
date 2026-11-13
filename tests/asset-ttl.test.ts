import { describe, it, expect } from 'vitest'
import { ASSET_TTL_SECONDS, expiresAtFor } from '@/lib/asset-store'

// 为什么测这个：expiresAtFor 对「表里没有的来源」返回 null = 永久保留。
// 历史泄漏（Q-811）：node-bodies.tsx 三处上传写 source='canvas' / 'canvas-audio'，
// 但两者都不在表里 → 画布临时上传被永久保留、清理任务永远不回收。
// 这些用例把「凡是被写入的临时来源都必须在表里」钉死。

const TEMPORARY_SOURCES = ['tool', 'canvas-upload', 'canvas', 'canvas-audio', 'tool-drag', 'workbench']
const PERMANENT_SOURCES = ['upload', 'generated', 'workflow']

describe('ASSET_TTL_SECONDS —— 临时来源必须配过期时间', () => {
  it.each(TEMPORARY_SOURCES)('%s 有过期时间（不是永久保留）', (source) => {
    expect(ASSET_TTL_SECONDS[source]).toBeTypeOf('number')
    const at = expiresAtFor(source)
    expect(at).not.toBeNull()
    expect(at!.getTime()).toBeGreaterThan(Date.now())
  })

  it('画布内联上传与画布上传节点同口径（2 小时）', () => {
    expect(ASSET_TTL_SECONDS['canvas']).toBe(ASSET_TTL_SECONDS['canvas-upload'])
    expect(ASSET_TTL_SECONDS['canvas-audio']).toBe(ASSET_TTL_SECONDS['canvas-upload'])
  })
})

describe('ASSET_TTL_SECONDS —— 用户长期资产不过期', () => {
  it.each(PERMANENT_SOURCES)('%s 永久保留', (source) => {
    expect(expiresAtFor(source)).toBeNull()
  })

  it('未知来源保守视为永久（不会误删用户文件）', () => {
    expect(expiresAtFor('some-future-source')).toBeNull()
    expect(expiresAtFor(undefined)).toBeNull()
  })
})
