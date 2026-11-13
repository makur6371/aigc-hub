'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, Table, Typography, App, Button, Space, Segmented, Empty } from 'antd'
import { DashboardOutlined, ReloadOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { StatusTag, type StatusTone } from '@/components/ui/StatusTag'
import { ModelPerfBadge, type ModelPerfBadgeData } from '@/components/admin/ModelPerfBadge'
import { apiFetch } from '@/lib/api-client'

const { Text } = Typography

type PerfItem = {
  id: string
  name: string
  type: string
  /** 模型是否启用：停用的沉底展示，方便回看它之前的表现 */
  isActive: boolean
  provider: string
  calls: number
  successRate: number | null
  avgLatencyMs: number
  /** 延迟是否来自实测（false = 按调用间隔估算，仅供参考） */
  latencyMeasured: boolean
  avgTps: number
  recentSuccessSeries: Array<{ ts: number; success_rate: number; calls?: number; ok?: number }>
}

const typeLabels: Record<string, string> = {
  TEXT: '语言', VISION: '读图', IMAGE: '生图', VIDEO: '视频', AUDIO: '音频',
}
const typeTones: Record<string, StatusTone> = {
  TEXT: 'primary', VISION: 'success', IMAGE: 'accent', VIDEO: 'warning', AUDIO: 'gold',
}

/** 模型状态监测：过去 N 小时的成功率/延迟/吞吐 */
export function ModelPerfPanel() {
  const { message } = App.useApp()
  const [items, setItems] = useState<PerfItem[]>([])
  const [loading, setLoading] = useState(false)
  const [hours, setHours] = useState(24)

  const load = useCallback(async (h: number) => {
    setLoading(true)
    try {
      const res = await apiFetch<{ hours: number; items: PerfItem[] }>(`/api/admin/model-perf?hours=${h}`)
      if (res.success && res.data) setItems(res.data.items)
      else message.error(res.message || '加载失败')
    } catch { message.error('加载失败') }
    finally { setLoading(false) }
  }, [message])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(hours), 0)
    return () => window.clearTimeout(timer)
  }, [load, hours])

  const columns: ColumnsType<PerfItem> = [
    {
      title: '模型', width: 190,
      render: (_, r) => (
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <Text className="text-sm font-medium">{r.name}</Text>
            {!r.isActive && <StatusTag tone="warning">已停用</StatusTag>}
          </div>
          <Text type="secondary" className="text-[11px]">{r.provider}</Text>
        </div>
      ),
    },
    {
      title: '类型', dataIndex: 'type', width: 76,
      render: (t: string) => <StatusTag tone={typeTones[t] || 'primary'}>{typeLabels[t] || t}</StatusTag>,
    },
    {
      title: '调用数', dataIndex: 'calls', width: 86, align: 'right',
      render: (n: number) => <Text className="font-mono text-xs">{n}</Text>,
    },
    {
      title: `性能（过去 ${hours} 小时）`, minWidth: 320,
      render: (_, r) => (
        <ModelPerfBadge
          perf={{
            avgLatencyMs: r.avgLatencyMs,
            successRate: r.successRate,
            avgTps: r.avgTps,
            recentSuccessSeries: r.recentSuccessSeries,
            hours,
          } satisfies ModelPerfBadgeData}
        />
      ),
    },
  ]

  const withData = items.filter((i) => i.calls > 0).length
  // 有调用的模型排前面（其次按调用数降序），否则 30 个模型里找有数据的要翻页
  const sorted = [...items].sort((a, b) => b.calls - a.calls)

  return (
    <Card
      variant="outlined"
      title={<><DashboardOutlined className="mr-2" />模型状态监测</>}
      extra={
        <Space>
          <Segmented
            size="small"
            value={hours}
            onChange={(v) => setHours(Number(v))}
            options={[{ value: 6, label: '6h' }, { value: 24, label: '24h' }, { value: 72, label: '72h' }]}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load(hours)} loading={loading}>刷新</Button>
        </Space>
      }
    >
      <Text type="secondary" className="block !text-xs mb-3">
        竖条 = 逐小时请求成功率（绿=高 / 黄=中 / 红=低 / 灰=无数据），最后一格是当前进行中的小时；
        悬停某一格可看该小时的时间、成功率与调用次数。
        进行中的请求不计入成功率样本。延迟优先使用接口响应耗时，缺失时按调用间隔估算；异步视频的提交延迟不等于生成耗时。吞吐 = 每秒处理 token 数。
        （当前 {withData} / {items.length} 个模型有数据）。
      </Text>
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={sorted}
        pagination={false}
        scroll={{ x: 780, y: 520 }}
        locale={{ emptyText: <Empty description="暂无模型" /> }}
      />
    </Card>
  )
}
