'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, Button, Input, InputNumber, Switch, Table, Tag, Typography, App, Popconfirm, Space, Alert, Statistic, Row, Col, Tooltip } from 'antd'
import { TeamOutlined, UserAddOutlined, DeleteOutlined, CrownOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { apiFetch } from '@/lib/api-client'
import { PageState } from '@/components/ui/PageState'

const { Text, Paragraph } = Typography

type Member = {
  id: string
  name: string
  dailyLimit: number | null
  dailyBeans: number | null
  note: string | null
  disabled: boolean
  spentTodayPoints: number
  spentTodayBeans: number
  joinedAt: string
}

type TeamData = {
  asMember: {
    ownerId: string
    ownerName: string
    dailyLimitPoints: number | null
    dailyLimitBeans: number | null
    spentTodayPoints: number
    spentTodayBeans: number
  } | null
  asOwner: {
    id: string
    name: string
    status: string
    reviewNote: string | null
    reviewedAt: string | null
    defaultDailyLimit: number
    defaultDailyBeans: number
    poolPoints: number
    poolBeans: number
    members: Member[]
  } | null
  selfPoints: number
  selfBeans: number
}

/**
 * 企业团队（共享余额池）。
 *
 * 两种视角合一页：
 *  - 我是成员 → 显示「我在谁的团队、池子还剩多少、我今天用了多少 / 上限」
 *  - 我是老板 → 显示「团队设置 + 成员管理 + 今天各自花了多少」
 * 同一个人可能同时都不是（普通用户）→ 引导创建团队。
 */
export default function TeamContent() {
  const { message } = App.useApp()
  const [data, setData] = useState<TeamData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // 建团/改设置表单
  const [name, setName] = useState('')
  const [defaultLimit, setDefaultLimit] = useState<number>(0)
  const [defaultBeans, setDefaultBeans] = useState<number>(0)
  // 加成员
  const [addPhone, setAddPhone] = useState('')

  const fetchTeam = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch<TeamData>('/api/user/team')
      if (res.success && res.data) {
        setData(res.data)
        if (res.data.asOwner) {
          setName(res.data.asOwner.name)
          setDefaultLimit(res.data.asOwner.defaultDailyLimit)
          setDefaultBeans(res.data.asOwner.defaultDailyBeans)
        }
      }
    } catch { /* silent */ } finally { setLoading(false) }
  }, [])

  useEffect(() => { void fetchTeam() }, [fetchTeam])

  const saveTeam = async () => {
    if (!name.trim()) { message.warning('请输入团队名称'); return }
    setSaving(true)
    try {
      const res = await apiFetch('/api/user/team', {
        method: 'POST',
        body: JSON.stringify({ name, defaultDailyLimit: defaultLimit, defaultDailyBeans: defaultBeans }),
      })
      if (res.success) { message.success(res.message || '已保存'); void fetchTeam() }
      else message.error(res.message || '保存失败')
    } catch { message.error('保存失败') } finally { setSaving(false) }
  }

  const addMember = async () => {
    if (!addPhone.trim()) { message.warning('请输入成员手机号'); return }
    try {
      const res = await apiFetch('/api/user/team/members', { method: 'POST', body: JSON.stringify({ phone: addPhone.trim() }) })
      if (res.success) { message.success(res.message || '已加入'); setAddPhone(''); void fetchTeam() }
      else message.error(res.message || '添加失败')
    } catch { message.error('添加失败') }
  }

  const updateMember = async (memberId: string, patch: { dailyLimit?: number | null; dailyBeans?: number | null; disabled?: boolean; note?: string | null; remove?: boolean }) => {
    try {
      const res = await apiFetch('/api/user/team/members', { method: 'PATCH', body: JSON.stringify({ memberId, ...patch }) })
      if (res.success) { message.success(res.message || '已更新'); void fetchTeam() }
      else message.error(res.message || '更新失败')
    } catch { message.error('更新失败') }
  }

  if (loading) return <PageState status="loading" description="加载团队信息..." minHeight="160px" />
  if (!data) return <PageState status="error" description="团队信息加载失败" minHeight="160px" />

  const memberColumns: ColumnsType<Member> = [
    {
      title: '成员',
      render: (_: unknown, r: Member) => (
        <div className="min-w-0">
          <Text strong className={r.disabled ? 'text-text-disabled line-through' : ''}>{r.name}</Text>
          {r.note && <Text className="block truncate text-[11px] text-text-muted">{r.note}</Text>}
          {r.disabled && <Tag color="default" className="mt-0.5">已停用（自付）</Tag>}
        </div>
      ),
    },
    {
      title: '备注', width: 140,
      render: (_: unknown, r: Member) => (
        <Input
          size="small" defaultValue={r.note ?? ''} placeholder="如：设计部"
          maxLength={60} className="!w-32"
          onBlur={(e) => {
            const v = e.target.value.trim() || null
            if (v !== (r.note ?? null)) void updateMember(r.id, { note: v })
          }}
        />
      ),
    },
    {
      title: '今日用量', width: 160,
      render: (_: unknown, r: Member) => (
        <Text className="text-xs">
          {r.spentTodayPoints} 积分{r.spentTodayBeans > 0 ? ` · ${r.spentTodayBeans} 豆` : ''}
        </Text>
      ),
    },
    {
      title: '积分/日上限', width: 130,
      render: (_: unknown, r: Member) => (
        <InputNumber
          size="small" min={0} className="!w-24"
          value={r.dailyLimit ?? undefined}
          placeholder="默认"
          onBlur={(e) => {
            const raw = e.target.value
            const v = raw === '' ? null : Number(raw)
            if (v !== (r.dailyLimit ?? null)) void updateMember(r.id, { dailyLimit: v })
          }}
        />
      ),
    },
    {
      // 豆比积分贵得多（视频单条可达 300 豆），按人管控比积分更关键
      title: '豆/日上限', width: 130,
      render: (_: unknown, r: Member) => (
        <InputNumber
          size="small" min={0} className="!w-24"
          value={r.dailyBeans ?? undefined}
          placeholder="默认"
          onBlur={(e) => {
            const raw = e.target.value
            const v = raw === '' ? null : Number(raw)
            if (v !== (r.dailyBeans ?? null)) void updateMember(r.id, { dailyBeans: v })
          }}
        />
      ),
    },
    {
      title: '启用', width: 70, align: 'center',
      render: (_: unknown, r: Member) => (
        <Tooltip title={r.disabled ? '已停用：该成员改为自付（用自己充的钱）' : '启用中：消费从团队池扣'}>
          <Switch size="small" checked={!r.disabled} onChange={(v) => void updateMember(r.id, { disabled: !v })} />
        </Tooltip>
      ),
    },
    {
      title: '', width: 60, align: 'right',
      render: (_: unknown, r: Member) => (
        <Popconfirm
          title={`将 ${r.name} 移出团队？`}
          description="该成员会恢复为自付，余额与历史流水不受影响。"
          okText="移出" cancelText="取消" okButtonProps={{ danger: true }}
          onConfirm={() => void updateMember(r.id, { remove: true })}
        >
          <Button type="text" size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      {/* ===== 我是成员：我在别人的团队里 ===== */}
      {data.asMember && (
        <Card variant="outlined" title={<><TeamOutlined className="mr-1.5" />我所属的团队</>}>
          <Alert
            type="info" showIcon className="mb-4"
            message={`本账号的消费由「${data.asMember.ownerName}」承担`}
            description="生成时从团队账户扣费，你自己的余额与充值仍然保留。团队余额不足时请联系管理员，退出团队即恢复自付。"
          />
          <Row gutter={[16, 16]}>
            <Col xs={12} sm={6}><Statistic title="我今日已用积分" value={data.asMember.spentTodayPoints} /></Col>
            <Col xs={12} sm={6}>
              <Statistic title="我每日积分上限" value={data.asMember.dailyLimitPoints ?? '不限'} />
            </Col>
            <Col xs={12} sm={6}><Statistic title="我今日已用豆" value={data.asMember.spentTodayBeans} /></Col>
            <Col xs={12} sm={6}>
              <Statistic title="我每日豆上限" value={data.asMember.dailyLimitBeans ?? '不限'} />
            </Col>
          </Row>
        </Card>
      )}

      {/* ===== 我是老板：团队设置 + 成员 ===== */}
      <Card
        variant="outlined"
        title={<><CrownOutlined className="mr-1.5" />我的企业团队</>}
        extra={data.asOwner ? <Tag color="gold">{data.asOwner.members.length} 位成员</Tag> : null}
      >
        {!data.asOwner && (
          <Paragraph type="secondary" className="!text-xs">
            创建团队后，把同事加进来，他们的生成消费将统一从**你的余额**扣除（共享余额池）。
            每个成员可单独设每日上限，防止一次误操作烧掉整月预算。
          </Paragraph>
        )}

        {/* 审核状态：必须让申请方看到进度与原因（否则会以为功能坏了） */}
        {data.asOwner && data.asOwner.status === 'PENDING' && (
          <Alert
            type="warning" showIcon className="mb-4"
            message="团队正在等待平台管理员审核"
            description={<>审核通过前<Text strong>不会产生共享扣费</Text>，也暂时无法添加成员。审核通常在 1 个工作日内完成。</>}
          />
        )}
        {data.asOwner && data.asOwner.status === 'REJECTED' && (
          <Alert
            type="error" showIcon className="mb-4"
            message="团队审核未通过"
            description={
              <>
                {data.asOwner.reviewNote ? <>原因：{data.asOwner.reviewNote}<br /></> : null}
                修改信息后重新保存即可再次提交审核。
              </>
            }
          />
        )}
        {data.asOwner && data.asOwner.status === 'APPROVED' && (
          <Alert type="success" showIcon className="mb-4" message="团队已通过审核，共享计费已生效" />
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <div className="mb-1 text-[13px] font-medium">团队名称</div>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：某某科技" maxLength={30} />
          </div>
          <div>
            <div className="mb-1 text-[13px] font-medium">成员默认每日积分上限（0 = 不限）</div>
            <InputNumber min={0} className="!w-full" value={defaultLimit} onChange={(v) => setDefaultLimit(Number(v) || 0)} />
          </div>
          <div>
            <div className="mb-1 text-[13px] font-medium">成员默认每日豆上限（0 = 不限）</div>
            <InputNumber min={0} className="!w-full" value={defaultBeans} onChange={(v) => setDefaultBeans(Number(v) || 0)} />
          </div>
        </div>

        <Paragraph type="secondary" className="!mt-3 !text-xs">
          成员充值只进各自的账号、不会进入团队池；团队池余额由你（企业主）充值维护。
        </Paragraph>

        <div className="mt-4">
          <Button type="primary" loading={saving} onClick={() => void saveTeam()}>
            {data.asOwner ? '保存设置' : '创建团队'}
          </Button>
        </div>
      </Card>

      {/* ===== 成员管理（仅老板可见） ===== */}
      {data.asOwner && (
        <Card variant="outlined" title="团队成员">
          <Space.Compact className="mb-4 w-full sm:w-96">
            <Input
              value={addPhone} onChange={(e) => setAddPhone(e.target.value)}
              placeholder="成员的手机号（对方需先注册）" prefix={<UserAddOutlined />}
              onPressEnter={() => void addMember()}
            />
            <Button type="primary" onClick={() => void addMember()}>添加</Button>
          </Space.Compact>
          {data.asOwner.members.length === 0 ? (
            <PageState status="empty" description="还没有成员，先邀请同事加入" minHeight="120px" />
          ) : (
            <Table
              dataSource={data.asOwner.members}
              columns={memberColumns}
              rowKey="id"
              size="small"
              pagination={false}
            />
          )}
          <Paragraph type="secondary" className="!mt-3 !text-xs">
            成员消费实时从团队池扣：你有 <Text strong>{data.asOwner.poolPoints}</Text> 积分、
            <Text strong>{data.asOwner.poolBeans}</Text> 豆可被团队成员使用。
            每日上限按自然日重置（跨天自动归零）。
          </Paragraph>
        </Card>
      )}
    </div>
  )
}
