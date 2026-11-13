'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import dayjs from 'dayjs'
import {
  Card,
  Table,
  Button,
  Form,
  Input,
  InputNumber,
  Select,
  Modal,
  Popconfirm,
  Typography,
  App,
  Drawer,
  Dropdown,
  Pagination,
  Spin,
  Tag,
  Empty,
} from 'antd'
import {
  DollarOutlined,
  CoffeeOutlined,
  LockOutlined,
  UnlockOutlined,
  HistoryOutlined,
  DeleteOutlined,
  MoreOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { StatusTag, type StatusTone } from '@/components/ui/StatusTag'
import { apiFetch } from '@/lib/api-client'
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy'
import { formatPoints } from '@/lib/pricing'
import { UserLedgerDrawer } from './UserLedgerDrawer'
import { UsageLogDetailDrawer, type UsageLogDetailItem, usageSourceLabels } from './UsageLogDetailDrawer'

const { Text } = Typography

type UserItem = {
  id: string
  phone: string
  email: string | null
  nickname: string | null
  role: 'USER' | 'ADMIN'
  status: 'NORMAL' | 'FROZEN'
  points: number
  beans: number
  billingType: 'POINTS' | 'SUBSCRIPTION'
  subscriptionExpiryAt: string | null
  /** 活动赠送的免费无限生图截止时间（与订阅独立） */
  freeImageUntil: string | null
  securityLevel: 'LOW' | 'HIGH'
  adminVerified: boolean
  securityVerifiedAt: string | null
  /** 微信 OpenID（已绑定时有值） */
  socialUid: string | null
  socialProvider: string | null
  /** 是否已设置密码（微信扫码注册的账号可能没有） */
  hasPassword: boolean
  /**
   * 半成品账号：无手机号 + 无密码。
   * 旧版「微信登录自动建号」的残留，会占住 OpenID 让用户绑不上微信。
   * 用户在安全中心绑微信时会自动回收，这里标出来便于管理员排查。
   */
  isHalfBaked?: boolean
  createdAt: string
  updatedAt: string
}

const roleLabels: Record<string, string> = { USER: '普通用户', ADMIN: '管理员' }
const roleTones: Record<string, StatusTone> = { USER: 'primary', ADMIN: 'warning' }
const statusLabels: Record<string, string> = { NORMAL: '正常', FROZEN: '已冻结' }
const statusTones: Record<string, StatusTone> = { NORMAL: 'success', FROZEN: 'danger' }

export function UsersPanel() {
  const { message, modal } = App.useApp()
  // 使用日志抽屉：默认只看失败记录（成功的量大、排查时才需要）
  const [logUser, setLogUser] = useState<UserItem | null>(null)
  const [logItems, setLogItems] = useState<UsageLogDetailItem[]>([])
  const [logLoading, setLogLoading] = useState(false)
  const [logStatus, setLogStatus] = useState<'all' | 'success' | 'pending' | 'error'>('all')
  const [logPage, setLogPage] = useState(1)
  const [logTotal, setLogTotal] = useState(0)
  const [logDetail, setLogDetail] = useState<UsageLogDetailItem | null>(null)
  const logPageSize = 20

  const openLogs = useCallback(async (u: UserItem, status: 'all' | 'success' | 'pending' | 'error' = 'all', page = 1) => {
    setLogUser(u)
    setLogStatus(status)
    setLogPage(page)
    setLogLoading(true)
    try {
      const params = new URLSearchParams({ userId: u.id, page: String(page), pageSize: String(logPageSize) })
      if (status !== 'all') params.set('status', status)
      const res = await apiFetch<{ items: UsageLogDetailItem[]; total: number }>(`/api/admin/usage-logs?${params.toString()}`)
      if (res.success && res.data) {
        setLogItems(res.data.items)
        setLogTotal(res.data.total)
      } else {
        setLogItems([])
        setLogTotal(0)
      }
    } catch {
      setLogItems([])
      setLogTotal(0)
    } finally { setLogLoading(false) }
  }, [])

  const [users, setUsers] = useState<UserItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [keyword, setKeyword] = useState('')
  const [queryInput, setQueryInput] = useState('')
  const latestRequest = useRef(0)
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined)
  const [securityFilter, setSecurityFilter] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)

  const [editModalOpen, setEditModalOpen] = useState(false)
  const [pointsModalOpen, setPointsModalOpen] = useState(false)
  const [beansModalOpen, setBeansModalOpen] = useState(false)
  const [ledger, setLedger] = useState<{ kind: 'points' | 'beans'; user: UserItem } | null>(null)
  const [beansForm] = Form.useForm()
  const [passwordModalOpen, setPasswordModalOpen] = useState(false)
  const [activeUser, setActiveUser] = useState<UserItem | null>(null)
  const [editForm] = Form.useForm()
  const [pointsForm] = Form.useForm()
  const [passwordForm] = Form.useForm()
  const [saving, setSaving] = useState(false)

  const fetchUsers = useCallback(async () => {
    const requestId = ++latestRequest.current
    setLoading(true)
    try {
      const res = await apiFetch<{ items: UserItem[]; total: number }>('/api/admin/users', {
        params: {
          page: String(page),
          pageSize: String(pageSize),
          keyword: keyword || undefined,
          status: statusFilter,
          securityLevel: securityFilter,
        },
      })
      if (requestId !== latestRequest.current) return
      if (res.success && res.data) {
        setUsers(res.data.items)
        setTotal(res.data.total)
      } else {
        message.error(res.message)
      }
    } catch {
      if (requestId === latestRequest.current) message.error('加载失败')
    } finally {
      if (requestId === latestRequest.current) setLoading(false)
    }
  }, [page, pageSize, keyword, statusFilter, securityFilter, message])

  useEffect(() => {
    // 延后一帧再拉取：避免在 effect 同步体内 setState 触发级联渲染（项目统一写法）
    const timer = window.setTimeout(() => void fetchUsers(), 0)
    return () => { window.clearTimeout(timer); latestRequest.current += 1 }
  }, [fetchUsers])

  const openEditModal = (u: UserItem) => {
    setActiveUser(u)
    editForm.setFieldsValue({
      phone: u.phone,
      nickname: u.nickname,
      role: u.role,
      status: u.status,
      subscriptionDays: undefined,
      freeImageDays: undefined,
    })
    setEditModalOpen(true)
  }

  const saveEdit = async () => {
    if (!activeUser) return
    const values = await editForm.validateFields()
    setSaving(true)
    try {
      const res = await apiFetch(`/api/admin/users/${activeUser.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          ...values,
          // 订阅续期天数：留空不改动，填写则顺延（不赠送积分，积分走「调整积分」）
          subscriptionDays: values.subscriptionDays ?? undefined,
        }),
      })
      if (res.success) {
        message.success(res.message)
        setEditModalOpen(false)
        fetchUsers()
      } else {
        message.error(res.message)
      }
    } catch {
      message.error('操作失败')
    } finally {
      setSaving(false)
    }
  }

  const openPointsModal = (u: UserItem) => {
    setActiveUser(u)
    pointsForm.resetFields()
    setPointsModalOpen(true)
  }

  const openBeansModal = (u: UserItem) => {
    setActiveUser(u)
    beansForm.resetFields()
    setBeansModalOpen(true)
  }

  const saveBeans = async () => {
    if (!activeUser) return
    const values = await beansForm.validateFields()
    setSaving(true)
    try {
      const res = await apiFetch(`/api/admin/users/${activeUser.id}/beans`, {
        method: 'POST',
        body: JSON.stringify(values),
      })
      if (res.success) {
        message.success(res.message)
        setBeansModalOpen(false)
        fetchUsers()
      } else {
        message.error(res.message)
      }
    } catch {
      message.error('操作失败')
    } finally {
      setSaving(false)
    }
  }

  const savePoints = async () => {
    if (!activeUser) return
    const values = await pointsForm.validateFields()
    setSaving(true)
    try {
      const res = await apiFetch(`/api/admin/users/${activeUser.id}/points`, {
        method: 'POST',
        body: JSON.stringify(values),
      })
      if (res.success) {
        message.success(res.message)
        setPointsModalOpen(false)
        fetchUsers()
      } else {
        message.error(res.message)
      }
    } catch {
      message.error('操作失败')
    } finally {
      setSaving(false)
    }
  }

  const openPasswordModal = (u: UserItem) => {
    setActiveUser(u)
    passwordForm.resetFields()
    setPasswordModalOpen(true)
  }

  const savePassword = async () => {
    if (!activeUser) return
    const values = await passwordForm.validateFields()
    setSaving(true)
    try {
      const res = await apiFetch(`/api/admin/users/${activeUser.id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ password: values.password }),
      })
      if (res.success) {
        message.success(res.message)
        setPasswordModalOpen(false)
      } else {
        message.error(res.message)
      }
    } catch {
      message.error('操作失败')
    } finally {
      setSaving(false)
    }
  }

  const handleVerify = async (userId: string) => {
    try {
      const res = await apiFetch(`/api/admin/users/${userId}/verify`, { method: 'POST' })
      if (res.success) {
        message.success(res.message)
        fetchUsers()
      } else {
        message.error(res.message)
      }
    } catch {
      message.error('核验失败')
    }
  }

  const toggleFreeze = async (u: UserItem) => {
    const nextStatus = u.status === 'NORMAL' ? 'FROZEN' : 'NORMAL'
    try {
      const res = await apiFetch(`/api/admin/users/${u.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: nextStatus }),
      })
      if (res.success) {
        message.success(res.message)
        fetchUsers()
      } else {
        message.error(res.message)
      }
    } catch {
      message.error('操作失败')
    }
  }

  // 删除用户：不可逆，二次确认里明确提示会连带清除其数据
  const deleteUser = async (u: UserItem) => {
    try {
      const res = await apiFetch(`/api/admin/users/${u.id}`, { method: 'DELETE' })
      if (res.success) {
        message.success(res.message)
        fetchUsers()
      } else {
        message.error(res.message)
      }
    } catch {
      message.error('删除失败')
    }
  }

  // 解绑微信：释放 OpenID，解决「该微信已绑定其他账号」死锁
  const unbindWechat = async (u: UserItem) => {
    try {
      const res = await apiFetch(`/api/admin/users/${u.id}`, {
        method: 'PUT',
        body: JSON.stringify({ unbindWechat: true }),
      })
      if (res.success) {
        message.success('已解绑微信')
        fetchUsers()
      } else {
        message.error(res.message)
      }
    } catch {
      message.error('解绑失败')
    }
  }

  // 取消订阅（单独操作；已发放的订阅积分保留）
  const cancelSubscription = async (u: UserItem) => {
    try {
      const res = await apiFetch(`/api/admin/users/${u.id}`, {
        method: 'PUT',
        body: JSON.stringify({ cancelSubscription: true }),
      })
      if (res.success) {
        message.success(res.message)
        setEditModalOpen(false)
        fetchUsers()
      } else {
        message.error(res.message)
      }
    } catch {
      message.error('操作失败')
    }
  }


  const actionsFor = (user: UserItem) => (
    <div className="flex flex-wrap items-center gap-1 [&_.ant-btn]:max-lg:min-h-9 [&_.ant-btn]:max-lg:px-3">
      <Button size="small" onClick={() => openEditModal(user)}>编辑</Button>
      <Dropdown trigger={['click']} menu={{ items: [{ key: 'points', label: '调整积分', icon: <DollarOutlined /> }, { key: 'beans', label: '调整视频豆', icon: <CoffeeOutlined /> }], onClick: ({ key }) => key === 'points' ? openPointsModal(user) : openBeansModal(user) }}>
        <Button size="small">调账</Button>
      </Dropdown>
      <Dropdown trigger={['click']} menu={{
        items: [
          { key: 'package', label: '核销线下套餐', icon: <DollarOutlined /> },
          { key: 'logs', label: '使用日志', icon: <HistoryOutlined /> },
          { key: 'points-ledger', label: '积分账本', icon: <HistoryOutlined /> },
          { key: 'beans-ledger', label: '视频豆账本', icon: <HistoryOutlined /> },
          ...(user.securityLevel === 'LOW' && !user.adminVerified ? [{ key: 'verify', label: '人工核验' }] : []),
          { type: 'divider' },
          { key: 'password', label: '重置密码', icon: <LockOutlined /> },
          { key: 'wechat', label: '解绑微信', disabled: !user.socialUid },
          { key: 'freeze', label: user.status === 'NORMAL' ? '冻结账号' : '解冻账号', danger: user.status === 'NORMAL', icon: user.status === 'NORMAL' ? <LockOutlined /> : <UnlockOutlined /> },
          { type: 'divider' },
          { key: 'delete', label: '删除用户', danger: true, icon: <DeleteOutlined /> },
        ],
        onClick: ({ key }) => {
          if (key === 'logs') void openLogs(user)
          if (key === 'points-ledger') setLedger({ kind: 'points', user })
          if (key === 'beans-ledger') setLedger({ kind: 'beans', user })
          if (key === 'password') openPasswordModal(user)
          if (key === 'verify') modal.confirm({ title: '确认人工核验通过？', content: user.nickname || user.phone || user.id, onOk: () => handleVerify(user.id) })
          if (key === 'wechat') modal.confirm({ title: '确认解绑微信？', content: '解绑后，该微信可以绑定其他账号。', onOk: () => unbindWechat(user) })
          if (key === 'freeze') modal.confirm({ title: user.status === 'NORMAL' ? '确认冻结这个账号？' : '确认解冻这个账号？', content: user.nickname || user.phone || user.id, onOk: () => toggleFreeze(user) })
          if (key === 'delete') modal.confirm({ title: '确认删除这个用户？', content: '此操作不可恢复：积分流水、生成记录、素材及邀请关系会一并删除。', okText: '确认删除', okButtonProps: { danger: true }, onOk: () => deleteUser(user) })
        },
      }}><Button size="small" icon={<MoreOutlined />} aria-label={`更多操作 ${user.nickname || user.phone || user.id}`}>更多</Button></Dropdown>
    </div>
  )

  const columns: ColumnsType<UserItem> = [
    {
      title: '用户', width: 240,
      render: (_, user) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5"><span className="font-medium text-foreground">{user.nickname || '未设置昵称'}</span><StatusTag tone={roleTones[user.role]}>{roleLabels[user.role]}</StatusTag>{user.isHalfBaked && <StatusTag tone="warning">待完善</StatusTag>}</div>
          <div className="mt-1 text-xs text-text-muted">{user.phone || '未绑定手机'}</div>
          <div className="mt-1 truncate text-xs text-text-secondary" title={user.email ?? undefined}>{user.email || '未绑定邮箱'}</div>
        </div>
      ),
    },
    { title: '余额', width: 145, render: (_, user) => <div className="space-y-1 text-xs tabular-nums"><p><span className="mr-2 text-text-secondary">积分</span><span className="font-medium text-accent">{formatPoints(user.points)}</span></p><p><span className="mr-2 text-text-secondary">视频豆</span>{formatPoints(user.beans)}</p></div> },
    { title: '账号状态', width: 170, render: (_, user) => <div className="space-y-1.5"><StatusTag tone={statusTones[user.status]}>{statusLabels[user.status]}</StatusTag><p className="text-xs text-text-secondary">{user.securityVerifiedAt ? '安全验证已通过' : user.securityLevel === 'HIGH' ? '高等级 · 待安全验证' : user.adminVerified ? '已人工核验' : '待核验'}</p></div> },
    { title: '权益', width: 155, render: (_, user) => <div className="space-y-1 text-xs text-text-muted"><p>{user.billingType === 'SUBSCRIPTION' && user.subscriptionExpiryAt && dayjs(user.subscriptionExpiryAt).isAfter(dayjs()) ? `订阅至 ${dayjs(user.subscriptionExpiryAt).format('YYYY-MM-DD')}` : '无有效订阅'}</p><p className={user.freeImageUntil && dayjs(user.freeImageUntil).isAfter(dayjs()) ? 'text-accent' : 'text-text-secondary'}>{user.freeImageUntil && dayjs(user.freeImageUntil).isAfter(dayjs()) ? `生图至 ${dayjs(user.freeImageUntil).format('MM-DD HH:mm')}` : '无生效生图时长'}</p></div> },
    { title: '注册时间', dataIndex: 'createdAt', width: 140, render: (value: string) => <span className="text-xs text-text-secondary">{dayjs(value).format('YYYY-MM-DD HH:mm')}</span> },
    { title: '操作', width: 195, fixed: 'right', render: (_, user) => actionsFor(user) },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[24px] border border-accent/10 bg-white/80 p-5">
        <div><h2 className="text-lg font-semibold text-foreground">用户管理</h2><p className="mt-1 text-xs text-text-muted">共匹配 {total} 位用户 · 余额、订阅与生图时长分开查看。</p></div>
        <Button icon={<ReloadOutlined />} onClick={() => void fetchUsers()}>刷新列表</Button>
      </div>
      <Card variant="outlined">
        <div className="grid gap-3 md:grid-cols-[minmax(180px,1fr)_135px_135px_auto]">
          <Input.Search aria-label="搜索用户" placeholder="手机号、邮箱或昵称" allowClear value={queryInput} onChange={(event) => setQueryInput(event.target.value)} onSearch={(value) => { setPage(1); setKeyword(value.trim()); if (page === 1 && value.trim() === keyword) void fetchUsers() }} />
          <Select aria-label="账号状态" placeholder="全部状态" allowClear value={statusFilter} onChange={(value) => { setStatusFilter(value); setPage(1) }} options={[{ value: 'NORMAL', label: '正常' }, { value: 'FROZEN', label: '已冻结' }]} />
          <Select aria-label="验证状态" placeholder="全部验证状态" allowClear value={securityFilter} onChange={(value) => { setSecurityFilter(value); setPage(1) }} options={[{ value: 'LOW', label: '低安全等级' }, { value: 'HIGH', label: '高安全等级' }]} />
          <Button onClick={() => { setQueryInput(''); setKeyword(''); setStatusFilter(undefined); setSecurityFilter(undefined); setPage(1) }}>重置</Button>
        </div>
        <Table className="mt-4 hidden lg:block" dataSource={users} columns={columns} rowKey="id" loading={loading} size="middle" scroll={{ x: 1030 }} expandable={{ expandedRowRender: (user) => <div className="grid gap-3 p-2 text-xs sm:grid-cols-2"><div>账号 ID：<Text copyable>{user.id}</Text></div><div>密码：{user.hasPassword ? '已设置' : '未设置'}</div><div className="break-all">邮箱：{user.email || '未绑定'}</div></div> }} pagination={{ current: page, pageSize, total, showSizeChanger: true, showTotal: (count) => `共 ${count} 位`, onChange: (next, size) => { setPage(next); setPageSize(size) } }} />
        <div className="mt-4 lg:hidden">
          <Spin spinning={loading}>
            <div className="space-y-3">
              {users.map((user) => <div key={user.id} className="rounded-2xl border border-border p-4"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="font-medium">{user.nickname || '未设置昵称'}</p><p className="mt-1 break-all text-xs text-text-secondary">{user.phone || user.email || user.id}</p></div><StatusTag tone={statusTones[user.status]}>{statusLabels[user.status]}</StatusTag></div><div className="my-4 flex flex-wrap gap-x-5 gap-y-2 text-xs"><span>积分 <strong className="text-accent">{formatPoints(user.points)}</strong></span><span>视频豆 <strong>{formatPoints(user.beans)}</strong></span><span>{roleLabels[user.role]}</span></div>{actionsFor(user)}</div>)}
              {!loading && users.length === 0 && <Empty description="没有匹配的用户" />}
            </div>
          </Spin>
          <Pagination className="mt-4" simple current={page} pageSize={pageSize} total={total} onChange={setPage} />
        </div>
      </Card>

      {/* 使用日志抽屉：一眼看状态/模型/扣费，细节再进调用详情 */}
      <Drawer
        title={logUser ? `使用日志 · ${logUser.nickname || logUser.phone}` : '使用日志'}
        open={!!logUser}
        onClose={() => { setLogUser(null); setLogDetail(null) }}
        width="min(760px, 100vw)"
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {([
            ['all', '全部'],
            ['success', '成功'],
            ['pending', '进行中'],
            ['error', '失败'],
          ] as const).map(([value, label]) => (
            <Tag.CheckableTag
              key={value}
              checked={logStatus === value}
              onChange={() => { if (logUser) void openLogs(logUser, value, 1) }}
            >
              {label}
            </Tag.CheckableTag>
          ))}
          <Text type="secondary" className="ml-auto text-xs">共 {logTotal} 条</Text>
        </div>
        <p className="mb-3 text-[11px] leading-relaxed text-text-secondary">
          每次模型调用一条：看状态、模型来源、扣费和耗时；进行中表示上游已受理、仍在生成。点「查看请求 / 返回」看任务号和原始请求。
        </p>

        {logLoading ? (
          <Text type="secondary">加载中…</Text>
        ) : logItems.length === 0 ? (
          <Empty description={logStatus === 'all' ? '暂无调用记录' : `暂无${logStatus === 'error' ? '失败' : logStatus === 'pending' ? '进行中' : '成功'}记录`} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <div className="space-y-2">
            {logItems.map((log) => {
              const duration = log.durationMs == null ? '-' : log.durationMs < 1000 ? `${log.durationMs}ms` : `${(log.durationMs / 1000).toFixed(1)}s`
              const cost = (log.beansDeducted ?? 0) > 0
                ? `${formatPoints(log.beansDeducted ?? 0)} 豆`
                : `${formatPoints(log.pointsDeducted ?? 0)} 积分`
              return (
                <div key={log.id} className="rounded-xl border border-black/6 bg-white/70 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium">{log.model?.name || log.modelId || '未知模型'}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-secondary">
                        <span>{dayjs(log.createdAt).format('MM-DD HH:mm:ss')}</span>
                        <span>{usageSourceLabels[log.source ?? ''] || log.source || '—'}{log.nodeLabel ? ` · ${log.nodeLabel}` : ''}</span>
                        <span>扣费 {cost}</span>
                        <span>耗时 {duration}</span>
                        {log.tokensUsed != null && <span>Tokens {log.tokensUsed}</span>}
                      </div>
                    </div>
                    <StatusTag tone={log.statusCode === 202 ? 'accent' : log.statusCode === 200 ? 'success' : 'danger'}>
                      {log.statusCode === 202 ? '进行中' : log.statusCode === 200 ? '成功' : `失败 ${log.statusCode ?? ''}`}
                    </StatusTag>
                  </div>
                  {log.taskProgress && <div className="mt-2 truncate text-[11px] text-text-muted">{log.taskProgress}</div>}
                  {log.taskId && <Text copyable={{ text: log.taskId }} className="mt-1 block truncate font-mono text-[10px] text-text-disabled">任务 {log.taskId}</Text>}
                  {log.errorMessage && <div className="mt-2 break-all rounded-lg bg-red-50/70 px-2 py-1 text-[11px] text-red-500">{log.errorMessage}</div>}
                  <div className="mt-2 text-right">
                    <Button type="link" size="small" onClick={() => setLogDetail(log)}>查看请求 / 返回 →</Button>
                  </div>
                </div>
              )
            })}
            <div className="flex justify-end pt-2">
              <Pagination size="small" current={logPage} pageSize={logPageSize} total={logTotal} showSizeChanger={false} onChange={(next) => { if (logUser) void openLogs(logUser, logStatus, next) }} />
            </div>
          </div>
        )}
      </Drawer>

      <UsageLogDetailDrawer log={logDetail} onClose={() => setLogDetail(null)} />

      {/* Edit Modal */}
      <Drawer
        title={activeUser ? `编辑用户 · ${activeUser.nickname || activeUser.phone || activeUser.id}` : '编辑用户'}
        open={editModalOpen}
        onClose={() => { if (!saving) setEditModalOpen(false) }}
        footer={<div className="flex justify-end gap-2"><Button disabled={saving} onClick={() => setEditModalOpen(false)}>取消</Button><Button type="primary" loading={saving} onClick={() => void saveEdit()}>保存修改</Button></div>}
        width="min(640px, 100vw)"
      >
        <Form form={editForm} layout="vertical" className="mt-2 grid gap-x-4 sm:grid-cols-2">
          <Form.Item
            name="phone"
            label="手机号（人工绑定/改绑，清空即解绑）"
            extra="用于新号段未收录等无法自助绑定的情况"
          >
            <Input placeholder="11 位手机号，留空表示未绑定" maxLength={11} allowClear />
          </Form.Item>
          <Form.Item name="nickname" label="昵称">
            <Input placeholder="用户昵称" />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select options={[{ value: 'USER', label: '普通用户' }, { value: 'ADMIN', label: '管理员' }]} />
          </Form.Item>
          <Form.Item name="status" label="状态" rules={[{ required: true }]}>
            <Select options={[{ value: 'NORMAL', label: '正常' }, { value: 'FROZEN', label: '已冻结' }]} />
          </Form.Item>

          {/* 订阅管理：续期走保存按钮（顺延不送积分，赠送积分用「调整积分」）；取消订阅单独操作 */}
          <div className="rounded-2xl border border-border bg-surface-secondary p-4 sm:col-span-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <Text strong className="text-sm">订阅管理</Text>
              {activeUser && (() => {
                const active =
                  activeUser.billingType === 'SUBSCRIPTION' &&
                  activeUser.subscriptionExpiryAt &&
                  dayjs(activeUser.subscriptionExpiryAt).isAfter(dayjs())
                if (active) {
                  return (
                    <span className="inline-flex items-center rounded-full bg-warning-bg px-2 py-0.5 text-xs font-medium text-warning-strong">
                      生效中 · 至 {dayjs(activeUser.subscriptionExpiryAt).format('YYYY-MM-DD')}
                    </span>
                  )
                }
                return <Text className="text-xs text-text-disabled">未订阅</Text>
              })()}
            </div>
            <div className="flex items-end gap-3">
              <Form.Item
                name="subscriptionDays"
                label="续期天数"
                className="mb-0 flex-1"
                extra="保存时生效：到期日顺延 N 天（不赠送积分）"
                rules={[
                  {
                    validator: (_, value) =>
                      value == null || (Number.isInteger(value) && value >= 1 && value <= 3650)
                        ? Promise.resolve()
                        : Promise.reject(new Error('需为 1~3650 的整数')),
                  },
                ]}
              >
                <InputNumber min={1} max={3650} className="w-full" placeholder="留空则不改动" />
              </Form.Item>
              {activeUser && (activeUser.billingType === 'SUBSCRIPTION' || activeUser.subscriptionExpiryAt) && (
                <Popconfirm
                  title="确认取消该用户的订阅？"
                  description="已发放的订阅积分保留不回收"
                  okText="取消订阅"
                  cancelText="再想想"
                  onConfirm={() => cancelSubscription(activeUser)}
                >
                  <Button danger>取消订阅</Button>
                </Popconfirm>
              )}
            </div>
          </div>

          {/* 活动权益：免费无限生图（与订阅独立，取较晚者生效） */}
          <div className="mt-4 rounded-2xl border border-border bg-surface-secondary p-4 sm:col-span-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <Text strong className="text-sm">生图时长权益</Text>
              {activeUser?.freeImageUntil && dayjs(activeUser.freeImageUntil).isAfter(dayjs()) ? (
                <span className="inline-flex items-center rounded-full bg-warning-bg px-2 py-0.5 text-xs font-medium text-warning-strong">
                  生效中 · 至 {dayjs(activeUser.freeImageUntil).format('YYYY-MM-DD HH:mm')}
                </span>
              ) : (
                <Text className="text-xs text-text-disabled">未生效</Text>
              )}
            </div>
            <Form.Item
              name="freeImageDays"
              label="顺延天数"
              className="mb-0"
              extra="体验版 3 天 / 专业版 5 天 / 旗舰版 10 天；已有时长自动顺延，仅指定免费模型适用（1 天 = 24 小时）"
              rules={[
                {
                  validator: (_, value) =>
                    value == null || (Number.isInteger(value) && value >= 1 && value <= 3650)
                      ? Promise.resolve()
                      : Promise.reject(new Error('需为 1~3650 的整数')),
                },
              ]}
            >
              <InputNumber min={1} max={3650} className="w-full" placeholder="留空则不改动" />
            </Form.Item>
          </div>
        </Form>
      </Drawer>

      {/* Points Modal */}
      <Modal
        title={`调整视频豆 - ${activeUser?.nickname || activeUser?.phone || ''}`}
        open={beansModalOpen}
        onCancel={() => setBeansModalOpen(false)}
        onOk={saveBeans}
        confirmLoading={saving}
        width={440}
      >
        <Form form={beansForm} layout="vertical" className="mt-4">
          <Form.Item label="当前视频豆">
            <Input value={activeUser?.beans} disabled />
          </Form.Item>
          <Form.Item
            name="amount"
            label="调整数量"
            extra="正数为增加，负数为扣减；豆与积分是两套独立额度，不互相折算"
            rules={[
              { required: true, message: '请输入调整数量' },
              {
                validator: (_, value) =>
                  Number.isFinite(value) && value !== 0
                    ? Promise.resolve()
                    : Promise.reject(new Error('必须为非零数值')),
              },
            ]}
          >
            <InputNumber className="w-full" step={10} precision={2} placeholder="例如 500 或 -100" />
          </Form.Item>
          <Form.Item name="reason" label="调整原因">
            <Input.TextArea rows={3} placeholder="用于记录到视频豆变动日志" />
          </Form.Item>
        </Form>
      </Modal>

      <UserLedgerDrawer
        key={`${ledger?.kind ?? 'points'}-${ledger?.user.id ?? ''}-${!!ledger}`}
        kind={ledger?.kind ?? 'points'}
        user={ledger?.user ?? null}
        open={!!ledger}
        onClose={() => setLedger(null)}
      />

      <Modal
        title={`调整积分 - ${activeUser?.nickname || activeUser?.phone || ''}`}
        open={pointsModalOpen}
        onCancel={() => setPointsModalOpen(false)}
        onOk={savePoints}
        confirmLoading={saving}
        width={440}
      >
        <Form form={pointsForm} layout="vertical" className="mt-4">
          <Form.Item label="当前积分">
            <Input value={activeUser?.points} disabled />
          </Form.Item>
          <Form.Item
            name="amount"
            label="调整数量"
            extra="正数为增加，负数为扣减；支持小数（如 0.6）"
            rules={[
              { required: true, message: '请输入调整数量' },
              {
                validator: (_, value) =>
                  Number.isFinite(value) && value !== 0
                    ? Promise.resolve()
                    : Promise.reject(new Error('必须为非零数值')),
              },
            ]}
          >
            <InputNumber className="w-full" step={0.1} precision={2} placeholder="例如 100 或 -50" />
          </Form.Item>
          <Form.Item name="reason" label="调整原因">
            <Input.TextArea rows={3} placeholder="用于记录到积分变动日志" />
          </Form.Item>
        </Form>
      </Modal>

      {/* Reset Password Modal */}
      <Modal
        title={`重置密码 - ${activeUser?.nickname || activeUser?.phone || ''}`}
        open={passwordModalOpen}
        onCancel={() => setPasswordModalOpen(false)}
        onOk={savePassword}
        confirmLoading={saving}
        width={440}
      >
        <Form form={passwordForm} layout="vertical" className="mt-4">
          <Form.Item
            name="password"
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: PASSWORD_MIN_LENGTH, message: `密码长度至少为${PASSWORD_MIN_LENGTH}位` },
            ]}
          >
            <Input.Password placeholder="至少6位" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
