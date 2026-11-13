'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  App, Button, Card, Drawer, Input, InputNumber, Pagination, Select, Space, Switch, Table, Tag, Typography,
} from 'antd'
import { ClockCircleOutlined, FileTextOutlined, GiftOutlined, ReloadOutlined, SaveOutlined, ThunderboltOutlined, UserOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { apiFetch } from '@/lib/api-client'

const { Text, Paragraph } = Typography

interface PassPolicy {
  enabled: boolean
  dailyUserLimit: number
  dailyPlatformLimit: number
  modelIds: string[] | null
}

interface CoveredModel {
  id: string
  name: string
  provider: string
  dailyUserFreeQuota: number | null
  dailyPlatformFreeQuota: number | null
  covered: boolean
}

interface PassUser {
  id: string
  nickname: string | null
  phone: string | null
  freeImageUntil: string | null
  remainingMinutes: number
  totalGrantedDays: number
  usage30d: number
  usageToday: number
  lastUsedAt: string | null
}

interface GrantRow {
  id: string
  minutes: number
  source: string
  description: string
  startsAt: string
  expiresAt: string
  createdAt: string
  operatorName: string | null
  user: { id: string; nickname: string | null; phone: string | null }
}

interface GrantLogRow {
  id: string
  source: string
  description: string
  minutes: number
  startsAt: string
  expiresAt: string
  createdAt: string
  operatorId: string | null
  operatorName: string | null
}

interface GrantLogPayload {
  user: {
    id: string
    nickname: string | null
    phone: string | null
    freeImageUntil: string | null
    remainingMinutes: number
    createdAt: string
  }
  summary: {
    totalGrants: number
    totalGrantedDays: number
    usage30d: number
    usageToday: number
    lastUsedAt: string | null
  }
  grants: GrantLogRow[]
  pagination: { page: number; pageSize: number; total: number }
}

interface Payload {
  policy: PassPolicy
  coveredModels: CoveredModel[]
  stats: {
    activeUsers: number
    todayGrants: number
    todayGrantedDays: number
    todayUsage: number
    todayUsageUsers: number
  }
  recentGrants: GrantRow[]
  users: { total: number; page: number; pageSize: number; items: PassUser[] }
  day: string
}

const sourceLabels: Record<string, string> = {
  WELCOME: '公告领取',
  SUBSCRIPTION: '月度套餐',
  CHECKIN: '签到',
  INVITE: '邀请',
  ADMIN: '管理员代发',
}

const sourceColors: Record<string, string> = {
  WELCOME: 'purple',
  SUBSCRIPTION: 'blue',
  CHECKIN: 'green',
  INVITE: 'cyan',
  ADMIN: 'orange',
}

function formatDuration(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`
  if (minutes % 60 === 0) return `${minutes / 60} 小时`
  return `${minutes} 分钟`
}

function formatRemaining(minutes: number): string {
  if (minutes <= 0) return '已过期'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${mins} 分`
  return `${mins} 分钟`
}

function formatDays(minutes: number): string {
  const days = minutes / 1440
  return `${Math.round(days * 10) / 10} 天`
}

/** 生图时长券：限额配置 + 覆盖模型 + 领取/使用台账 + 用户剩余时长。 */
export function FreeImagePassPanel() {
  const { message } = App.useApp()
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState<PassPolicy | null>(null)
  const [query, setQuery] = useState({ q: '', status: 'active' as 'active' | 'expired', page: 1, pageSize: 20 })
  const [searchText, setSearchText] = useState('')
  const [grantUser, setGrantUser] = useState<PassUser | null>(null)
  const [grantLog, setGrantLog] = useState<GrantLogPayload | null>(null)
  const [grantLoading, setGrantLoading] = useState(false)
  const [grantPage, setGrantPage] = useState({ page: 1, pageSize: 20 })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        q: query.q,
        status: query.status,
        page: String(query.page),
        pageSize: String(query.pageSize),
      })
      const res = await apiFetch<Payload>(`/api/admin/free-image-pass?${params.toString()}`)
      if (res.success && res.data) {
        setData(res.data)
        setDraft(res.data.policy)
      } else {
        message.error(res.message || '加载失败')
      }
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }, [message, query])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const res = await apiFetch('/api/admin/free-image-pass', {
        method: 'PUT',
        body: JSON.stringify(draft),
      })
      if (res.success) {
        message.success('已保存，新限额立即生效')
        await load()
      } else {
        message.error(res.message)
      }
    } catch {
      message.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const openGrantLog = useCallback(async (user: PassUser, page = 1, pageSize = 20) => {
    setGrantUser(user)
    setGrantPage({ page, pageSize })
    setGrantLoading(true)
    try {
      const params = new URLSearchParams({ userId: user.id, page: String(page), pageSize: String(pageSize) })
      const res = await apiFetch<GrantLogPayload>(`/api/admin/free-image-pass/grants?${params.toString()}`)
      if (res.success && res.data) setGrantLog(res.data)
      else message.error(res.message || '领取日志加载失败')
    } catch {
      message.error('领取日志加载失败')
    } finally {
      setGrantLoading(false)
    }
  }, [message])

  const covered = data?.coveredModels.filter((m) => draft?.modelIds === null ? m.dailyUserFreeQuota! > 0 : draft?.modelIds.includes(m.id)) ?? []
  const unlimited = (draft?.dailyUserLimit ?? 0) === 0 && (draft?.dailyPlatformLimit ?? 0) === 0

  const userColumns: ColumnsType<PassUser> = [
    {
      title: '用户',
      width: 200,
      render: (_, u) => (
        <div className="flex flex-col gap-0.5">
          <Text className="text-sm font-medium">{u.nickname || '未设置昵称'}</Text>
          <Text type="secondary" className="text-[11px]">{u.phone || u.id.slice(0, 10)}</Text>
        </div>
      ),
    },
    {
      title: '剩余时长',
      width: 150,
      render: (_, u) => (
        <div className="flex flex-col gap-0.5">
          <Tag color={u.remainingMinutes > 0 ? 'purple' : 'default'} className="!mr-0 !w-fit">
            {formatRemaining(u.remainingMinutes)}
          </Tag>
          <Text type="secondary" className="text-[11px]">
            {u.freeImageUntil ? `至 ${dayjs(u.freeImageUntil).format('MM-DD HH:mm')}` : '从未获得'}
          </Text>
        </div>
      ),
    },
    {
      title: '累计获赠',
      width: 100,
      render: (_, u) => <Text className="text-xs">{u.totalGrantedDays} 天</Text>,
    },
    {
      title: '今日用券',
      width: 100,
      render: (_, u) => (
        <Text className="text-xs">{u.usageToday} 张</Text>
      ),
    },
    {
      title: '近 30 天用券',
      width: 120,
      render: (_, u) => <Text className="text-xs">{u.usage30d} 张</Text>,
    },
    {
      title: '最近使用',
      width: 150,
      render: (_, u) => (
        <Text type="secondary" className="text-xs">
          {u.lastUsedAt ? dayjs(u.lastUsedAt).format('MM-DD HH:mm') : '未使用'}
        </Text>
      ),
    },
    {
      title: '操作',
      width: 100,
      fixed: 'right',
      render: (_, u) => (
        <Button type="link" size="small" icon={<FileTextOutlined />} onClick={() => void openGrantLog(u)}>
          领取日志
        </Button>
      ),
    },
  ]

  const grantColumns: ColumnsType<GrantRow> = [
    {
      title: '用户',
      width: 160,
      render: (_, g) => (
        <Text className="text-xs">{g.user.nickname || g.user.phone || g.user.id.slice(0, 10)}</Text>
      ),
    },
    { title: '说明', dataIndex: 'description', ellipsis: true },
    { title: '时长', width: 80, render: (_, g) => <Text className="text-xs">{formatDays(g.minutes)}</Text> },
    {
      title: '来源',
      width: 90,
      render: (_, g) => <Tag className="!mr-0">{sourceLabels[g.source] || g.source}</Tag>,
    },
    {
      title: '操作人',
      width: 100,
      render: (_, g) => (
        <Text type="secondary" className="text-xs">{g.operatorName || '—'}</Text>
      ),
    },
    {
      title: '生效 → 到期',
      width: 230,
      render: (_, g) => (
        <Text type="secondary" className="text-[11px]">
          {dayjs(g.startsAt).format('MM-DD HH:mm')} → {dayjs(g.expiresAt).format('MM-DD HH:mm')}
        </Text>
      ),
    },
    {
      title: '领取时间',
      width: 120,
      render: (_, g) => <Text type="secondary" className="text-[11px]">{dayjs(g.createdAt).format('MM-DD HH:mm')}</Text>,
    },
  ]

  return (
    <div className="space-y-4">
      <Card
        variant="outlined"
        loading={loading && !data}
        title={<><ClockCircleOutlined className="mr-2" />生图时长券</>}
        extra={<Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>刷新</Button>}
      >
        <Paragraph type="secondary" className="!mb-4 !text-xs">
          时长券 = <b>有效期内免费</b>，与「免费额度池」分开：有券时优先走券、不占每日额度；
          没有券才走每日额度池。留空或 0 = 不限次（当前默认）。
        </Paragraph>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-black/5 bg-white/70 p-3">
            <Text type="secondary" className="text-[11px]">生效中用户</Text>
            <div className="mt-1 text-2xl font-semibold">{data?.stats.activeUsers ?? '—'}</div>
            <Text type="secondary" className="text-[11px]">有未到期时长券</Text>
          </div>
          <div className="rounded-2xl border border-black/5 bg-white/70 p-3">
            <Text type="secondary" className="text-[11px]">今日发放</Text>
            <div className="mt-1 text-2xl font-semibold">{data?.stats.todayGrants ?? '—'}</div>
            <Text type="secondary" className="text-[11px]">共 {data?.stats.todayGrantedDays ?? 0} 天</Text>
          </div>
          <div className="rounded-2xl border border-black/5 bg-white/70 p-3">
            <Text type="secondary" className="text-[11px]">今日用券生图</Text>
            <div className="mt-1 text-2xl font-semibold">{data?.stats.todayUsage ?? '—'}</div>
            <Text type="secondary" className="text-[11px]">{data?.stats.todayUsageUsers ?? 0} 位用户</Text>
          </div>
          <div className="rounded-2xl border border-black/5 bg-white/70 p-3">
            <Text type="secondary" className="text-[11px]">今日日期</Text>
            <div className="mt-1 text-2xl font-semibold">{data?.day ?? '—'}</div>
            <Text type="secondary" className="text-[11px]">按北京时间 0 点重置</Text>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-black/5 bg-white/60 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <Text strong className="text-sm"><GiftOutlined className="mr-1.5" />有效期内限额</Text>
            <Text type="secondary" className="text-[11px]">
              {unlimited ? '当前不限次（只受有效期约束）' : '超出后按正常价扣积分'}
            </Text>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <label className="flex flex-col gap-1">
              <Text className="text-xs">时长券总开关</Text>
              <Space>
                <Switch
                  checked={draft?.enabled !== false}
                  onChange={(v) => setDraft((p) => (p ? { ...p, enabled: v } : p))}
                />
                <Text type="secondary" className="text-[11px]">关闭后所有时长券暂停免费</Text>
              </Space>
            </label>
            <label className="flex flex-col gap-1">
              <Text className="text-xs">每用户每天上限（张）</Text>
              <InputNumber
                min={0}
                max={1_000_000}
                className="!w-full"
                placeholder="0 = 不限"
                value={draft?.dailyUserLimit ?? 0}
                onChange={(v) => setDraft((p) => (p ? { ...p, dailyUserLimit: Number(v) || 0 } : p))}
              />
            </label>
            <label className="flex flex-col gap-1">
              <Text className="text-xs">全平台每天上限（张）</Text>
              <InputNumber
                min={0}
                max={1_000_000}
                className="!w-full"
                placeholder="0 = 不限"
                value={draft?.dailyPlatformLimit ?? 0}
                onChange={(v) => setDraft((p) => (p ? { ...p, dailyPlatformLimit: Number(v) || 0 } : p))}
              />
            </label>
            <div className="flex items-end">
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void save()}>
                保存限额
              </Button>
            </div>
          </div>

          <div className="mt-4 border-t border-black/5 pt-3">
            <Text strong className="text-sm"><ThunderboltOutlined className="mr-1.5" />覆盖模型</Text>
            <Paragraph type="secondary" className="!mb-2 !mt-1 !text-[11px]">
              可独立选择时长券覆盖模型，不影响无券用户的每日免费池。
            </Paragraph>
            <Select
              aria-label="时长券覆盖方式"
              className="!mb-2 !w-full"
              value={draft?.modelIds === null ? 'pool' : 'custom'}
              options={[{ value: 'custom', label: '独立选择模型' }, { value: 'pool', label: '跟随每日免费池（兼容旧配置）' }]}
              onChange={(value) => setDraft((current) => current ? { ...current, modelIds: value === 'pool' ? null : covered.map((m) => m.id) } : current)}
            />
            {draft?.modelIds !== null && <Select
              mode="multiple"
              aria-label="选择时长券模型"
              className="!mb-3 !w-full"
              placeholder="选择覆盖模型；留空则不覆盖任何模型"
              value={draft?.modelIds ?? []}
              options={data?.coveredModels.map((m) => ({ value: m.id, label: `${m.name}${m.provider ? ` · ${m.provider}` : ''}` }))}
              onChange={(modelIds: string[]) => setDraft((current) => current ? { ...current, modelIds } : current)}
            />}
            {covered.length === 0 ? (
              <Text type="warning" className="text-xs">当前未选择覆盖模型，时长券暂不可用于生成。</Text>
            ) : (
              <Space size={[6, 6]} wrap>
                {covered.map((m) => (
                  <Tag key={m.id} color="purple" className="!mr-0">
                    {m.name}{m.provider ? ` · ${m.provider}` : ''}
                  </Tag>
                ))}
              </Space>
            )}
          </div>
        </div>
      </Card>

      <Card
        variant="outlined"
        title={<><UserOutlined className="mr-2" />用户时长与用券情况</>}
        extra={
          <Space wrap>
            <Select
              size="small"
              value={query.status}
              style={{ width: 110 }}
              options={[
                { value: 'active', label: '生效中' },
                { value: 'expired', label: '已过期' },
              ]}
              onChange={(status) => setQuery((p) => ({ ...p, status, page: 1 }))}
            />
            <Input.Search
              size="small"
              allowClear
              placeholder="手机号 / 昵称"
              style={{ width: 190 }}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onSearch={(value) => setQuery((p) => ({ ...p, q: value.trim(), page: 1 }))}
            />
          </Space>
        }
      >
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          columns={userColumns}
          dataSource={data?.users.items ?? []}
          pagination={false}
          scroll={{ x: 1000 }}
        />
        <div className="mt-3 flex justify-end">
          <Pagination
            size="small"
            current={data?.users.page ?? query.page}
            pageSize={data?.users.pageSize ?? query.pageSize}
            total={data?.users.total ?? 0}
            showSizeChanger
            pageSizeOptions={[10, 20, 50, 100]}
            onChange={(page, pageSize) => setQuery((p) => ({ ...p, page, pageSize }))}
            showTotal={(total) => `共 ${total} 人`}
          />
        </div>
      </Card>

      <Card variant="outlined" title={<><GiftOutlined className="mr-2" />最近发放记录</>}>
        <Table
          rowKey="id"
          size="small"
          columns={grantColumns}
          dataSource={data?.recentGrants ?? []}
          pagination={false}
          scroll={{ x: 960 }}
        />
      </Card>

      <Drawer
        title={grantUser ? `领取日志 · ${grantUser.nickname || grantUser.phone || grantUser.id.slice(0, 8)}` : '领取日志'}
        open={!!grantUser}
        onClose={() => { setGrantUser(null); setGrantLog(null) }}
        width="min(560px, 100vw)"
        loading={grantLoading && !grantLog}
      >
        <div className="space-y-4">
          <div className="rounded-2xl border border-black/5 bg-white/70 p-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <Text type="secondary" className="text-[11px]">当前剩余</Text>
                <div className="mt-0.5 font-semibold">{grantLog ? formatRemaining(grantLog.user.remainingMinutes) : '—'}</div>
                <Text type="secondary" className="text-[11px]">
                  {grantLog?.user.freeImageUntil ? `至 ${dayjs(grantLog.user.freeImageUntil).format('YYYY-MM-DD HH:mm')}` : '无生效时长'}
                </Text>
              </div>
              <div>
                <Text type="secondary" className="text-[11px]">累计获赠</Text>
                <div className="mt-0.5 font-semibold">{grantLog?.summary.totalGrantedDays ?? '—'} 天</div>
                <Text type="secondary" className="text-[11px]">共 {grantLog?.summary.totalGrants ?? 0} 笔</Text>
              </div>
              <div>
                <Text type="secondary" className="text-[11px]">今日用券</Text>
                <div className="mt-0.5 font-semibold">{grantLog?.summary.usageToday ?? 0} 张</div>
              </div>
              <div>
                <Text type="secondary" className="text-[11px]">近 30 天用券</Text>
                <div className="mt-0.5 font-semibold">{grantLog?.summary.usage30d ?? 0} 张</div>
              </div>
            </div>
            <div className="mt-3 border-t border-black/5 pt-2 text-[11px] text-gray-500">
              最近使用：{grantLog?.summary.lastUsedAt ? dayjs(grantLog.summary.lastUsedAt).format('YYYY-MM-DD HH:mm') : '未使用'}
            </div>
          </div>

          {grantLog?.grants.length === 0 && (
            <div className="rounded-2xl border border-dashed border-black/10 py-10 text-center text-sm text-gray-400">
              暂无领取记录
            </div>
          )}

          <div className="space-y-2">
            {grantLog?.grants.map((g) => (
              <div key={g.id} className="rounded-2xl border border-black/5 bg-white/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Tag color={sourceColors[g.source] || 'default'} className="!mr-0">
                      {sourceLabels[g.source] || g.source}
                    </Tag>
                    <Text className="text-xs text-gray-500">{formatDuration(g.minutes)}</Text>
                  </div>
                  <Text type="secondary" className="text-[11px]">{dayjs(g.createdAt).format('MM-DD HH:mm')}</Text>
                </div>
                <div className="mt-1.5 text-sm">{g.description}</div>
                <div className="mt-1 text-[11px] text-gray-400">
                  生效 {dayjs(g.startsAt).format('MM-DD HH:mm')} → 到期 {dayjs(g.expiresAt).format('MM-DD HH:mm')}
                  {g.operatorName ? ` · 操作人 ${g.operatorName}` : ''}
                </div>
              </div>
            ))}
          </div>

          {grantLog && grantLog.pagination.total > grantLog.pagination.pageSize && (
            <div className="flex justify-center">
              <Pagination
                size="small"
                current={grantLog.pagination.page}
                pageSize={grantLog.pagination.pageSize}
                total={grantLog.pagination.total}
                showSizeChanger
                pageSizeOptions={[10, 20, 50]}
                onChange={(page, pageSize) => {
                  if (grantUser) void openGrantLog(grantUser, page, pageSize)
                }}
                showTotal={(total) => `共 ${total} 笔`}
              />
            </div>
          )}
          <div className="text-[11px] text-gray-400">
            记录每一次到账：公告领取、月度套餐、签到、邀请、管理员代发都会出现在这里。1 天 = 连续 24 小时。
          </div>
        </div>
      </Drawer>
    </div>
  )
}
