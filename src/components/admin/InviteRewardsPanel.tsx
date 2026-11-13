'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Card, Table, Button, Typography, App, Space, Segmented, Popconfirm,
  Form, InputNumber, Switch, Divider, Statistic,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { SaveOutlined, GiftOutlined, TeamOutlined } from '@ant-design/icons'
import { StatusTag, type StatusTone } from '@/components/ui/StatusTag'
import { apiFetch } from '@/lib/api-client'
import dayjs from 'dayjs'

const { Text } = Typography

type RewardItem = {
  id: string
  inviterName: string
  inviteeName: string
  paidAmountCents: number
  rewardPoints: number
  usagePercent: number
  requiredUsagePercent: number
  status: string
  paidAt: string | null
  createdAt: string
}

type PolicyShape = {
  enabled: boolean
  rewardPercent: number
  requiredUsagePercent: number
  minPaidCents: number
}

const statusMeta: Record<string, { text: string; tone: StatusTone }> = {
  PENDING: { text: '待达标', tone: 'warning' },
  QUALIFIED: { text: '已达标', tone: 'primary' },
  PAID: { text: '已发放', tone: 'success' },
  CANCELED: { text: '已取消', tone: 'primary' },
  CLAWBACK: { text: '已扣回', tone: 'danger' },
}

const PAGE_SIZE = 20

