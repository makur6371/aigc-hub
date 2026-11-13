'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, Table, Typography, Segmented, Space, Statistic, Row, Col, Tag, Button } from 'antd'
import { TeamOutlined, ThunderboltOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { apiFetch } from '@/lib/api-client'
import { PageState } from '@/components/ui/PageState'
import { StatusTag, type StatusTone } from '@/components/ui/StatusTag'
import dayjs from 'dayjs'

const { Text, Paragraph } = Typography

type MemberRollup = {
  memberId: string
  name: string
  teamSpentPoints: number
  teamSpentBeans: number
  callCount: number
  lastAt: string | null
}

type SpendItem = {
  id: string
  kind: 'points' | 'beans'
  amount: number
  type: string
  description: string | null
  createdAt: string
  memberId: string
  memberName: string
}

type SpendingData = {
  team: { id: string; name: string; status: string }
  summary: { spentPoints: number; spentBeans: number; callCount: number; memberCount: number }
  members: MemberRollup[]
  items: SpendItem[]
  total: number
  page: number
  pageSize: number
}

const typeLabels: Record<string, { text: string; tone: StatusTone }> = {
  DEDUCTION: { text: '扣费', tone: 'primary' },
  RECHARGE: { text: '退回', tone: 'success' },
  ADMIN_ADJUST: { text: '管理员调整', tone: 'warning' },
  BONUS: { text: '奖励', tone: 'success' },
  SUBSCRIPTION: { text: '订阅发放', tone: 'gold' },
}

/**
 * 企业团队「成员消费明细」（老板视角）。
 *
 * 个人账本回答「我花了多少」，这里回答「我的团队花了多少、谁花的、花在哪」。
 * 两者口径同源（billingOwnerId=我，category=null），所以数字能对上总账，
 * 不会出现「个人页说扣了 12、这里说扣了 30」的口径分叉。
 */
export default function TeamSpendingPanel() {
  const [data, setData] = useState<SpendingData | null>(null)
  const [loading, setLoading] = useState(true)
  const [memberId, setMemberId] = useState<string>('all')
  const [page, setPage] = useState(1)
  const pageSize = 20

  const fetchData = useCallback(async (p: number, mid: string) => {
    setLoading(true)
    try {
      const qs = new URLSearchParams({ page: String(p), pageSize: String(pageSize) })
      if (mid !== 'all') qs.set('memberId', mid)
      const res = await apiFetch<SpendingData>(`/api/user/team/spending?${qs.toString()}`)
      if (res.success && res.data) setData(res.data)
    } catch { /* silent */ } finally { setLoading(false) }
  }, [])

  useEffect(() => { void fetchData(page, memberId) }, [fetchData, page, memberId])

  const memberColumns: ColumnsType<MemberRollup> = [
    { title: '成员', dataIndex: 'name', render: (v: string) => <Text strong>{v}</Text> },
    {
      title: '累计消费（积分）', width: 150, align: 'right',
      render: (_: unknown, r: MemberRollup) => (
        <Text className={r.teamSpentPoints > 0 ? 'text-danger' : 'text-text-muted'}>
          {r.teamSpentPoints > 0 ? `-${r.teamSpentPoints}` : '0'}
        </Text>
      ),
    },
    {
      title: '累计消费（豆）', width: 140, align: 'right',
      render: (_: unknown, r: MemberRollup) => (
        <Text className={r.teamSpentBeans > 0 ? 'text-warning' : 'text-text-muted'}>
          {r.teamSpentBeans > 0 ? `-${r.teamSpentBeans}` : '0'}
        </Text>
      ),
    },
    { title: '调用次数', dataIndex: 'callCount', width: 100, align: 'right' },
    {
      title: '最近一次', width: 180,
      render: (_: unknown, r: MemberRollup) => (
        <Text className="text-xs text-text-muted">{r.lastAt ? dayjs(r.lastAt).format('MM-DD HH:mm') : '-'}</Text>
      ),
    },
    {
      title: '', width: 90, align: 'right',
      render: (_: unknown, r: MemberRollup) => (
        <Button
          type="link" size="small"
          onClick={() => { setMemberId(r.memberId); setPage(1) }}
        >
          看明细
        </Button>
      ),
    },
  ]

  const itemColumns: ColumnsType<SpendItem> = [
    {
      title: '成员', dataIndex: 'memberName', width: 140,
      render: (v: string) => <Text strong>{v}</Text>,
    },
    {
      title: '类型', dataIndex: 'type', width: 110,
      render: (t: string) => {
        const l = typeLabels[t] || { text: t, tone: 'primary' as StatusTone }
        return <StatusTag tone={l.tone}>{l.text}</StatusTag>
      },
    },
    {
      title: '币种', dataIndex: 'kind', width: 80,
      render: (k: SpendItem['kind']) => (
        k === 'beans' ? <Tag color="gold">豆</Tag> : <Tag color="blue">积分</Tag>
      ),
    },
    {
      title: '变动', dataIndex: 'amount', width: 120, align: 'right',
      render: (amount: number, r: SpendItem) => {
        const isSpend = amount < 0
        return (
          <span className={isSpend ? 'text-danger' : 'text-success'}>
            {amount > 0 ? '+' : ''}{amount}{r.kind === 'beans' ? ' 豆' : ''}
          </span>
        )
      },
    },
    {
      title: '用途', dataIndex: 'description', ellipsis: true,
      render: (v: string | null) => {
        if (!v) return '-'
        const sep = v.indexOf(' · ')
        if (sep < 0) return <span className="text-[13px]">{v}</span>
        return (
          <span className="text-[13px]">
            {v.slice(0, sep)}
            <span className="ml-1.5 rounded bg-black/[0.05] px-1.5 py-0.5 text-[11px] text-black/55">
              {v.slice(sep + 3)}
            </span>
          </span>
        )
      },
    },
    {
      title: '时间', dataIndex: 'createdAt', width: 170,
      render: (d: string) => <Text className="text-xs">{dayjs(d).format('YYYY-MM-DD HH:mm:ss')}</Text>,
    },
  ]

  if (loading && !data) return <PageState status="loading" description="加载团队消费明细..." minHeight="200px" />
  if (!data) return <PageState status="empty" description="暂无团队消费记录（你是团队管理员后这里会显示成员消费）" minHeight="200px" />

  const activeMember = memberId === 'all' ? null : data.members.find((m) => m.memberId === memberId)

  return (
    <div className="space-y-4">
      <Card variant="outlined" title={<><TeamOutlined className="mr-1.5" />团队成员消费</>}>
        <Row gutter={[16, 16]}>
          <Col xs={12} sm={6}><Statistic title="团队累计积分" value={data.summary.spentPoints} prefix={<ThunderboltOutlined />} /></Col>
          <Col xs={12} sm={6}><Statistic title="团队累计豆" value={data.summary.spentBeans} /></Col>
          <Col xs={12} sm={6}><Statistic title="总调用次数" value={data.summary.callCount} /></Col>
          <Col xs={12} sm={6}><Statistic title="团队成员数" value={data.summary.memberCount} /></Col>
        </Row>
        <Paragraph type="secondary" className="!mb-0 !mt-3 !text-xs">
          口径与你的积分记录一致（净额，退款已抵扣），所以这里的数字和钱包变动能对得上。
        </Paragraph>
      </Card>

      <Card variant="outlined" title="按成员汇总">
        {data.members.length === 0 ? (
          <PageState status="empty" description="团队还没有成员" minHeight="120px" />
        ) : (
          <Table
            dataSource={data.members}
            columns={memberColumns}
            rowKey="memberId"
            size="small"
            pagination={false}
          />
        )}
      </Card>

      <Card
        variant="outlined"
        title={
          <Space>
            <span>消费明细</span>
            {activeMember && <Tag color="blue" closable onClose={() => { setMemberId('all'); setPage(1) }}>{activeMember.name}</Tag>}
          </Space>
        }
        extra={
          <Segmented
            value={memberId}
            onChange={(v) => { setMemberId(String(v)); setPage(1) }}
            options={[
              { label: '全部成员', value: 'all' },
              ...data.members.slice(0, 8).map((m) => ({ label: m.name, value: m.memberId })),
            ]}
          />
        }
      >
        {data.items.length === 0 ? (
          <PageState status="empty" description="暂无消费记录" minHeight="120px" />
        ) : (
          <Table
            dataSource={data.items}
            columns={itemColumns}
            rowKey="id"
            size="small"
            pagination={{
              current: page,
              pageSize,
              total: data.total,
              showSizeChanger: false,
              onChange: (p) => setPage(p),
            }}
          />
        )}
      </Card>
    </div>
  )
}
