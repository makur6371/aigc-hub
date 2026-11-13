'use client'

import { useCallback, useEffect, useState } from 'react'
import { Drawer, Empty, Tag, Typography } from 'antd'
import dayjs from 'dayjs'
import { apiFetch } from '@/lib/api-client'
import { formatPoints } from '@/lib/pricing'

const { Text } = Typography

export type UserLedgerKind = 'points' | 'beans'
type LedgerScope = 'all' | 'real' | 'node'

export interface UserLedgerUser {
  id: string
  nickname: string | null
  phone: string
  points: number
  beans: number
}

interface LedgerPayload {
  kind: UserLedgerKind
  user: UserLedgerUser
  summary: {
    balance: number
    realTotal: number
    nodeTotal: number
    balanceVsRealGap: number
    byType: Array<{ type: string; category: string | null; count: number; total: number }>
  }
  items: Array<{
    id: string
    amount: number
    type: string
    category: string | null
    description: string | null
    createdAt: string
    runId: string | null
    modelNames: string[]
    taskLabel: string | null
    spenderName: string | null
    payerName: string | null
  }>
  total: number
}

export function UserLedgerDrawer({ kind, user, open, onClose }: {
  kind: UserLedgerKind
  user: UserLedgerUser | null
  open: boolean
  onClose: () => void
}) {
  const [scope, setScope] = useState<LedgerScope>('all')
  const [data, setData] = useState<LedgerPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const isPoints = kind === 'points'
  const label = isPoints ? '积分' : '视频豆'

  const load = useCallback(async (nextScope: LedgerScope) => {
    if (!user) return
    setLoading(true)
    try {
      const endpoint = isPoints ? 'points-logs' : 'beans-logs'
      const res = await apiFetch<LedgerPayload>(`/api/admin/users/${user.id}/${endpoint}?pageSize=100&scope=${nextScope}`)
      setData(res.success && res.data ? res.data : null)
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [isPoints, user])

  useEffect(() => {
    if (!open || !user) return
    const timer = window.setTimeout(() => { void load(scope) }, 0)
    return () => window.clearTimeout(timer)
  }, [open, user, kind, scope, load])

  const changeScope = (next: LedgerScope) => {
    setScope(next)
  }

  const balanceColor = isPoints ? 'text-accent' : 'text-amber-700'

  return (
    <Drawer
      title={`${label}账本 · ${user?.nickname || user?.phone || ''}`}
      open={open}
      onClose={onClose}
      width="min(820px, 100vw)"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Tag.CheckableTag checked={scope === 'all'} onChange={() => changeScope('all')}>全部</Tag.CheckableTag>
        <Tag.CheckableTag checked={scope === 'real'} onChange={() => changeScope('real')}>真实变动</Tag.CheckableTag>
        <Tag.CheckableTag checked={scope === 'node'} onChange={() => changeScope('node')}>节点消耗</Tag.CheckableTag>
        <Text type="secondary" className="text-[11px]">{label}账本含充值、奖励、调账、退款和真实扣费；节点记账单独标记。</Text>
      </div>

      {data && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-lg border border-border bg-surface-secondary px-3 py-2">
            <Text type="secondary" className="block text-[11px]">账上余额</Text>
            <Text strong className={`font-mono ${balanceColor}`}>{formatPoints(data.summary.balance)}</Text>
          </div>
          <div className="rounded-lg border border-border bg-surface-secondary px-3 py-2">
            <Text type="secondary" className="block text-[11px]">真实流水</Text>
            <Text strong className="font-mono">{formatPoints(data.summary.realTotal)}</Text>
          </div>
          <div className="rounded-lg border border-border bg-surface-secondary px-3 py-2">
            <Text type="secondary" className="block text-[11px]">节点消耗</Text>
            <Text strong className="font-mono">{formatPoints(data.summary.nodeTotal)}</Text>
          </div>
          <div className="rounded-lg border border-border bg-surface-secondary px-3 py-2">
            <Text type="secondary" className="block text-[11px]">账实差额</Text>
            {Math.abs(data.summary.balanceVsRealGap) < 0.01
              ? <Text strong className="text-success">对平</Text>
              : <Text strong className="text-danger">{formatPoints(data.summary.balanceVsRealGap)}</Text>}
          </div>
        </div>
      )}

      {loading ? (
        <Text type="secondary">加载中…</Text>
      ) : !data || data.items.length === 0 ? (
        <Empty description={`暂无${label}流水`} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <div className="space-y-2">
          {data.items.map((item) => (
            <div key={item.id} className="rounded-lg border border-black/6 px-3 py-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px]">{item.description || item.type}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-secondary">
                    <span>{dayjs(item.createdAt).format('MM-DD HH:mm:ss')}</span>
                    <span>{item.type}</span>
                    {item.category === 'canvas-node' && <Tag color="gold" className="text-[10px]">节点记账</Tag>}
                    {item.modelNames.length > 0 && <span>模型 {item.modelNames.join('、')}</span>}
                    {item.taskLabel && <span>任务 {item.taskLabel}</span>}
                    {item.spenderName && <span>使用者 {item.spenderName}</span>}
                    {item.payerName && <span>出资 {item.payerName}</span>}
                    {item.runId && <Text type="secondary" className="text-[10px]">run {item.runId.slice(0, 10)}…</Text>}
                  </div>
                </div>
                <Text strong className={item.amount >= 0 ? 'font-mono text-xs text-success' : 'font-mono text-xs text-danger'}>
                  {item.amount >= 0 ? '+' : ''}{formatPoints(item.amount)}
                </Text>
              </div>
            </div>
          ))}
        </div>
      )}
    </Drawer>
  )
}