export function InviteRewardsPanel() {
  const { message } = App.useApp()
  const [items, setItems] = useState<RewardItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('all')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [form] = Form.useForm<PolicyShape>()

  const fetchRewards = useCallback(async (p: number, s: string) => {
    setLoading(true)
    try {
      const res = await apiFetch<{ items: RewardItem[]; total: number }>('/api/admin/invite-rewards', {
        params: { page: String(p), pageSize: String(PAGE_SIZE), status: s !== 'all' ? s : undefined },
      })
      if (res.success && res.data) {
        setItems(res.data.items ?? [])
        setTotal(res.data.total ?? 0)
      } else {
        message.error(res.message || '加载失败')
      }
    } catch {
      message.error('网络错误')
    } finally {
      setLoading(false)
    }
  }, [message])

  const fetchPolicy = useCallback(async () => {
    try {
      const res = await apiFetch<PolicyShape>('/api/admin/invite-policy')
      if (res.success && res.data) form.setFieldsValue(res.data)
    } catch { /* silent */ }
  }, [form])

  useEffect(() => {
    const timer = window.setTimeout(() => { void fetchPolicy(); void fetchRewards(1, status) }, 0)
    return () => window.clearTimeout(timer)
  }, [fetchPolicy, fetchRewards, status])

  const savePolicy = async () => {
    const values = await form.validateFields()
    setSaving(true)
    try {
      const res = await apiFetch('/api/admin/invite-policy', { method: 'PUT', body: JSON.stringify(values) })
      if (res.success) message.success(res.message || '已保存')
      else message.error(res.message || '保存失败')
    } catch {
      message.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleAction = async (id: string, action: 'pay' | 'cancel' | 'clawback') => {
    setBusy(id)
    try {
      const res = await apiFetch(`/api/admin/invite-rewards/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action }),
      })
      if (res.success) {
        message.success(res.message || '操作成功')
        fetchRewards(page, status)
      } else {
        message.error(res.message || '操作失败')
      }
    } catch {
      message.error('网络错误')
    } finally {
      setBusy(null)
    }
  }

  const columns: ColumnsType<RewardItem> = [
    { title: '邀请人', dataIndex: 'inviterName', width: 130, ellipsis: true },
    { title: '被邀请人', dataIndex: 'inviteeName', width: 130, ellipsis: true },
    {
      title: '订单金额', dataIndex: 'paidAmountCents', width: 100, align: 'right',
      render: (c: number) => `¥${(c / 100).toFixed(2)}`,
    },
    {
      title: '返利积分', dataIndex: 'rewardPoints', width: 100, align: 'right',
      render: (p: number) => <Text className="text-accent">+{p}</Text>,
    },
    {
      title: '使用进度', key: 'usage', width: 130,
      render: (_: unknown, r) => (
        <Text className="text-xs">
          {r.usagePercent}% / {r.requiredUsagePercent}%
        </Text>
      ),
    },
    {
      title: '状态', dataIndex: 'status', width: 100,
      render: (s: string) => {
        const m = statusMeta[s] || { text: s, tone: 'primary' as StatusTone }
        return <StatusTag tone={m.tone}>{m.text}</StatusTag>
      },
    },
    {
      title: '创建时间', dataIndex: 'createdAt', width: 150,
      render: (d: string) => dayjs(d).format('YYYY-MM-DD HH:mm'),
    },
    {
      title: '操作', key: 'actions', width: 220, fixed: 'right' as const,
      render: (_: unknown, r) => (
        <Space size={0}>
          {r.status === 'PENDING' && (
            <>
              <Button type="link" size="small" loading={busy === r.id} onClick={() => handleAction(r.id, 'pay')}>发放</Button>
              <Popconfirm title="取消该笔返利？" okText="取消返利" cancelText="返回" onConfirm={() => handleAction(r.id, 'cancel')}>
                <Button type="link" size="small" danger loading={busy === r.id}>取消</Button>
              </Popconfirm>
            </>
          )}
          {r.status === 'PAID' && (
            <Popconfirm
              title="扣回该笔返利？"
              description="将从邀请人账户扣回对应积分，积分不足时会被拒绝。"
              okText="扣回"
              cancelText="返回"
              okButtonProps={{ danger: true }}
              onConfirm={() => handleAction(r.id, 'clawback')}
            >
              <Button type="link" size="small" danger loading={busy === r.id}>扣回</Button>
            </Popconfirm>
          )}
          {r.status !== 'PENDING' && r.status !== 'PAID' && (
            <Text className="text-xs text-text-disabled">已处理</Text>
          )}
        </Space>
      ),
    },
  ]

  const paidTotal = items.reduce((sum, r) => sum + (r.status === 'PAID' ? r.rewardPoints : 0), 0)

  return (
    <div className="space-y-4">
      <Card variant="outlined" title={<Space><GiftOutlined />返利策略</Space>}>
        <Form form={form} layout="vertical" className="max-w-2xl">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
            <Form.Item name="enabled" label="启用邀请返利" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item
              name="rewardPercent"
              label="返利比例（%）"
              extra="按订单发放的积分+豆计算，返利以积分发放"
              rules={[{ required: true, message: '请输入返利比例' }]}
            >
              <InputNumber min={0} max={100} className="!w-full" addonAfter="%" />
            </Form.Item>
            <Form.Item
              name="requiredUsagePercent"
              label="达标使用比例（%）"
              extra="好友累计消耗需达到其累计购买的该比例后才发放"
              rules={[{ required: true, message: '请输入达标比例' }]}
            >
              <InputNumber min={0} max={100} className="!w-full" addonAfter="%" />
            </Form.Item>
            <Form.Item
              name="minPaidCents"
              label="最低充值门槛（分）"
              extra="低于该金额的订单不产生返利"
              rules={[{ required: true, message: '请输入最低门槛' }]}
            >
              <InputNumber min={0} className="!w-full" addonAfter="分" />
            </Form.Item>
          </div>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={savePolicy}>
            保存策略
          </Button>
        </Form>
      </Card>

      <Card variant="outlined">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <Space size="large">
            <Space><TeamOutlined /><Text strong>返利流水</Text></Space>
            <Statistic title="本页已发放" value={paidTotal} suffix="积分" valueStyle={{ fontSize: 16 }} />
          </Space>
          <Segmented
            value={status}
            onChange={(v) => { setStatus(String(v)); setPage(1) }}
            options={[
              { label: '全部', value: 'all' },
              { label: '待达标', value: 'PENDING' },
              { label: '已发放', value: 'PAID' },
              { label: '已取消', value: 'CANCELED' },
              { label: '已扣回', value: 'CLAWBACK' },
            ]}
          />
        </div>
        <Divider className="!my-3" />
        <Table
          dataSource={items}
          columns={columns}
          rowKey="id"
          loading={loading}
          size="middle"
          scroll={{ x: 1000 }}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total,
            showSizeChanger: false,
            onChange: (p) => { setPage(p); fetchRewards(p, status) },
          }}
        />
      </Card>
    </div>
  )
}
