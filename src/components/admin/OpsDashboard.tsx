'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, Row, Col, Statistic, Table, Tag, Typography, Select, Empty, Button, App, Switch, Segmented, Modal, Pagination } from 'antd'
import {
  UserOutlined,
  TeamOutlined,
  FallOutlined,
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  DatabaseOutlined,
  RocketOutlined,
  ThunderboltOutlined,
  PictureOutlined,
  VideoCameraOutlined,
  SoundOutlined,
  FileTextOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
} from 'recharts'
import type { ColumnsType } from 'antd/es/table'
import { StatusTag, type StatusTone } from '@/components/ui/StatusTag'
import { ImageLightbox } from '@/components/ui/ImageLightbox'
import { ModelPerfPanel } from '@/components/admin/ModelPerfPanel'
import { UsageLogDetailDrawer, usageSourceLabels } from '@/components/admin/UsageLogDetailDrawer'
import { apiFetch } from '@/lib/api-client'
import { parseOutput } from '@/lib/output-view'
import { kindFromModelType, mediaLabel } from '@/lib/media-kinds'
import type { MediaKind } from '@/lib/media-kinds'
import { AnimatedCounter } from '@/components/ui/fx'
import { SettingsWorkspace } from '@/components/layout/SettingsWorkspace'
import dayjs from 'dayjs'

const { Text } = Typography

type StatsData = {
  totalUsers: number
  activeUsersToday: number
  pointsDistributedToday: number
  pointsConsumedToday: number
  apiCallsToday: { total: number; success: number; error: number }
  topModels: { modelId: string; name: string; type: string; count: number }[]
  dailyUsage: { date: string; total: number; success: number; error: number }[]
  userGrowth: { date: string; count: number }[]
  pointsBreakdown: { type: string; amount: number }[]
  pointsTrend: { date: string; income: number; expense: number }[]
  modelStats: { modelId: string; name: string; type: string; calls: number; cost: number; tokens: number; errors: number; errorRate: number }[]
  generationStats: {
    images: { total: number; success: number; failed: number; pending: number; failedRate: number; expired: number }
    // beansSpent：视频按豆计费，pointsDeducted 恒为 0 —— 单独给出已消耗豆，否则面板显示「消耗 0」
    videos: { total: number; success: number; failed: number; pending: number; failedRate: number; expired: number; beansSpent: number }
  }
  /** LLM token 用量（近 7 天 / 今日）——判断大模型调用规模，与图/视频的「任务型」分开看 */
  llmTokenStats: { total: number; calls: number; today: number }
  cardKeyStats: { total: number; byStatus: { status: string; count: number }[] }
  contentStats: { canvasWorkflows: number; announcements: number; agents: number }
  recentPointsLogs: {
    id: string
    userId: string
    user: { id: string; phone: string; nickname: string | null } | null
    amount: number
    type: string
    description: string | null
    createdAt: string
  }[]
}

type SystemStatusData = {
  server: { rss: number; heapUsed: number; heapTotal: number; /** 应用进程运行时长（秒） */ uptime: number; /** 宿主机开机时长（秒），仅参考 */ hostUptime?: number; loadavg: number[]; dbOk: boolean; modelCount: number; /** Redis 是否可用（Q-D49，只服务公众号验证码登录） */ redisOk?: boolean; redisError?: string | null }
  providers: { id: string; name: string; code: string; isActive: boolean; hasKey: boolean }[]
  recentErrors: { kind: string; model: string; statusCode: number; error: string | null; createdAt: string }[]
  /** 进程级错误落盘（lib/error-sink）：路由 500 / 裸 Error / 5xx，重启后仍可回查 */
  appErrors?: { ts: string; scope: string; message: string; stack?: string; path?: string }[]
  /** 资金健康（30 天窗口，Q-D09②） */
  moneyHealth?: {
    openHolds: number
    stuckRunningTasks: number
    chargesWithoutRunId30d: number
    orphanCharges30d: { count: number; points: number }
  }
}

type UsageLogItem = {
  id: string
  userId: string
  user: { id: string; phone: string; nickname: string | null } | null
  modelId: string
  model: { id: string; name: string; type: string } | null
  tokensUsed: number | null
  pointsDeducted: number
  /** 视频豆扣费（视频模型按豆计费、pointsDeducted 恒为 0） */
  beansDeducted?: number
  statusCode: number | null
  errorMessage: string | null
  durationMs: number | null
  submissionDurationMs?: number | null
  confirmationDurationMs?: number | null
  /** 调用来源：api / canvas / workflow / copilot */
  source: string | null
  /** 节点/步骤名（如「第3格」「细节特写」） */
  nodeLabel: string | null
  runId?: string | null
  /** 产物模态（写入时确定）：'image' | 'video' | 'audio' | 'text' | null */
  outputKind?: string | null
  /** 上游异步任务 ID（任务型调用才有）：后台按任务排查的入口 */
  taskId?: string | null
  /** 任务型调用的进度描述（如「排队中 2/4」「生成中」），轮询时回填 */
  taskProgress?: string | null
  /** 请求详情（脱敏 JSON 字符串） */
  requestJson: string | null
  /** 返回详情（脱敏 JSON 字符串） */
  responseJson: string | null
  createdAt: string
}

const typeLabels: Record<string, string> = { TEXT: '纯语言模型', VISION: '多模态读图模型', IMAGE: '生图模型', VIDEO: '视频模型', AUDIO: '音频模型' }
const pieColors = ['var(--primary)', 'var(--success)', 'var(--warning)', 'var(--accent)', 'var(--danger)']

// 产物缩略图的解析已收口到 lib/output-view（按 kind 统一分发），
// 不再在这里写死「只认图片」。

const pointsLogTypeLabels: Record<string, { text: string; tone: StatusTone }> = {
  RECHARGE: { text: '充值', tone: 'success' },
  DEDUCTION: { text: '消耗', tone: 'primary' },
  SUBSCRIPTION: { text: '订阅', tone: 'accent' },
  ADMIN_ADJUST: { text: '管理调整', tone: 'warning' },
}

