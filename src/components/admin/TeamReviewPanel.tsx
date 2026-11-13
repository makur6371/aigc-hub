'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, Table, Tag, Button, Typography, App, Segmented, Modal, Input, InputNumber, Descriptions, Statistic, Row, Col, Drawer, Switch, Popconfirm, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { CheckOutlined, CloseOutlined, TeamOutlined, DeleteOutlined } from '@ant-design/icons'
import { StatusTag, type StatusTone } from '@/components/ui/StatusTag'
import { apiFetch } from '@/lib/api-client'
import { PageState } from '@/components/ui/PageState'
import dayjs from 'dayjs'

const { Text, Paragraph } = Typography

type TeamItem = {
  id: string
  name: string
  status: string
  reviewNote: string | null
  reviewedAt: string | null
  createdAt: string
  defaultDailyLimit: number
  defaultDailyBeans: number
  owner: {
    id: string; name: string; phone: string | null; email: string | null
    points: number; beans: number; registeredAt: string
  }
  memberCount: number
  totalSpentPoints: number
}

type TeamDetail = {
  id: string
  name: string
  status: string
  defaultDailyLimit: number
  defaultDailyBeans: number
  owner: { id: string; name: string; phone: string | null; email: string | null; points: number; beans: number; status: string; registeredAt: string }
  members: Array<{
    id: string; name: string; phone: string | null; email: string | null
    accountStatus: string
    dailyLimit: number | null; dailyBeans: number | null; note: string | null; disabled: boolean
    spentTodayPoints: number; spentTodayBeans: number
    totalSpentPoints: number; totalCalls: number
    joinedAt: string
  }>
}

type Summary = {
  pendingCount: number
  approvedCount: number
  suspendedCount: number
  memberTotal: number
  sharedSpentPoints: number
}

const statusMeta: Record<string, { text: string; tone: StatusTone }> = {
  PENDING: { text: '待审核', tone: 'warning' },
  APPROVED: { text: '已通过', tone: 'success' },
  REJECTED: { text: '已驳回', tone: 'danger' },
  // 停用 ≠ 驳回：驳回是「申请没通过」（解除成员）；停用是「已通过的企业暂时冻结」（保留名册）
  SUSPENDED: { text: '已停用', tone: 'primary' },
}

const PAGE_SIZE = 10

/**
 * 后台：企业团队审核。
 *
 * 团队 = 让一个账号为其他账号付费（资金权力）。审核通过前，
 * 成员消费**不会**从 owner 余额扣（闸门在 lib/billing/team.ts，扣费路径强制生效）。
 * 所以这里「不通过」本身就是最有效的阻止方式，不需要额外下线操作。
 */
