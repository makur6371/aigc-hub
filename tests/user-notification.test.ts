import { describe, it, expect } from 'vitest'

/**
 * 站内通知的「读状态归属」不变量（纯函数层表达）。
 *
 * 为什么值得锁：通知与公告最大的区别是「读状态存哪里」。
 *   公告 = 广播，无收件人行 → 只能 localStorage
 *   通知 = 1 对 1，有收件人行 → 必须服务端 readAt
 * 若有人图省事把通知也塞进公告那套 localStorage 已读集合，
 * 就会出现「换台设备红点又冒出来」——用户会以为收到了新消息。
 * 这里用一个最小的可见性判定把语义钉住，防止回归。
 */

/** 通知是否算「未读」——readAt 为空即未读，与客户端无关（服务端权威） */
function isNoticeUnread(readAt: string | null | undefined): boolean {
  return !readAt
}

/** 未读红点总数 = 未读通知 + 未读公告（两条通道合并计数） */
function totalUnread(unreadNotices: number, unreadAnnouncements: number): number {
  return Math.max(0, unreadNotices) + Math.max(0, unreadAnnouncements)
}

describe('站内通知 —— 读状态语义', () => {
  it('readAt 为空 = 未读（服务端权威，不依赖本地）', () => {
    expect(isNoticeUnread(null)).toBe(true)
    expect(isNoticeUnread(undefined)).toBe(true)
  })

  it('readAt 有值 = 已读（换设备登录也保持已读）', () => {
    expect(isNoticeUnread('2026-10-06T00:00:00.000Z')).toBe(false)
  })

  it('红点 = 通知未读 + 公告未读（两条通道都要算）', () => {
    expect(totalUnread(2, 3)).toBe(5)
    expect(totalUnread(0, 1)).toBe(1)
    expect(totalUnread(4, 0)).toBe(4)
    expect(totalUnread(0, 0)).toBe(0)
  })
})
