import { describe, expect, it } from 'vitest'
import {
  MEDIA_RECORD_STATUS,
  CANVAS_RUN_STATUS,
  GENERATION_TASK_STATUS,
  CHAT_MESSAGE_STATUS,
  RECHARGE_ORDER_STATUS,
  BILLING_HOLD_STATUS,
  REVIEW_STATUS,
} from '@/lib/status-vocab'
import { readSource } from './helpers/source-guard'

describe('状态词汇表（Q-D46）', () => {
  it('各分组与 schema 注释声明词汇一致（不许漂移）', () => {
    expect(Object.values(MEDIA_RECORD_STATUS).sort()).toEqual(['FAILED', 'PENDING', 'SUCCESS'])
    expect(Object.values(CANVAS_RUN_STATUS).sort()).toEqual(['CANCELLED', 'FAILED', 'PAUSED', 'PENDING', 'RUNNING', 'SUCCEEDED'])
    expect(Object.values(GENERATION_TASK_STATUS).sort()).toEqual(['CANCELLED', 'FAILED', 'PAUSED', 'PENDING', 'RUNNING', 'SUCCEEDED'])
    expect(Object.values(CHAT_MESSAGE_STATUS).sort()).toEqual(['DONE', 'FAILED', 'STREAMING'])
    expect(Object.values(RECHARGE_ORDER_STATUS).sort()).toEqual(['CLOSED', 'PAID', 'PENDING'])
    expect(Object.values(BILLING_HOLD_STATUS).sort()).toEqual(['OPEN', 'SETTLED'])
    expect(Object.values(REVIEW_STATUS).sort()).toEqual(['APPROVED', 'PENDING', 'REJECTED'])
  })

  it('值全大写、键值一致（防止手滑写成小写或错键）', () => {
    for (const group of [MEDIA_RECORD_STATUS, CANVAS_RUN_STATUS, GENERATION_TASK_STATUS, CHAT_MESSAGE_STATUS, RECHARGE_ORDER_STATUS, BILLING_HOLD_STATUS, REVIEW_STATUS]) {
      for (const [key, value] of Object.entries(group)) {
        expect(key).toBe(value)
        expect(value).toMatch(/^[A-Z]+$/)
      }
    }
  })

  it('词汇表必须真实接入核心写入点（防「建了没人用」）', () => {
    const imageRoute = readSource('src/app/api/image/generate/route.ts')
    expect(imageRoute).toMatch(/MEDIA_RECORD_STATUS\.SUCCESS/)
    expect(imageRoute).toMatch(/MEDIA_RECORD_STATUS\.FAILED/)
    const maint = readSource('src/lib/maintenance.ts')
    expect(maint).toMatch(/CANVAS_RUN_STATUS\.SUCCEEDED/)
    expect(maint).toMatch(/GENERATION_TASK_STATUS\.RUNNING/)
  })

  it('schema 侧词汇与常量层一致（防两边各自漂移）', () => {
    const schema = readSource('prisma/schema.prisma')
    // 三张媒体记录表的 default + 注释清单是词汇在 schema 侧的落点
    for (const v of ['PENDING', 'SUCCESS', 'FAILED']) expect(schema).toContain(`PENDING, SUCCESS, FAILED`)
    expect(schema).toContain(`@default("${MEDIA_RECORD_STATUS.SUCCESS}")`)
    expect(schema).toContain(`@default("${MEDIA_RECORD_STATUS.PENDING}")`)
    for (const v of Object.values(CANVAS_RUN_STATUS)) expect(schema).toContain(v)
    expect(schema).toContain(`@default("${CHAT_MESSAGE_STATUS.DONE}")`)
    expect(schema).toContain('STREAMING / DONE / FAILED')
  })
})