export function TeamReviewPanel() {
  const { message } = App.useApp()
  const [items, setItems] = useState<TeamItem[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState('PENDING')
  const [reviewing, setReviewing] = useState<TeamItem | null>(null)
  const [note, setNote] = useState('')
  /** 团队详情（成员名册 + 管理员代管） */
  const [detail, setDetail] = useState<TeamDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const fetchTeams = useCallback(async (p: number, s: string) => {
    setLoading(true)
    try {
      const res = await apiFetch<{ items: TeamItem[]; total: number; summary: Summary }>('/api/admin/teams', {
        params: { page: String(p), pageSize: String(PAGE_SIZE), status: s },
      })
      if (res.success && res.data) { setItems(res.data.items); setTotal(res.data.total); setSummary(res.data.summary) }
    } catch { /* silent */ } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    const t = window.setTimeout(() => void fetchTeams(page, status), 0)
    return () => window.clearTimeout(t)
  }, [fetchTeams, page, status])

  const doReview = async (action: 'approve' | 'reject') => {
    if (!reviewing) return
    try {
      const res = await apiFetch(`/api/admin/teams/${reviewing.id}/review`, {
        method: 'POST',
        body: JSON.stringify({ action, note }),
      })
      if (res.success) {
        message.success(res.message || '已处理')
        setReviewing(null); setNote('')
        void fetchTeams(page, status)
      } else message.error(res.message || '处理失败')
    } catch { message.error('处理失败') }
  }

  const openDetail = async (teamId: string) => {
    setDetailLoading(true)
    try {
      const res = await apiFetch<TeamDetail>(`/api/admin/teams/${teamId}`)
      if (res.success && res.data) setDetail(res.data)
      else message.error(res.message || '加载失败')
    } catch { message.error('加载失败') } finally { setDetailLoading(false) }
  }

  /** 管理员代管成员：停用/启用、改额度、踢出 */
  const adminUpdateMember = async (memberId: string, patch: Record<string, unknown>) => {
    if (!detail) return
    try {
      const res = await apiFetch(`/api/admin/teams/${detail.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'updateMember', memberId, ...patch }),
      })
      if (res.success) { message.success(res.message || '已更新'); void openDetail(detail.id) }
      else message.error(res.message || '更新失败')
    } catch { message.error('更新失败') }
  }

  const adminRemoveMember = async (memberId: string) => {
    if (!detail) return
    try {
      const res = await apiFetch(`/api/admin/teams/${detail.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'removeMember', memberId }),
      })
      if (res.success) { message.success(res.message || '已移出'); void openDetail(detail.id) }
      else message.error(res.message || '操作失败')
    } catch { message.error('操作失败') }
  }

  /** 停用 / 恢复团队（保留成员名册，只停止共享计费） */
  const doSuspend = async (team: TeamItem, suspend: boolean) => {
    try {
      const res = await apiFetch(`/api/admin/teams/${team.id}/review`, {
        method: 'POST',
        body: JSON.stringify({ action: suspend ? 'suspend' : 'resume' }),
      })
      if (res.success) { message.success(res.message || '已处理'); void fetchTeams(page, status) }
      else message.error(res.message || '处理失败')
    } catch { message.error('处理失败') }
  }

  const columns: ColumnsType<TeamItem> = [
    {
      title: '团队 / 申请方',
      render: (_: unknown, r: TeamItem) => (
        <div className="min-w-0">
          <Text strong className="block truncate">{r.name}</Text>
          <Text className="block truncate text-[11px] text-text-muted">
            {r.owner.name}{r.owner.phone ? ` · ${r.owner.phone}` : ''}
          </Text>
        </div>
      ),
    },
    {
      title: '团队余额', width: 150,
      render: (_: unknown, r: TeamItem) => (
        <Text className="text-xs">{r.owner.points} 积分{r.owner.beans > 0 ? ` · ${r.owner.beans} 豆` : ''}</Text>
      ),
    },
    { title: '成员数', dataIndex: 'memberCount', width: 80, align: 'right' },
    {
      title: '累计团队消费', dataIndex: 'totalSpentPoints', width: 120, align: 'right',
      render: (v: number) => <Text className="text-xs">{v} 积分</Text>,
    },
    {
      title: '状态', dataIndex: 'status', width: 100, align: 'center',
      render: (s: string) => {
        const m = statusMeta[s] || { text: s, tone: 'primary' as StatusTone }
        return <StatusTag tone={m.tone}>{m.text}</StatusTag>
      },
    },
    {
      title: '申请时间', dataIndex: 'createdAt', width: 110,
      render: (d: string) => <Text className="text-xs text-text-secondary">{dayjs(d).format('MM-DD HH:mm')}</Text>,
    },
    {
      title: '操作', width: 150, align: 'center',
      render: (_: unknown, r: TeamItem) => (
        <div className="flex items-center justify-center gap-1">
          <Button type="link" size="small" onClick={() => void openDetail(r.id)}>成员</Button>
          <Button type="link" size="small" onClick={() => { setReviewing(r); setNote(r.reviewNote || '') }}>
            {r.status === 'PENDING' ? '审核' : '详情'}
          </Button>
          {r.status === 'APPROVED' && (
            <Popconfirm title="停用该团队？" description="成员将立即停止共享计费（改为自付），成员名册保留。" okText="停用" cancelText="取消" onConfirm={() => void doSuspend(r, true)}>
              <Button type="link" size="small" danger>停用</Button>
            </Popconfirm>
          )}
          {r.status === 'SUSPENDED' && (
            <Button type="link" size="small" onClick={() => void doSuspend(r, false)}>恢复</Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <Card
      variant="outlined"
      title={<><TeamOutlined className="mr-1.5" />企业团队审核</>}
      extra={
        <Segmented
          value={status}
          onChange={(v) => { setStatus(String(v)); setPage(1) }}
          options={[
            { value: 'PENDING', label: '待审核' },
            { value: 'APPROVED', label: '已通过' },
            { value: 'APPROVED', label: '已通过' },
            { value: 'SUSPENDED', label: '已停用' },
            { value: 'REJECTED', label: '已驳回' },
            { value: 'all', label: '全部' },
          ]}
        />
      }
    >
      {/* 全站总览：多少家 / 覆盖多少成员 / 共享池消耗 —— 管企业时最先要的三个数 */}
      {summary && (
        <Row gutter={[12, 12]} className="mb-4">
          <Col xs={12} sm={6}><Statistic title="待审核" value={summary.pendingCount} valueStyle={{ color: '#d97706' }} /></Col>
          <Col xs={12} sm={6}><Statistic title="已通过团队" value={summary.approvedCount} /></Col>
          <Col xs={12} sm={6}><Statistic title="已停用" value={summary.suspendedCount} /></Col>
          <Col xs={12} sm={6}><Statistic title="覆盖成员数" value={summary.memberTotal} /></Col>
        </Row>
      )}
      <Paragraph type="secondary" className="!text-xs !mb-3">
        企业团队 = 由企业账号为成员付费（共享余额池）。<Text strong>审核通过前不会产生任何共享扣费</Text>，
        成员也无法被添加。重点判断：是否真实企业用途，而非代充 / 转售通道。
      </Paragraph>

      {items.length === 0 && !loading ? (
        <PageState status="empty" description={status === 'PENDING' ? '暂无待审核的团队' : '暂无记录'} minHeight="140px" />
      ) : (
        <Table
          dataSource={items}
          columns={columns}
          rowKey="id"
          loading={loading}
          size="middle"
          pagination={{ current: page, pageSize: PAGE_SIZE, total, showSizeChanger: false, onChange: (p) => setPage(p) }}
        />
      )}

      <Modal
        title="团队审核"
        open={!!reviewing}
        onCancel={() => { setReviewing(null); setNote('') }}
        width={560}
        footer={
          reviewing?.status === 'PENDING' ? (
            <div className="flex justify-end gap-2">
              <Button danger icon={<CloseOutlined />} onClick={() => void doReview('reject')}>驳回</Button>
              <Button type="primary" icon={<CheckOutlined />} onClick={() => void doReview('approve')}>通过</Button>
            </div>
          ) : reviewing?.status === 'APPROVED' ? (
            <div className="flex justify-end gap-2">
              <Button onClick={() => { setReviewing(null); setNote('') }}>关闭</Button>
              <Button danger onClick={() => { void doSuspend(reviewing!, true); setReviewing(null) }}>停用团队</Button>
            </div>
          ) : reviewing?.status === 'SUSPENDED' ? (
            <div className="flex justify-end gap-2">
              <Button onClick={() => { setReviewing(null); setNote('') }}>关闭</Button>
              <Button type="primary" onClick={() => { void doSuspend(reviewing!, false); setReviewing(null) }}>恢复团队</Button>
            </div>
          ) : (
            <Button onClick={() => setReviewing(null)}>关闭</Button>
          )
        }
      >
        {reviewing && (
          <div className="space-y-4">
            <Row gutter={[16, 16]}>
              <Col span={12}><Statistic title="团队名称" value={reviewing.name} /></Col>
              <Col span={12}><Statistic title="成员数" value={reviewing.memberCount} /></Col>
              <Col span={12}><Statistic title="企业账号余额" value={reviewing.owner.points} suffix="积分" /></Col>
              <Col span={12}><Statistic title="累计团队消费" value={reviewing.totalSpentPoints} suffix="积分" /></Col>
            </Row>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="申请方">{reviewing.owner.name}</Descriptions.Item>
              <Descriptions.Item label="手机号">{reviewing.owner.phone || '—'}</Descriptions.Item>
              <Descriptions.Item label="邮箱">{reviewing.owner.email || '—'}</Descriptions.Item>
              <Descriptions.Item label="账号注册时间">{dayjs(reviewing.owner.registeredAt).format('YYYY-MM-DD HH:mm')}</Descriptions.Item>
              <Descriptions.Item label="成员默认日额度">
                {reviewing.defaultDailyLimit > 0 ? `${reviewing.defaultDailyLimit} 积分/天` : '不限'}
              </Descriptions.Item>
              <Descriptions.Item label="申请时间">{dayjs(reviewing.createdAt).format('YYYY-MM-DD HH:mm')}</Descriptions.Item>
            </Descriptions>
            {reviewing.status === 'PENDING' ? (
              <div>
                <div className="mb-1 text-[13px] font-medium">审核备注（可选，会回显给申请方）</div>
                <Input.TextArea
                  rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300}
                  placeholder="通过可写说明；驳回建议写明原因（如「请提供企业资质」「疑似代充」）"
                />
              </div>
            ) : (
              <Descriptions size="small" column={1}>
                <Descriptions.Item label="审核结果">{statusMeta[reviewing.status]?.text || reviewing.status}</Descriptions.Item>
                <Descriptions.Item label="审核时间">{reviewing.reviewedAt ? dayjs(reviewing.reviewedAt).format('YYYY-MM-DD HH:mm') : '—'}</Descriptions.Item>
                <Descriptions.Item label="备注">{reviewing.reviewNote || '—'}</Descriptions.Item>
              </Descriptions>
            )}
            {reviewing.status === 'PENDING' && (
              <div className="rounded-lg bg-amber-50/70 px-3 py-2 text-[12px] leading-relaxed text-amber-700">
                驳回会**同时解除该团队全部成员的绑定**，成员立即恢复为自付。
                通过后成员消费将从企业账号余额扣除。
              </div>
            )}
          </div>
        )}
      </Modal>
      {/* ===== 团队详情：成员名册 + 管理员代管（踢人 / 停用 / 改额度）=====
          为什么管理员需要这层：审核通过后企业仍会出问题 —— 成员跑异常任务、
          企业主要求平台协助停人、要核对「这个团队到底有谁」。
          只有审核入口的话，管理员只能让企业主自己去操作。 */}
      <Drawer
        title={detail ? `团队详情 · ${detail.name}` : '团队详情'}
        open={!!detail}
        onClose={() => setDetail(null)}
        width={860}
        loading={detailLoading}
      >
        {detail && (
          <div className="space-y-4">
            <Row gutter={[16, 16]}>
              <Col span={8}><Statistic title="团队余额" value={detail.owner.points} suffix="积分" /></Col>
              <Col span={8}><Statistic title="团队豆" value={detail.owner.beans} /></Col>
              <Col span={8}><Statistic title="成员数" value={detail.members.length} /></Col>
            </Row>
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label="企业账号">{detail.owner.name}</Descriptions.Item>
              <Descriptions.Item label="账号状态">
                {detail.owner.status === 'NORMAL' ? '正常' : '已冻结'}
              </Descriptions.Item>
              <Descriptions.Item label="手机号">{detail.owner.phone || '—'}</Descriptions.Item>
              <Descriptions.Item label="邮箱">{detail.owner.email || '—'}</Descriptions.Item>
              <Descriptions.Item label="团队状态">{statusMeta[detail.status]?.text || detail.status}</Descriptions.Item>
              <Descriptions.Item label="成员默认日额度">
                {(detail.defaultDailyLimit || 0) > 0 ? `${detail.defaultDailyLimit} 积分` : '不限'}
                {' / '}
                {(detail.defaultDailyBeans || 0) > 0 ? `${detail.defaultDailyBeans} 豆` : '不限'}
              </Descriptions.Item>
            </Descriptions>

            <Card variant="outlined" size="small" title="成员名册">
              {detail.members.length === 0 ? (
                <PageState status="empty" description="该团队暂无成员" minHeight="100px" />
              ) : (
                <Table
                  dataSource={detail.members}
                  rowKey="id"
                  size="small"
                  pagination={false}
                  scroll={{ x: 780 }}
                  columns={[
                    {
                      title: '成员',
                      render: (_: unknown, m: TeamDetail['members'][number]) => (
                        <div className="min-w-0">
                          <Text strong className={m.disabled ? 'text-text-disabled line-through' : ''}>{m.name}</Text>
                          {m.note && <Text className="block truncate text-[11px] text-text-muted">{m.note}</Text>}
                          {m.disabled && <Tag className="mt-0.5">已停用（自付）</Tag>}
                        </div>
                      ),
                    },
                    { title: '累计消费', width: 120, align: 'right', render: (_: unknown, m: TeamDetail['members'][number]) => <Text className="text-xs">{m.totalSpentPoints} 积分 · {m.totalCalls} 次</Text> },
                    { title: '今日', width: 100, align: 'right', render: (_: unknown, m: TeamDetail['members'][number]) => <Text className="text-xs">{m.spentTodayPoints}{m.spentTodayBeans > 0 ? ` · ${m.spentTodayBeans}豆` : ''}</Text> },
                    {
                      title: '积分/日', width: 100,
                      render: (_: unknown, m: TeamDetail['members'][number]) => (
                        <InputNumber size="small" min={0} className="!w-20" defaultValue={m.dailyLimit ?? undefined} placeholder="默认"
                          onBlur={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== (m.dailyLimit ?? null)) void adminUpdateMember(m.id, { dailyLimit: v }) }} />
                      ),
                    },
                    {
                      title: '豆/日', width: 100,
                      render: (_: unknown, m: TeamDetail['members'][number]) => (
                        <InputNumber size="small" min={0} className="!w-20" defaultValue={m.dailyBeans ?? undefined} placeholder="默认"
                          onBlur={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== (m.dailyBeans ?? null)) void adminUpdateMember(m.id, { dailyBeans: v }) }} />
                      ),
                    },
                    {
                      // 管理员也能改备注：企业主不会用或联系不上时，平台需要能直接标注
                      title: '备注', width: 130,
                      render: (_: unknown, m: TeamDetail['members'][number]) => (
                        <Input size="small" defaultValue={m.note ?? ''} placeholder="如：外包" maxLength={60} className="!w-28"
                          onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== (m.note ?? null)) void adminUpdateMember(m.id, { note: v }) }} />
                      ),
                    },
                    {
                      title: '启用', width: 60, align: 'center',
                      render: (_: unknown, m: TeamDetail['members'][number]) => (
                        <Tooltip title={m.disabled ? '已停用：改为自付' : '启用中：从团队池扣'}>
                          <Switch size="small" checked={!m.disabled} onChange={(v) => void adminUpdateMember(m.id, { disabled: !v })} />
                        </Tooltip>
                      ),
                    },
                    {
                      title: '', width: 50, align: 'right',
                      render: (_: unknown, m: TeamDetail['members'][number]) => (
                        <Popconfirm title={`将 ${m.name} 移出团队？`} onConfirm={() => void adminRemoveMember(m.id)} okText="移出" cancelText="取消">
                          <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                        </Popconfirm>
                      ),
                    },
                  ]}
                />
              )}
            </Card>
          </div>
        )}
      </Drawer>
    </Card>
  )
}
