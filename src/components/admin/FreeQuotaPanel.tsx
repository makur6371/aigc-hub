'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, Table, InputNumber, Button, Typography, App, Tooltip, Space, Popconfirm } from 'antd'
import { GiftOutlined, ReloadOutlined, ClearOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { StatusTag, type StatusTone } from '@/components/ui/StatusTag'
import { apiFetch } from '@/lib/api-client'

const { Text, Paragraph } = Typography

type QuotaItem = {
  id: string
  name: string
  type: string
  provider: string
  isFree: boolean
  costPoints: number
  dailyUserFreeQuota: number | null
  dailyPlatformFreeQuota: number | null
  platformUsedToday: number
  platformRemainingToday: number | null
  enabled: boolean
}

const typeLabels: Record<string, string> = {
  TEXT: '语言', VISION: '读图', IMAGE: '生图', VIDEO: '视频', AUDIO: '音频',
}
const typeTones: Record<string, StatusTone> = {
  TEXT: 'primary', VISION: 'success', IMAGE: 'accent', VIDEO: 'warning', AUDIO: 'gold',
}

/**
 * 每日免费额度池：集中配置「哪个模型每天免费多少次」。
 * 两级额度同时生效，任一耗尽即按正常价计费，每日 0 点自动重置。
 */
export function FreeQuotaPanel() {
  const { message } = App.useApp()
  const [items, setItems] = useState<QuotaItem[]>([])
  const [loading, setLoading] = useState(false)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [day, setDay] = useState('')
  // 本地编辑缓冲：{ [modelId]: { user, platform } }
  const [draft, setDraft] = useState<Record<string, { user: number | null; platform: number | null }>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch<{ day: string; items: QuotaItem[] }>('/api/admin/free-quota')
      if (res.success && res.data) {
        setItems(res.data.items)
        setDay(res.data.day)
        setDraft({})
      } else {
        message.error(res.message || '加载失败')
      }
    } catch { message.error('加载失败') }
    finally { setLoading(false) }
  }, [message])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const valueOf = (r: QuotaItem) => draft[r.id] ?? { user: r.dailyUserFreeQuota, platform: r.dailyPlatformFreeQuota }

  const save = async (r: QuotaItem) => {
    const v = valueOf(r)
    setSavingId(r.id)
    try {
      const res = await apiFetch('/api/admin/free-quota', {
        method: 'PUT',
        body: JSON.stringify({ id: r.id, dailyUserFreeQuota: v.user, dailyPlatformFreeQuota: v.platform }),
      })
      if (res.success) {
        message.success(`「${r.name}」额度已保存`)
        await load()
      } else message.error(res.message)
    } catch { message.error('保存失败') }
    finally { setSavingId(null) }
  }

  const clearToday = async (modelId?: string) => {
    try {
      const res = await apiFetch<{ cleared: number }>(
        `/api/admin/free-quota${modelId ? `?modelId=${encodeURIComponent(modelId)}` : ''}`,
        { method: 'DELETE' },
      )
      if (res.success) {
        message.success(res.message || '已清零')
        await load()
      } else message.error(res.message)
    } catch { message.error('清零失败') }
  }

  const columns: ColumnsType<QuotaItem> = [
    {
      title: '模型', width: 200,
      render: (_, r) => (
        <div className="flex flex-col gap-0.5">
          <Text className="text-sm font-medium">{r.name}</Text>
          <Text type="secondary" className="text-[11px]">{r.provider}</Text>
        </div>
      ),
    },
    {
      title: '类型', dataIndex: 'type', width: 80,
      render: (t: string) => <StatusTag tone={typeTones[t] || 'primary'}>{typeLabels[t] || t}</StatusTag>,
    },
    {
      title: '每用户每天', width: 150,
      render: (_, r) => (
        <InputNumber
          min={0} max={100000} className="w-full" placeholder="关闭"
          value={valueOf(r).user ?? undefined}
          onChange={(v) => setDraft((p) => ({ ...p, [r.id]: { ...valueOf(r), user: v ?? null } }))}
        />
      ),
    },
    {
      title: '全平台每天上限', width: 170,
      render: (_, r) => (
        <InputNumber
          min={0} max={1000000} className="w-full" placeholder="不限"
          value={valueOf(r).platform ?? undefined}
          onChange={(v) => setDraft((p) => ({ ...p, [r.id]: { ...valueOf(r), platform: v ?? null } }))}
        />
      ),
    },
    {
      title: '今日用量', width: 150,
      render: (_, r) => {
        if (!r.enabled) return <Text type="secondary" className="text-xs">未开启</Text>
        const limit = r.dailyPlatformFreeQuota
        if (!limit) return <Text className="text-xs">已用 {r.platformUsedToday}（平台不限）</Text>
        const pct = Math.min(100, Math.round((r.platformUsedToday / limit) * 100))
        return (
          <Tooltip title={`平台今日已用 ${r.platformUsedToday} / ${limit}`}>
            <div className="flex flex-col gap-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/8">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.max(pct, 2)}%`,
                    background: pct >= 90 ? 'var(--danger, #ff4d4f)' : pct >= 60 ? 'var(--warning-amber, #faad14)' : 'var(--accent, #7d50e0)',
                  }}
                />
              </div>
              <Text className="text-[11px]">剩 {r.platformRemainingToday} / {limit}</Text>
            </div>
          </Tooltip>
        )
      },
    },
    {
      title: '操作', width: 150, fixed: 'right',
      render: (_, r) => (
        <Space size="small">
          <Button type="link" size="small" loading={savingId === r.id} onClick={() => void save(r)}>保存</Button>
          {r.platformUsedToday > 0 && (
            <Popconfirm title="清零该模型今日用量？" onConfirm={() => void clearToday(r.id)}>
              <Button type="link" size="small" icon={<ClearOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  const enabledCount = items.filter((i) => i.enabled).length
  // 已开启额度的排前面，方便一眼看到当前生效的配置
  const sorted = [...items].sort((a, b) => Number(b.enabled) - Number(a.enabled))

  return (
    <Card
      variant="outlined"
      title={<><GiftOutlined className="mr-2" />每日免费额度池</>}
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>刷新</Button>
          <Popconfirm title="清零所有模型今日用量？" onConfirm={() => void clearToday()} disabled={!items.some((i) => i.platformUsedToday > 0)}>
            <Button danger icon={<ClearOutlined />} disabled={!items.some((i) => i.platformUsedToday > 0)}>清零今日</Button>
          </Popconfirm>
        </Space>
      }
    >
      <Paragraph type="secondary" className="!text-xs !mb-3">
        给指定模型配「每天免费多少次」。<b>两级额度同时生效</b>：任一耗尽即按正常价计费。
        <b>每日 0 点自动重置</b>（今日：{day || '—'}）。留空或 0 = 不参与免费额度。
        当前有 <Text strong>{enabledCount}</Text> 个模型开启了免费额度。
      </Paragraph>
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={sorted}
        pagination={false}
        scroll={{ x: 900, y: 520 }}
      />
    </Card>
  )
}
