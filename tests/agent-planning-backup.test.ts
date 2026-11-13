import { describe, it, expect } from 'vitest'
import { parseBackupIds } from '@/lib/agent-config'

/**
 * Agent 规划替补链的 Json 列解析 —— 容错各种脏值。
 * 这条链决定「主模型挂了之后先试谁」，解析错会让降级顺序乱掉或重复试同一个模型。
 */
describe('parseBackupIds', () => {
  it('正常数组：保序、去重', () => {
    expect(parseBackupIds(['a', 'b', 'a', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('非数组 / null / undefined → 空数组（不是崩溃）', () => {
    expect(parseBackupIds(null)).toEqual([])
    expect(parseBackupIds(undefined)).toEqual([])
    expect(parseBackupIds('a,b')).toEqual([])
    expect(parseBackupIds({ a: 1 })).toEqual([])
  })

  it('剔除非字符串与空串，不污染链', () => {
    expect(parseBackupIds(['a', 1, '', null, 'b'])).toEqual(['a', 'b'])
  })
})