export function OpsDashboard() {
  const { message } = App.useApp()
  const [stats, setStats] = useState<StatsData | null>(null)
  const [loadingStats, setLoadingStats] = useState(false)
  const [usageLogs, setUsageLogs] = useState<UsageLogItem[]>([])
  const [usageTotal, setUsageTotal] = useState(0)
  const [usagePage, setUsagePage] = useState(1)
  const [usageStatus, setUsageStatus] = useState<string | undefined>(undefined)
  const [usageModel, setUsageModel] = useState<string | undefined>(undefined)
  /** 调用形态：task=任务型（图/视频/音频） / llm=会话型（大语言模型） */
  const [usageForm, setUsageForm] = useState<'task' | 'llm'>('task')
  const [loadingUsage, setLoadingUsage] = useState(false)
  const [systemStatus, setSystemStatus] = useState<SystemStatusData | null>(null)
  const [loadingSystem, setLoadingSystem] = useState(false)
  // 系统健康自动刷新开关（默认关）：内存/负载是波动量，需要时就地刷新，
  // 不需要时别让每 30s 一次的请求白白增加服务器负担。
  const [sysAuto, setSysAuto] = useState(false)
  /** 当前页签（用于「系统健康自动刷新」只在停留该系统页时生效） */
  const [activeTab, setActiveTab] = useState('overview')
  const handleTabChange = useCallback((key: string) => setActiveTab(key), [])
  const [testingProvider, setTestingProvider] = useState<string | null>(null)
  const [providerResults, setProviderResults] = useState<Record<string, { ok: boolean; message: string }>>({})
  const [assetCleanup, setAssetCleanup] = useState<{ expiredCount: number; expiredBytes: number } | null>(null)
  const [cleaningAssets, setCleaningAssets] = useState(false)
  /** 调用详情抽屉：看某次调用的请求 / 返回原文 */
  const [selectedDetailLog, setDetailLog] = useState<UsageLogItem | null>(null)
  const detailLog = selectedDetailLog ? usageLogs.find((log) => log.id === selectedDetailLog.id) || selectedDetailLog : null
  /** 调用记录产物预览：图片走统一灯箱，视频/音频走独立播放弹窗 */
  const [previewMedia, setPreviewMedia] = useState<{ url: string; kind: MediaKind } | null>(null)

  const pageSize = 10

  const fetchStats = useCallback(async () => {
    setLoadingStats(true)
    try {
      const res = await apiFetch<StatsData>('/api/admin/stats')
      if (res.success && res.data) setStats(res.data)
    } catch { /* silent */ }
    finally { setLoadingStats(false) }
  }, [])

  const fetchUsageLogs = useCallback(async (page: number, status?: string, modelId?: string, form?: 'task' | 'llm') => {
    setLoadingUsage(true)
    try {
      const res = await apiFetch<{ items: UsageLogItem[]; total: number }>('/api/admin/usage-logs', {
        params: {
          page: String(page),
          pageSize: String(pageSize),
          status,
          modelId,
          form,
        },
      })
      if (res.success && res.data) {
        setUsageLogs(res.data.items)
        setUsageTotal(res.data.total)
      }
    } catch { /* silent */ }
    finally { setLoadingUsage(false) }
  }, [])

  const fetchSystemStatus = useCallback(async () => {
    setLoadingSystem(true)
    try {
      const res = await apiFetch<SystemStatusData>('/api/admin/system-status')
      if (res.success && res.data) setSystemStatus(res.data)
    } catch { /* silent */ }
    finally { setLoadingSystem(false) }
  }, [])

  // 系统健康自动刷新：仅在「系统健康」页签且开关打开时，每 30s 拉一次；
  // 离开页签/关闭开关立即清定时器（不给服务器留后台轮询）。
  useEffect(() => {
    if (!sysAuto || activeTab !== 'system') return
    const id = window.setInterval(() => { void fetchSystemStatus() }, 30000)
    return () => window.clearInterval(id)
  }, [sysAuto, activeTab, fetchSystemStatus])

  useEffect(() => {
    if (activeTab !== 'logs' || !usageLogs.some((log) => log.statusCode === 202)) return
    const timer = window.setInterval(() => {
      if (!document.hidden) void fetchUsageLogs(usagePage, usageStatus, usageModel, usageForm)
    }, 10000)
    return () => window.clearInterval(timer)
  }, [activeTab, usageLogs, usagePage, usageStatus, usageModel, usageForm, fetchUsageLogs])

  const testProvider = useCallback(async (id: string) => {
    setTestingProvider(id)
    setProviderResults((prev) => ({ ...prev, [id]: { ok: false, message: '测试中…' } }))
    try {
      const res = await apiFetch(`/api/admin/providers/${id}/test`, { method: 'POST' })
      setProviderResults((prev) => ({ ...prev, [id]: { ok: res.success, message: res.message || (res.success ? '连通正常' : '连通失败') } }))
    } catch {
      setProviderResults((prev) => ({ ...prev, [id]: { ok: false, message: '请求失败' } }))
    } finally { setTestingProvider(null) }
  }, [])

  const fetchAssetCleanup = useCallback(async () => {
    try {
      const res = await apiFetch<{ expiredCount: number; expiredBytes: number }>('/api/admin/assets-cleanup')
      if (res.success && res.data) setAssetCleanup(res.data)
    } catch { /* silent */ }
  }, [])

  const runAssetCleanup = useCallback(async () => {
    setCleaningAssets(true)
    try {
      const res = await apiFetch('/api/admin/assets-cleanup', { method: 'POST' })
      if (res.success) {
        message.success(res.message || '清理完成')
        fetchAssetCleanup()
      } else {
        message.error(res.message || '清理失败')
      }
    } catch {
      message.error('清理失败')
    } finally {
      setCleaningAssets(false)
    }
  }, [fetchAssetCleanup, message])

  // 统一在 effect 里用 setTimeout 退出同步栈，避免「effect 内同步 setState」告警
  useEffect(() => {
    const t = window.setTimeout(() => {
      void fetchStats()
      void fetchSystemStatus()
      void fetchUsageLogs(usagePage, usageStatus, usageModel, usageForm)
      void fetchAssetCleanup()
    }, 0)
    return () => window.clearTimeout(t)
  }, [fetchStats, fetchSystemStatus, fetchUsageLogs, fetchAssetCleanup, usagePage, usageStatus, usageModel, usageForm])

  const pieData = (stats?.topModels || []).map((m) => ({ name: m.name, value: m.count }))

  // ===== 调用记录列 · 共用段 =====
  // 主表只保留扫一眼就能判断的字段；任务号、请求/返回和完整进度放进详情抽屉，
  // 避免 9 列表格在桌面横向滚动、手机完全没法看。
  const statusNode = (code: number | null) => {
    if (code === 202) return <StatusTag tone="accent">进行中</StatusTag>
    return code === 200
      ? <StatusTag tone="success" icon={<CheckCircleOutlined />}>成功</StatusTag>
      : <StatusTag tone="danger" icon={<CloseCircleOutlined />}>{code ?? '异常'}</StatusTag>
  }

  const costNode = (row: UsageLogItem) =>
    (row.beansDeducted ?? 0) > 0 ? (
      <Text className="font-mono text-xs text-amber-600">{Number(row.beansDeducted).toFixed(2)} 豆</Text>
    ) : (
      <Text className="font-mono text-xs">{Number(row.pointsDeducted ?? 0).toFixed(2)} 积分</Text>
    )

  const durationNode = (row: UsageLogItem) => (
    <div title={row.submissionDurationMs != null ? '提交耗时不等于生成耗时；确认总用时包含等待轮询确认的时间' : undefined}>
      <Text className="font-mono text-xs">{row.submissionDurationMs != null ? '提交 ' : ''}{row.durationMs == null ? '-' : row.durationMs < 1000 ? `${row.durationMs}ms` : `${(row.durationMs / 1000).toFixed(1)}s`}</Text>
      {row.confirmationDurationMs != null && <Text className="block text-[10px] text-text-disabled">确认 {(row.confirmationDurationMs / 1000).toFixed(1)}s</Text>}
    </div>
  )

  const outputNode = (row: UsageLogItem) => {
    const declared = row.outputKind as MediaKind | 'text' | null | undefined
    const modelKind = declared === 'text'
      ? null
      : (declared as MediaKind | undefined) ?? kindFromModelType(row.model?.type)
    const out = parseOutput(row.responseJson, modelKind)
    if (!out.kind || !out.url) {
      return (
        <div className="grid size-10 place-items-center rounded-md border border-black/8 bg-black/[0.03]" title={declared === 'text' || out.kind === null ? '文本产物' : '产物不可预览'}>
          {declared === 'text' || (out.kind === null && row.statusCode === 200) ? <FileTextOutlined className="text-black/25" /> : <PictureOutlined className="text-black/25" />}
        </div>
      )
    }
    if (out.kind === 'image') {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={out.url}
          alt=""
          className="size-10 cursor-zoom-in rounded-md border border-black/8 object-cover"
          onClick={(event) => { event.stopPropagation(); setPreviewMedia({ url: out.url!, kind: 'image' }) }}
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
        />
      )
    }
    const Icon = out.kind === 'video' ? VideoCameraOutlined : SoundOutlined
    return (
      <div
        className="grid size-10 cursor-zoom-in place-items-center rounded-md border border-black/8 bg-black/[0.03]"
        title={`点击查看${mediaLabel(out.kind)}`}
        onClick={(event) => { event.stopPropagation(); setPreviewMedia({ url: out.url!, kind: out.kind! }) }}
      >
        <Icon className="text-black/40" />
      </div>
    )
  }

  const colTime: ColumnsType<UsageLogItem>[number] = {
    title: '时间', dataIndex: 'createdAt', width: 122,
    render: (d: string) => <Text className="text-xs text-text-secondary">{dayjs(d).format('MM-DD HH:mm')}</Text>,
  }
  const colUserModel: ColumnsType<UsageLogItem>[number] = {
    title: '用户 / 模型', width: 240,
    render: (_: unknown, row: UsageLogItem) => (
      <div className="min-w-0">
        <Text className="block truncate text-xs font-medium">{row.user?.nickname || row.user?.phone || row.userId}</Text>
        <Text className="block truncate text-[11px] text-text-secondary">{row.model?.name || row.modelId}</Text>
        <Text className="block truncate text-[10px] text-text-disabled">{usageSourceLabels[row.source ?? ''] || row.source || '—'}{row.nodeLabel ? ` · ${row.nodeLabel}` : ''}</Text>
      </div>
    ),
  }
  const colStatus: ColumnsType<UsageLogItem>[number] = {
    title: '状态', dataIndex: 'statusCode', width: 88, align: 'center',
    render: (code: number | null) => statusNode(code),
  }
  const colCost: ColumnsType<UsageLogItem>[number] = {
    title: '扣除', width: 100, align: 'right', render: (_: unknown, row: UsageLogItem) => costNode(row),
  }
  const colDuration: ColumnsType<UsageLogItem>[number] = {
    title: '耗时', width: 92, align: 'right', render: (_: unknown, row: UsageLogItem) => durationNode(row),
  }
  const colOutput: ColumnsType<UsageLogItem>[number] = {
    title: '产物', key: 'output', width: 62, align: 'center', render: (_: unknown, row: UsageLogItem) => outputNode(row),
  }
  const colTokens: ColumnsType<UsageLogItem>[number] = {
    title: 'Tokens', dataIndex: 'tokensUsed', width: 92, align: 'right', render: (v: number | null) => <Text className="font-mono text-xs">{v ?? '-'}</Text>,
  }
  const colDetail: ColumnsType<UsageLogItem>[number] = {
    title: '', width: 54, align: 'center',
    render: (_: unknown, row: UsageLogItem) => (
      <Button type="link" size="small" onClick={(event) => { event.stopPropagation(); setDetailLog(row) }}>详情</Button>
    ),
  }

  /** 任务型调用：用户/模型、状态、扣费、耗时、产物；任务号在详情里。 */
  const taskColumns: ColumnsType<UsageLogItem> = [colTime, colUserModel, colStatus, colCost, colDuration, colOutput, colDetail]
  /** 会话型调用：用户/模型、Tokens、扣费、耗时、状态；错误在详情里。 */
  const llmColumns: ColumnsType<UsageLogItem> = [colTime, colUserModel, colTokens, colCost, colDuration, colStatus, colDetail]

  const pointsLogColumns: ColumnsType<StatsData['recentPointsLogs'][number]> = [
    {
      title: '用户', width: 160,
      render: (_: unknown, r) => <Text className="text-xs">{r.user?.nickname || r.user?.phone || r.userId}</Text>,
    },
    {
      title: '类型', dataIndex: 'type', width: 90,
      render: (t: string) => {
        const label = pointsLogTypeLabels[t] || { text: t, tone: 'primary' as StatusTone }
        return <StatusTag tone={label.tone}>{label.text}</StatusTag>
      },
    },
    {
      title: '数量', dataIndex: 'amount', width: 90, align: 'right',
      render: (v: number) => (
        <Text className={v >= 0 ? 'text-success' : 'text-danger'}>{v >= 0 ? `+${v}` : v}</Text>
      ),
    },
    { title: '说明', dataIndex: 'description', ellipsis: true, render: (v: string | null) => v || '-' },
    {
      title: '时间', dataIndex: 'createdAt', width: 150,
      render: (d: string) => <Text className="text-xs text-text-secondary">{dayjs(d).format('YYYY-MM-DD HH:mm')}</Text>,
    },
  ]

  const providerColumns: ColumnsType<SystemStatusData['providers'][number]> = [
    { title: '名称', dataIndex: 'name', render: (v: string) => <Text className="text-xs">{v}</Text> },
    { title: '代码', dataIndex: 'code', render: (v: string) => <Text className="text-xs text-text-secondary">{v}</Text> },
    { title: '状态', dataIndex: 'isActive', width: 70, render: (v: boolean) => v ? <StatusTag tone="success">启用</StatusTag> : <Tag>停用</Tag> },
    { title: 'Key', dataIndex: 'hasKey', width: 80, render: (v: boolean) => v ? <StatusTag tone="primary">已配置</StatusTag> : <StatusTag tone="danger">未配置</StatusTag> },
    {
      title: '连通性', width: 200,
      render: (_: unknown, r: SystemStatusData['providers'][number]) => (
        <div className="flex items-center gap-2">
          <Button size="small" loading={testingProvider === r.id} onClick={() => testProvider(r.id)}>测试</Button>
          {providerResults[r.id] && <Text className={`text-xs ${providerResults[r.id].ok ? 'text-success' : 'text-danger'}`}>{providerResults[r.id].message}</Text>}
        </div>
      ),
    },
  ]

  const errorColumns: ColumnsType<SystemStatusData['recentErrors'][number]> = [
    { title: '类型', dataIndex: 'kind', width: 60, render: (v: string) => <Tag>{v}</Tag> },
    { title: '模型', dataIndex: 'model', width: 120 },
    { title: '状态', dataIndex: 'statusCode', width: 70, align: 'center', render: (v: number) => v ? <StatusTag tone="danger">{v}</StatusTag> : null },
    { title: '错误', dataIndex: 'error', ellipsis: true, render: (v: string | null) => <Text className="text-xs text-danger">{v || '-'}</Text> },
    { title: '时间', dataIndex: 'createdAt', width: 150, render: (d: string) => <Text className="text-xs text-text-secondary">{dayjs(d).format('YYYY-MM-DD HH:mm')}</Text> },
  ]

  const appErrorColumns: ColumnsType<NonNullable<SystemStatusData['appErrors']>[number]> = [
    { title: '来源', dataIndex: 'scope', width: 120, render: (v: string) => <Tag>{v}</Tag> },
    { title: '路由', dataIndex: 'path', width: 180, ellipsis: true, render: (v?: string) => <Text className="text-xs text-text-secondary">{v || '-'}</Text> },
    {
      title: '错误',
      dataIndex: 'message',
      ellipsis: true,
      render: (v: string, r) => (
        <Text className="text-xs text-danger" title={r.stack || v}>{v}</Text>
      ),
    },
    { title: '时间', dataIndex: 'ts', width: 150, render: (d: string) => <Text className="text-xs text-text-secondary">{dayjs(d).format('YYYY-MM-DD HH:mm')}</Text> },
  ]

  const modelStatsColumns: ColumnsType<StatsData['modelStats'][number]> = [
    { title: '模型', dataIndex: 'name', render: (v: string) => <Text className="text-xs">{v}</Text> },
    { title: '类型', dataIndex: 'type', width: 90, render: (t: string) => <Text className="text-xs text-text-secondary">{typeLabels[t] || t}</Text> },
    { title: '调用', dataIndex: 'calls', width: 70, align: 'right' },
    { title: '消耗积分', dataIndex: 'cost', width: 90, align: 'right' },
    { title: 'Tokens', dataIndex: 'tokens', width: 90, align: 'right' },
    { title: '错误率', dataIndex: 'errorRate', width: 80, align: 'right', render: (v: number) => <StatusTag tone={v > 20 ? 'danger' : v > 5 ? 'warning' : 'success'}>{v}%</StatusTag> },
  ]

  const formatUptime = (sec: number) => {
    if (sec >= 86400) return `${Math.floor(sec / 86400)} 天 ${Math.floor((sec % 86400) / 3600)} 时`
    if (sec >= 3600) return `${Math.floor(sec / 3600)} 时 ${Math.floor((sec % 3600) / 60)} 分`
    return `${Math.floor(sec / 60)} 分`
  }
  const cardStatusText = (byStatus: { status: string; count: number }[] | undefined) =>
    (byStatus || []).map((s) => `${s.status} ${s.count}`).join(' · ') || '无数据'

  return (
    <>
      <SettingsWorkspace
      title="运维面板"
      description="看运行状态、调用记录和运营数据，常用的放在前面。"
      defaultActiveKey={activeTab}
      activeKey={activeTab}
      onChange={handleTabChange}
      items={[
        {
          key: 'overview',
          label: '概览',
          group: '运行监测',
          description: '用户、消耗、调用量与近期趋势。',
          children: (
            <div className="space-y-6">
              {/* 统计卡：合并为四宫格，API 成功/失败并入总量卡 */}
              <Row gutter={16}>
                <Col xs={24} sm={12} lg={6}>
                  <Card variant="outlined" loading={loadingStats}>
                    <Statistic
                      title="总用户数" valueRender={() => <AnimatedCounter value={stats?.totalUsers ?? 0} />}
                      prefix={<TeamOutlined className="text-primary" />}
                      styles={{ content: { color: 'var(--primary)' } }}
                    />
                  </Card>
                </Col>
                <Col xs={24} sm={12} lg={6}>
                  <Card variant="outlined" loading={loadingStats}>
                    <Statistic
                      title="今日活跃用户" valueRender={() => <AnimatedCounter value={stats?.activeUsersToday ?? 0} />}
                      prefix={<UserOutlined className="text-success" />}
                      styles={{ content: { color: 'var(--success)' } }}
                    />
                  </Card>
                </Col>
                <Col xs={24} sm={12} lg={6}>
                  <Card variant="outlined" loading={loadingStats}>
                    <Statistic
                      title="今日 API 调用" valueRender={() => <AnimatedCounter value={stats?.apiCallsToday.total ?? 0} />}
                      prefix={<ApiOutlined className="text-primary" />}
                      styles={{ content: { color: 'var(--primary)' } }}
                    />
                    <div className="mt-1 text-xs text-text-secondary">
                      成功 {stats?.apiCallsToday.success ?? 0} · 失败 {stats?.apiCallsToday.error ?? 0}
                    </div>
                  </Card>
                </Col>
                <Col xs={24} sm={12} lg={6}>
                  <Card variant="outlined" loading={loadingStats}>
                    <Statistic
                      title="今日消耗积分" valueRender={() => <AnimatedCounter value={stats?.pointsConsumedToday ?? 0} />}
                      prefix={<FallOutlined className="text-danger" />}
                      styles={{ content: { color: 'var(--danger)' } }}
                    />
                    <div className="mt-1 text-xs text-text-secondary">
                      发放 {stats?.pointsDistributedToday ?? 0}
                    </div>
                  </Card>
                </Col>
              </Row>

              {/* 近 7 天调用量趋势 */}
              <Card variant="outlined" title="近 7 天调用量" loading={loadingStats}>
                {stats?.dailyUsage?.length ? (
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={stats.dailyUsage}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                      <XAxis dataKey="date" tick={{ fontSize: 12 }} tickFormatter={(d: string) => dayjs(d).format('MM-DD')} />
                      <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                      <RechartsTooltip labelFormatter={(d) => dayjs(String(d)).format('YYYY-MM-DD')} />
                      <Legend />
                      <Line type="monotone" dataKey="total" name="总调用" stroke="var(--primary)" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="success" name="成功" stroke="var(--success)" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="error" name="失败" stroke="var(--danger)" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <Empty description="暂无数据" className="py-12" />
                )}
              </Card>
            </div>
          ),
        },
        {
          key: 'model-perf',
          label: '模型状态监测',
          group: '运行监测',
          description: '各模型调用量、错误率与响应表现。',
          children: <ModelPerfPanel />,
        },
        {
          key: 'logs',
          label: '调用记录',
          group: '数据与记录',
          description: '逐条查看请求、返回、扣费与失败原因。',
          children: (
            <div className="space-y-6">
              <Card
                variant="outlined"
                title="调用记录"
                extra={<Button icon={<ReloadOutlined />} onClick={() => void fetchUsageLogs(usagePage, usageStatus, usageModel, usageForm)}>刷新</Button>}
              >
                <div className="mb-3 rounded-xl border border-accent/10 bg-accent-light/25 px-3 py-2 text-xs leading-relaxed text-text-secondary">
                  <span className="font-medium text-foreground">任务型</span>：每次生图 / 视频 / 音频调用一条；<span className="font-medium text-foreground">会话型</span>：每次大语言模型调用一条。
                  进行中表示上游已受理、仍在生成。点任意一行看任务号、请求、返回和完整耗时。
                </div>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <Segmented
                    size="small"
                    value={usageForm}
                    onChange={(v: string | number) => { setUsageForm(v as 'task' | 'llm'); setUsagePage(1) }}
                    options={[
                      { value: 'task', label: '任务型' },
                      { value: 'llm', label: '会话型' },
                    ]}
                  />
                  <Select
                    allowClear
                    aria-label="筛选模型"
                    placeholder="全部模型"
                    style={{ minWidth: 150 }}
                    value={usageModel}
                    onChange={(v) => { setUsageModel(v); setUsagePage(1) }}
                    options={(stats?.modelStats || []).map((m) => ({ value: m.modelId, label: m.name }))}
                  />
                  <Select
                    allowClear
                    aria-label="筛选状态"
                    placeholder="全部状态"
                    style={{ minWidth: 112 }}
                    value={usageStatus}
                    onChange={(v) => { setUsageStatus(v); setUsagePage(1) }}
                    options={[
                      { value: 'success', label: '成功' },
                      { value: 'pending', label: '进行中' },
                      { value: 'error', label: '失败' },
                    ]}
                  />
                  {(usageStatus || usageModel) && (
                    <Button size="small" onClick={() => { setUsageStatus(undefined); setUsageModel(undefined); setUsagePage(1) }}>清空筛选</Button>
                  )}
                  <Text type="secondary" className="ml-auto text-xs">共 {usageTotal} 条</Text>
                </div>

                <div className="hidden md:block">
                  <Table
                    dataSource={usageLogs}
                    columns={usageForm === 'task' ? taskColumns : llmColumns}
                    rowKey="id"
                    loading={loadingUsage}
                    size="middle"
                    rowClassName={() => 'cursor-pointer'}
                    onRow={(row) => ({ onClick: () => setDetailLog(row) })}
                    scroll={{ x: 760, y: 480 }}
                    pagination={{
                      current: usagePage,
                      pageSize,
                      total: usageTotal,
                      showSizeChanger: false,
                      onChange: (p) => setUsagePage(p),
                    }}
                  />
                </div>

                <div className="space-y-2 md:hidden">
                  {usageLogs.length === 0 ? (
                    <Empty description="没有匹配的调用记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                  ) : usageLogs.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      onClick={() => setDetailLog(row)}
                      className="w-full rounded-2xl border border-black/6 bg-white/70 p-3 text-left transition-colors active:bg-accent-light/40"
                    >
                      <div className="flex items-center justify-between gap-2">
                        {statusNode(row.statusCode)}
                        <Text className="text-[11px] text-text-muted">{dayjs(row.createdAt).format('MM-DD HH:mm')}</Text>
                      </div>
                      <div className="mt-2 truncate text-sm font-medium">{row.user?.nickname || row.user?.phone || row.userId}</div>
                      <div className="mt-1 truncate text-xs text-text-secondary">{row.model?.name || row.modelId}</div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        {costNode(row)}
                        {durationNode(row)}
                        {usageForm === 'llm' && <Text className="font-mono text-xs text-text-secondary">Tokens {row.tokensUsed ?? '-'}</Text>}
                      </div>
                      {row.taskProgress && <div className="mt-2 truncate text-[11px] text-text-muted">{row.taskProgress}</div>}
                      {row.errorMessage && <div className="mt-2 line-clamp-2 text-[11px] text-danger">{row.errorMessage}</div>}
                      <div className="mt-2 text-right text-[11px] text-accent">查看详情 →</div>
                    </button>
                  ))}
                  {usageLogs.length > 0 && (
                    <div className="flex justify-end pt-2">
                      <Pagination size="small" current={usagePage} pageSize={pageSize} total={usageTotal} showSizeChanger={false} onChange={(p) => setUsagePage(p)} />
                    </div>
                  )}
                </div>
              </Card>

              {/* 积分流水与热门模型：原先单开一个 Tab，和调用记录看的是同一批调用，
                  合并到这里避免「同一件事两个入口」。 */}
              <Card variant="outlined" title="最近积分变动" loading={loadingStats}>
                <Table
                  dataSource={stats?.recentPointsLogs || []}
                  columns={pointsLogColumns}
                  rowKey="id"
                  size="middle"
                  scroll={{ x: 700, y: 360 }}
                  pagination={{ pageSize: 8, showSizeChanger: false }}
                />
              </Card>
              <Card variant="outlined" title="热门模型 (近 7 天)" loading={loadingStats}>
                {pieData.length ? (
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label={(p: { name?: string; percent?: number }) => `${p.name} ${((p.percent || 0) * 100).toFixed(0)}%`}>
                        {pieData.map((_, i) => (
                          <Cell key={i} fill={pieColors[i % pieColors.length]} />
                        ))}
                      </Pie>
                      <RechartsTooltip />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <Empty description="暂无数据" className="py-12" />
                )}
              </Card>
            </div>
          ),
        },
        {
          key: 'system',
          label: '系统健康',
          group: '运行监测',
          description: '内存、数据库、Redis、供应商连通性与资金健康。',
          children: (
            <div className="space-y-6">
              <Row gutter={16}>
                <Col xs={12} lg={6}>
                  <Card variant="outlined" loading={loadingSystem}>
                    <Statistic title="进程内存 RSS" value={systemStatus?.server.rss ?? 0} suffix="MB" prefix={<DatabaseOutlined className="text-primary" />} styles={{ content: { color: 'var(--primary)' } }} />
                  </Card>
                </Col>
                <Col xs={12} lg={6}>
                  <Card variant="outlined" loading={loadingSystem}>
                    <Statistic title="堆内存已用" value={systemStatus?.server.heapUsed ?? 0} suffix="MB" prefix={<RocketOutlined className="text-accent" />} styles={{ content: { color: 'var(--accent)' } }} />
                  </Card>
                </Col>
                <Col xs={12} lg={6}>
                  <Card variant="outlined" loading={loadingSystem}>
                    <Statistic
                      title="应用运行时长"
                      value={formatUptime(systemStatus?.server.uptime ?? 0)}
                      prefix={<ThunderboltOutlined className="text-warning" />}
                      styles={{ content: { color: 'var(--warning)' } }}
                    />
                    {typeof systemStatus?.server.hostUptime === 'number' && (
                      <div className="mt-1 text-xs text-text-secondary">
                        宿主开机 {formatUptime(systemStatus.server.hostUptime)}
                      </div>
                    )}
                  </Card>
                </Col>
                <Col xs={12} lg={6}>
                  <Card variant="outlined" loading={loadingSystem}>
                    <Statistic title="数据库" value={systemStatus?.server.dbOk ? '正常' : '异常'} valueStyle={{ color: systemStatus?.server.dbOk ? 'var(--success)' : 'var(--danger)' }} />
                  </Card>
                </Col>
                {/* Redis（Q-D49）：只服务「公众号验证码登录」，但故障原本完全不可见 ——
                    ioredis 的 error 事件没监听器时会被静默丢弃。放在这里是为了让
                    「微信登录失败」这类报障第一眼就能排除掉「Redis 挂了」这个可能。 */}
                <Col xs={12} lg={6}>
                  <Card variant="outlined" loading={loadingSystem}>
                    <Statistic
                      title="Redis（微信验证码登录）"
                      value={systemStatus?.server.redisOk ? '正常' : '异常'}
                      valueStyle={{ color: systemStatus?.server.redisOk ? 'var(--success)' : 'var(--danger)' }}
                    />
                    {systemStatus?.server.redisError && (
                      <div className="mt-1 break-all text-[11px] text-danger">{systemStatus.server.redisError}</div>
                    )}
                  </Card>
                </Col>
              </Row>
              <div className="flex flex-wrap items-center gap-3">
                <Button size="small" icon={<ReloadOutlined />} loading={loadingSystem} onClick={() => void fetchSystemStatus()}>刷新</Button>
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-text-secondary">
                  <Switch size="small" checked={sysAuto} onChange={setSysAuto} />
                  每 30 秒自动刷新
                </label>
                {systemStatus && (
                  <span className="text-xs text-text-muted">
                    最后更新 {dayjs().format('HH:mm:ss')} · 负载 {systemStatus.server.loadavg.map((n) => n.toFixed(2)).join(' / ')}
                  </span>
                )}
              </div>
              <Card variant="outlined" title={`Provider 连通性（激活模型 ${systemStatus?.server.modelCount ?? 0} 个）`} loading={loadingSystem}>
                <Table
                  dataSource={systemStatus?.providers || []}
                  columns={providerColumns}
                  rowKey="id"
                  size="middle"
                  pagination={false}
                  scroll={{ x: 'max-content', y: 300 }}
                  locale={{ emptyText: <Empty description="暂无 Provider" /> }}
                />
              </Card>
              <Card variant="outlined" title="最近错误 / 生成失败" loading={loadingSystem}>
                <Table
                  dataSource={systemStatus?.recentErrors || []}
                  columns={errorColumns}
                  rowKey={(r) => `${r.createdAt}-${r.error}`}
                  size="middle"
                  scroll={{ x: 'max-content' }}
                  pagination={{ pageSize: 10, showSizeChanger: false }}
                  locale={{ emptyText: <Empty description="暂无错误" /> }}
                />
              </Card>
              <Card variant="outlined" title="进程错误（落盘，重启可查）" loading={loadingSystem}>
                <Table
                  dataSource={systemStatus?.appErrors || []}
                  columns={appErrorColumns}
                  rowKey={(r, i) => `${r.ts}-${i}`}
                  size="middle"
                  scroll={{ x: 'max-content' }}
                  pagination={{ pageSize: 10, showSizeChanger: false }}
                  locale={{ emptyText: <Empty description="暂无进程错误" /> }}
                />
              </Card>
            </div>
          ),
        },
        {
          key: 'analytics',
          label: '运营分析',
          group: '数据与记录',
          description: '用户增长、积分收支、生成量与内容规模。',
          children: (
            <div className="space-y-6">
              <Row gutter={16}>
                <Col xs={24} lg={12}>
                  <Card variant="outlined" title="近 30 天用户增长" loading={loadingStats}>
                    {stats?.userGrowth?.length ? (
                      <ResponsiveContainer width="100%" height={260}>
                        <LineChart data={stats.userGrowth}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                          <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d: string) => dayjs(d).format('MM-DD')} interval={4} />
                          <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                          <RechartsTooltip labelFormatter={(d) => dayjs(String(d)).format('YYYY-MM-DD')} />
                          <Line type="monotone" dataKey="count" name="注册" stroke="var(--primary)" strokeWidth={2} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    ) : <Empty description="暂无数据" className="py-10" />}
                  </Card>
                </Col>
                <Col xs={24} lg={12}>
                  <Card variant="outlined" title="近 7 天积分收支" loading={loadingStats}>
                    {stats?.pointsTrend?.length ? (
                      <ResponsiveContainer width="100%" height={260}>
                        <BarChart data={stats.pointsTrend}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                          <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d: string) => dayjs(d).format('MM-DD')} />
                          <YAxis tick={{ fontSize: 12 }} />
                          <RechartsTooltip labelFormatter={(d) => dayjs(String(d)).format('YYYY-MM-DD')} />
                          <Legend />
                          <Bar dataKey="income" name="收入" fill="var(--success)" />
                          <Bar dataKey="expense" name="支出" fill="var(--danger)" />
                        </BarChart>
                      </ResponsiveContainer>
                    ) : <Empty description="暂无数据" className="py-10" />}
                  </Card>
                </Col>
              </Row>

              <Row gutter={16}>
                <Col xs={24} lg={8}>
                  <Card variant="outlined" title="积分类型分项 (近 7 天)" loading={loadingStats}>
                    <Table
                      dataSource={stats?.pointsBreakdown || []}
                      rowKey="type"
                      size="middle"
                      pagination={false}
                      scroll={{ x: 'max-content' }}
                      columns={[
                        { title: '类型', dataIndex: 'type', render: (t: string) => { const l = pointsLogTypeLabels[t] || { text: t, tone: 'primary' as StatusTone }; return <StatusTag tone={l.tone}>{l.text}</StatusTag> } },
                        { title: '数量', dataIndex: 'amount', align: 'right', render: (v: number) => <Text className={v >= 0 ? 'text-success' : 'text-danger'}>{v >= 0 ? `+${v}` : v}</Text> },
                      ]}
                      locale={{ emptyText: <Empty description="暂无数据" /> }}
                    />
                  </Card>
                </Col>
                <Col xs={24} lg={16}>
                  <Card variant="outlined" title="模型分析 (近 7 天：调用 / 消耗 / 错误率)" loading={loadingStats}>
                    <Table
                      dataSource={stats?.modelStats || []}
                      columns={modelStatsColumns}
                      rowKey="modelId"
                      size="middle"
                      pagination={false}
                      scroll={{ x: 'max-content', y: 300 }}
                      locale={{ emptyText: <Empty description="暂无数据" /> }}
                    />
                  </Card>
                </Col>
              </Row>

              <Row gutter={16}>
                <Col xs={24} md={12} lg={6}>
                  <Card variant="outlined" title="图片生成" loading={loadingStats}>
                    <Statistic title="总量" valueRender={() => <AnimatedCounter value={stats?.generationStats.images.total ?? 0} />} />
                    <div className="mt-2 text-xs text-text-muted">成功 {stats?.generationStats.images.success ?? 0} · 失败 {stats?.generationStats.images.failed ?? 0}（{stats?.generationStats.images.failedRate ?? 0}%）{(stats?.generationStats.images.pending ?? 0) > 0 ? ` · 进行中 ${stats?.generationStats.images.pending}` : ''}</div>
                    <div className="mt-1 text-xs text-text-secondary">待清理 {stats?.generationStats.images.expired ?? 0}</div>
                  </Card>
                </Col>
                <Col xs={24} md={12} lg={6}>
                  <Card variant="outlined" title="视频生成" loading={loadingStats}>
                    <Statistic title="总量" valueRender={() => <AnimatedCounter value={stats?.generationStats.videos.total ?? 0} />} />
                    <div className="mt-2 text-xs text-text-muted">成功 {stats?.generationStats.videos.success ?? 0} · 失败 {stats?.generationStats.videos.failed ?? 0}（{stats?.generationStats.videos.failedRate ?? 0}%）{(stats?.generationStats.videos.pending ?? 0) > 0 ? ` · 进行中 ${stats?.generationStats.videos.pending}` : ''}</div>
                    <div className="mt-1 text-xs text-text-secondary">待清理 {stats?.generationStats.videos.expired ?? 0} · 消耗豆 {stats?.generationStats.videos.beansSpent ?? 0}</div>
                  </Card>
                </Col>
                <Col xs={24} md={12} lg={6}>
                  <Card variant="outlined" title="大模型 Token（近 7 天）" loading={loadingStats}>
                    <Statistic title="总调用量" valueRender={() => <AnimatedCounter value={stats?.llmTokenStats.total ?? 0} />} />
                    <div className="mt-2 text-xs text-text-muted">计入统计的调用 {stats?.llmTokenStats.calls ?? 0} 次</div>
                    <div className="mt-1 text-xs text-text-secondary">今日 {stats?.llmTokenStats.today ?? 0}</div>
                  </Card>
                </Col>
                <Col xs={24} md={12} lg={6}>
                  <Card variant="outlined" title="卡密" loading={loadingStats}>
                    <Statistic title="总数" value={stats?.cardKeyStats.total ?? 0} />
                    <div className="mt-2 text-xs text-text-muted">{cardStatusText(stats?.cardKeyStats.byStatus)}</div>
                  </Card>
                </Col>
                <Col xs={24} md={12} lg={6}>
                  <Card variant="outlined" title="内容数据" loading={loadingStats}>
                    <div className="space-y-1 text-xs text-text-muted">
                      <div>画布工作流 {stats?.contentStats.canvasWorkflows ?? 0}</div>

                      <div>公告 {stats?.contentStats.announcements ?? 0} · Agent {stats?.contentStats.agents ?? 0}</div>
                    </div>
                  </Card>
                </Col>
                <Col xs={24} md={12} lg={6}>
                  <Card variant="outlined" title="素材清理" loading={loadingStats}>
                    <div className="space-y-2 text-xs text-text-muted">
                      <div>
                        待清理（已过期）：<Text strong>{assetCleanup?.expiredCount ?? 0}</Text> 个 ·{' '}
                        {Math.round((assetCleanup?.expiredBytes ?? 0) / 1024 / 1024)} MB
                      </div>
                      <div className="text-text-disabled">
                        上游转存图 2 小时过期，面板上传 7 天过期；用户主动上传永久保留。
                      </div>
                      <Button size="small" loading={cleaningAssets} onClick={runAssetCleanup}>
                        立即清理过期与孤儿文件
                      </Button>
                    </div>
                  </Card>
                </Col>
                <Col xs={24} md={12} lg={6}>
                  {/* 资金健康（Q-D09②）：以前这些数字只有人手动跑 audit-payments 才看得到，
                      「扣了钱却没收口」这类问题往往等到用户投诉才发现 */}
                  <Card variant="outlined" title="资金健康" loading={loadingSystem}>
                    <div className="space-y-1 text-xs text-text-muted">
                      <div>
                        孤儿扣费 30 天：
                        <Text strong className={(systemStatus?.moneyHealth?.orphanCharges30d.count ?? 0) > 0 ? 'text-danger' : undefined}>
                          {systemStatus?.moneyHealth?.orphanCharges30d.count ?? 0}
                        </Text> 笔 · {Math.round(systemStatus?.moneyHealth?.orphanCharges30d.points ?? 0)} 积分
                      </div>
                      <div>未结算预扣 {systemStatus?.moneyHealth?.openHolds ?? 0} · 卡死任务 {systemStatus?.moneyHealth?.stuckRunningTasks ?? 0}</div>
                      <div>无事务号扣费 30 天 {systemStatus?.moneyHealth?.chargesWithoutRunId30d ?? 0}</div>
                      <div className="text-text-disabled">
                        孤儿扣费 = 有扣费流水但无成功调用也无预扣账本，长期应贴近 0。
                      </div>
                    </div>
                  </Card>
                </Col>
              </Row>
            </div>
          ),
        },
        ]}
      />

      <UsageLogDetailDrawer log={detailLog} onClose={() => setDetailLog(null)} />

      {/* 图片复用统一灯箱；视频/音频用独立播放弹窗，避免两套图片缩放实现漂移。 */}
      <ImageLightbox
        open={previewMedia?.kind === 'image'}
        urls={previewMedia?.kind === 'image' ? [previewMedia.url] : []}
        onClose={() => setPreviewMedia(null)}
      />
      <Modal
        open={previewMedia?.kind === 'video' || previewMedia?.kind === 'audio'}
        onCancel={() => setPreviewMedia(null)}
        footer={null}
        centered
        width={900}
        destroyOnHidden
        title={previewMedia?.kind === 'video' ? '视频产物' : '音频产物'}
      >
        {previewMedia?.kind === 'video' && (
          <video src={previewMedia.url} controls autoPlay className="max-h-[78dvh] w-full rounded-lg bg-black object-contain" />
        )}
        {previewMedia?.kind === 'audio' && (
          <audio src={previewMedia.url} controls autoPlay className="w-full" />
        )}
      </Modal>
    </>
  )
}
