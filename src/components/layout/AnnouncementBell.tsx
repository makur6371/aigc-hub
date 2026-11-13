'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Modal, Tag, Typography, Segmented, Button } from 'antd'
import { BellOutlined } from '@ant-design/icons'
import { Markdown } from '@/components/ui/Markdown'
import { apiFetch } from '@/lib/api-client'
import { readLocalText, writeLocalJson } from '@/lib/local-store'

const { Text } = Typography

/**
 * 全站唯一的铃铛：合并两条互不相同的通道。
 *
 * 它们共用一个入口是合理的（用户心里的模型就是「有没有新消息」），
 * 但读状态模型必须分开，这是分表的根本原因：
 *   - 公告（SystemAnnouncement）= 广播，无收件人行 → 已读只能存 localStorage
 *   - 通知（UserNotification）= 1 对 1，有收件人行 → 已读存服务端 readAt
 * 若强行合并成一份「已读集合」，就会出现「一台已读、另一台红点」或
 * 「公告红点被通知的已读带走」这类自相矛盾。
 */

export type Announcement = {
  id: string
  title: string
  content: string
  type: string
  publishedAt: string | null
  createdAt: string
}

type UserNotice = {
  id: string
  kind: string
  title: string
  content: string
  link: string | null
  read: boolean
  createdAt: string
}

const READ_KEY = 'aigc-hub-announcements-read-v1'

function readSet(): Set<string> {
  try {
    const raw = readLocalText(READ_KEY)
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
  } catch {
    return new Set()
  }
}

/** 自动弹窗打开公告时也记为已读，避免铃铛一直挂红点。 */
export function markAnnouncementRead(id: string): void {
  try {
    const s = readSet()
    s.add(id)
    writeLocalJson(READ_KEY, [...s])
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

function fmtTime(iso: string) {
  try {
    return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

const KIND_META: Record<string, { label: string; color: string }> = {
  team_review: { label: '团队审核', color: 'purple' },
  team_member: { label: '团队成员', color: 'blue' },
  billing: { label: '计费', color: 'gold' },
  system: { label: '系统', color: 'default' },
}

export function AnnouncementPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<string>('notice')
  const [notices, setNotices] = useState<UserNotice[]>([])
  const [announcements, setAnnouncements] = useState<Announcement[]>([])
  const [activeNotice, setActiveNotice] = useState<UserNotice | null>(null)
  const [activeAnnouncement, setActiveAnnouncement] = useState<Announcement | null>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setMounted(true), 0)
    return () => window.clearTimeout(timer)
  }, [])

  const loadNotices = useCallback(async () => {
    const res = await apiFetch<{ unread: number; items: UserNotice[] }>('/api/user/notifications')
    if (res.success && res.data) setNotices(res.data.items)
  }, [])

  useEffect(() => {
    if (!open) return
    void loadNotices()
    apiFetch<Announcement[]>('/api/announcements')
      .then((res) => { if (res.success && Array.isArray(res.data)) setAnnouncements(res.data) })
      .catch(() => {})
  }, [open, loadNotices])

  // 点开面板 = 已读（符合直觉）：通知走服务端、公告走 localStorage
  useEffect(() => {
    if (!open) return
    void apiFetch('/api/user/notifications/read', { method: 'PATCH', body: JSON.stringify({ all: true }) })
    const s = readSet()
    apiFetch<Announcement[]>('/api/announcements')
      .then((res) => {
        if (res.success && Array.isArray(res.data)) {
          res.data.forEach((a) => s.add(a.id))
          writeLocalJson(READ_KEY, [...s])
        }
      })
      .catch(() => {})
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])


  const openNotice = (n: UserNotice) => {
    setActiveNotice(n)
    void apiFetch('/api/user/notifications/read', { method: 'PATCH', body: JSON.stringify({ id: n.id }) })
    setNotices((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)))
  }

  const panel = (
    <>
      {open && (
        <>
          <div className="fixed inset-0 z-[69]" onClick={onClose} />
          <div
            className="fixed left-3 top-1/2 z-[70] w-80 max-w-[calc(100vw-24px)] -translate-y-1/2 rounded-2xl border border-accent-border/60 bg-white/85 shadow-xl backdrop-blur-xl md:left-20"
            style={{ animation: 'canvasPanelIn 0.18s ease' }}
          >
            <div className="flex items-center justify-between border-b border-accent-border/50 px-3 py-2.5">
              <Text strong className="text-sm">消息</Text>
              <button
                type="button" onClick={onClose}
                className="grid h-6 w-6 place-items-center rounded text-[#5b3aa8]/60 hover:bg-black/5"
                title="关闭"
              >✕</button>
            </div>
            <div className="px-3 pt-2.5">
              <Segmented
                block size="small" value={tab} onChange={(v) => setTab(String(v))}
                options={[
                  { label: `通知${notices.some((n) => !n.read) ? ' •' : ''}`, value: 'notice' },
                  { label: '公告', value: 'announcement' },
                ]}
              />
            </div>
            <div className="max-h-[60vh] overflow-y-auto aigc-hub-scrollbar p-3">
              {tab === 'notice' ? (
                notices.length === 0 ? (
                  <div className="px-3 py-10 text-center text-xs text-text-disabled">暂无通知</div>
                ) : (
                  <div className="relative flex flex-col gap-3 pl-1">
                    <span className="absolute left-[7px] top-1 bottom-1 w-px bg-accent-border/60" />
                    {notices.map((n) => {
                      const meta = KIND_META[n.kind] || KIND_META.system
                      return (
                        <div key={n.id} className="relative pl-6">
                          <span className={`absolute left-0 top-1.5 grid h-4 w-4 place-items-center rounded-full border-2 ${n.read ? 'border-accent-border bg-white' : 'border-accent bg-accent-light'}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${n.read ? 'bg-accent-border' : 'bg-accent'}`} />
                          </span>
                          <button
                            type="button" onClick={() => openNotice(n)}
                            className="group block w-full rounded-lg px-1.5 py-1 text-left hover:bg-accent-light/40"
                          >
                            <div className="flex items-center gap-1.5">
                              <Tag className="!mr-0" color={meta.color} style={{ fontSize: 10 }}>{meta.label}</Tag>
                              <Text className={`flex-1 truncate text-xs ${n.read ? 'font-normal text-text-muted' : 'font-semibold text-foreground group-hover:text-accent'}`}>
                                {n.title}
                              </Text>
                            </div>
                            <Text className="mt-0.5 line-clamp-2 block text-[11px] text-text-disabled">{n.content}</Text>
                            <Text className="mt-0.5 block text-[10px] text-text-disabled">{fmtTime(n.createdAt)}</Text>
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )
              ) : (
                announcements.length === 0 ? (
                  <div className="px-3 py-10 text-center text-xs text-text-disabled">暂无公告</div>
                ) : (
                  <div className="relative flex flex-col gap-4 pl-1">
                    <span className="absolute left-[7px] top-1 bottom-1 w-px bg-accent-border/60" />
                    {[...announcements].reverse().map((a) => (
                      <div key={a.id} className="relative pl-6">
                        <span className={`absolute left-0 top-1.5 grid h-4 w-4 place-items-center rounded-full border-2 ${a.type === 'featured' ? 'border-warning-amber bg-warning-light' : 'border-accent bg-white'}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${a.type === 'featured' ? 'bg-warning-deep' : 'bg-accent'}`} />
                        </span>
                        <button
                          type="button" onClick={() => setActiveAnnouncement(a)}
                          className="group block w-full rounded-lg px-1.5 py-1 text-left hover:bg-accent-light/40"
                        >
                          <div className="flex items-center gap-1.5">
                            <Tag className="!mr-0" color={a.type === 'featured' ? 'gold' : 'purple'} style={{ fontSize: 10 }}>
                              {a.type === 'featured' ? '精选' : '常规'}
                            </Tag>
                            <Text className="flex-1 truncate text-xs font-medium text-foreground group-hover:text-accent">{a.title}</Text>
                          </div>
                          <Text className="mt-0.5 block text-[10px] text-text-disabled">{fmtTime(a.publishedAt || a.createdAt)}</Text>
                        </button>
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>
          </div>
        </>
      )}

      <Modal open={!!activeNotice} onCancel={() => setActiveNotice(null)} footer={null} title={activeNotice?.title} width={560}>
        {activeNotice && (
          <div>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-muted">{activeNotice.content}</p>
            {activeNotice.link && (
              <Button type="primary" className="mt-4" href={activeNotice.link}>前往查看</Button>
            )}
          </div>
        )}
      </Modal>

      <Modal open={!!activeAnnouncement} onCancel={() => setActiveAnnouncement(null)} footer={null} title={activeAnnouncement?.title} width={560}>
        {activeAnnouncement && (
          <div className="max-h-[72vh] overflow-y-auto pr-1 aigc-hub-scrollbar">
            <Markdown size="base" className="markdown-content text-text-muted">{activeAnnouncement.content}</Markdown>
          </div>
        )}
      </Modal>
    </>
  )

  if (!mounted) return null
  return createPortal(panel, document.body)
}

/** 桌面导航铃铛：未读红点 = 未读通知 + 未读公告 */
export function AnnouncementBell() {
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    const load = async () => {
      let count = 0
      const nr = await apiFetch<{ unread: number }>('/api/user/notifications')
      if (nr.success && nr.data) count += nr.data.unread
      const ar = await apiFetch<Announcement[]>('/api/announcements')
      if (ar.success && Array.isArray(ar.data)) {
        const read = readSet()
        count += ar.data.filter((a) => !read.has(a.id)).length
      }
      setUnread(count)
    }
    void load()
  }, [open])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="消息"
        onPointerDown={(e) => e.stopPropagation()}
        className="relative flex h-8 w-8 items-center justify-center rounded-full text-[#5b3aa8]/70 transition-colors hover:bg-white/60 hover:text-accent"
      >
        <BellOutlined className="text-base" />
        {unread > 0 && (
          <span className="absolute right-0.5 top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[9px] font-bold text-white shadow-sm">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      <AnnouncementPanel open={open} onClose={() => setOpen(false)} />
    </>
  )
}
