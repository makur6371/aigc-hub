'use client'

import { useState, useEffect, useCallback } from 'react'
import dayjs from 'dayjs'
import {
  Card,
  Table,
  Button,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Modal,
  Tag,
  Space,
  Popconfirm,
  Typography,
  Tooltip,
  Checkbox,
  App,
  Collapse,
  DatePicker,
} from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  ReloadOutlined,
  FileTextOutlined,
  PictureOutlined,
  VideoCameraOutlined,
  SoundOutlined,
  EyeOutlined,
  EyeInvisibleOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { StatusTag, type StatusTone } from '@/components/ui/StatusTag'
import { AdapterManager } from './AdapterManager'
import { ASPECT_RATIOS, RES_TIERS, expandSizes, getImageCapabilities } from '@/lib/image-sizes'
import { DEFAULT_VIDEO_RATIOS, VIDEO_MODE_LABELS, VIDEO_RES_TIERS } from '@/lib/video-capabilities'
// 计费因子的**唯一定义处**：后台表单必须与引擎读的字段同名，用 `any` 转一下就把这层约束丢掉了
import type { VideoBillingSpec } from '@/lib/billing/billing-plans'

// 视频能力可选项（配置界面勾选用；与使用端 video-capabilities 的兜底一致）
const VIDEO_RATIO_OPTIONS = [...DEFAULT_VIDEO_RATIOS, '4:5', '5:4']
// 分辨率档统一到 canonical（480P/720P/768P/1080P/2K/4K）：上游口径混用 768p/768P，
// 配置端只暴露 canonical，使用端再按档位翻译给上游，避免同一档三种写法。
const VIDEO_RES_OPTIONS = [...VIDEO_RES_TIERS]
import { apiFetch } from '@/lib/api-client'

const { Text, Paragraph } = Typography

type ProviderItem = {
  id: string; name: string; code: string; baseUrl: string
  apiKey: string | null; configSchema: unknown; adapterId: string | null; configJson: Record<string, unknown> | null
  isActive: boolean
  modelCount: number; createdAt: string
}

type AdapterItem = {
  id: string; name: string; code: string; description: string | null; type: string
  source: string; isBuiltin: boolean; isActive: boolean; createdAt: string
}

type ModelItem = {
  id: string; name: string; modelName: string; type: string
  pricingType: string; costPoints: number; isActive: boolean
  isPublic?: boolean
  providerId: string; provider: { id: string; name: string }
  supportsVision: boolean; contextWindow: number | null
  metadata: Record<string, unknown> | null; createdAt: string
  discount: number | null; discountStartsAt: string | null; discountEndsAt: string | null; isFree: boolean; videoCost: number | null
  dailyUserFreeQuota: number | null; dailyPlatformFreeQuota: number | null
}

const typeLabels: Record<string, string> = { TEXT: '纯语言模型', VISION: '多模态读图模型', IMAGE: '生图模型', VIDEO: '视频模型', AUDIO: '音频模型' }
const typeTones: Record<string, StatusTone> = { TEXT: 'primary', VISION: 'success', IMAGE: 'accent', VIDEO: 'warning', AUDIO: 'gold' }

export function ApiConfigPanel() {
  const { message } = App.useApp()
  const [providers, setProviders] = useState<ProviderItem[]>([])
  const [models, setModels] = useState<ModelItem[]>([])
  const [adapters, setAdapters] = useState<AdapterItem[]>([])
  const [loadingProviders, setLoadingProviders] = useState(false)
  const [loadingModels, setLoadingModels] = useState(false)
  const [loadingAdapters, setLoadingAdapters] = useState(false)
  const [providerModalOpen, setProviderModalOpen] = useState(false)
  const [modelModalOpen, setModelModalOpen] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [editingProvider, setEditingProvider] = useState<ProviderItem | null>(null)
  const [editingModel, setEditingModel] = useState<ModelItem | null>(null)
  const [providerForm] = Form.useForm()
  const [modelForm] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [providerModels, setProviderModels] = useState<{ id: string; object: string }[]>([])
  const [loadingProviderModels, setLoadingProviderModels] = useState(false)
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)

  const fetchProviders = useCallback(async () => {
    setLoadingProviders(true)
    try {
      const res = await apiFetch<ProviderItem[]>('/api/admin/providers')
      if (res.success && res.data) setProviders(res.data)
    } catch { /* */ }
    finally { setLoadingProviders(false) }
  }, [])

  const fetchModels = useCallback(async () => {
    setLoadingModels(true)
    try {
      const res = await apiFetch<ModelItem[]>('/api/admin/models')
      if (res.success && res.data) setModels(res.data)
    } catch { /* */ }
    finally { setLoadingModels(false) }
  }, [])

  const fetchAdapters = useCallback(async () => {
    setLoadingAdapters(true)
    try {
      const res = await apiFetch<AdapterItem[]>('/api/admin/adapters')
      if (res.success && res.data) setAdapters(res.data)
    } catch { /* */ }
    finally { setLoadingAdapters(false) }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => { void fetchProviders(); void fetchModels(); void fetchAdapters() }, 0)
    return () => window.clearTimeout(timer)
  }, [fetchProviders, fetchModels, fetchAdapters])

  // ---- Provider CRUD ----
  const openProviderModal = (p?: ProviderItem) => {
    setEditingProvider(p || null)
    providerForm.resetFields()
    if (p) {
      providerForm.setFieldsValue({
        name: p.name,
        code: p.code,
        baseUrl: p.baseUrl,
        apiKey: '',
        isActive: p.isActive,
        adapterId: p.adapterId || undefined,
        configJson: p.configJson ? JSON.stringify(p.configJson, null, 2) : '',
      })
    } else {
      providerForm.setFieldsValue({ isActive: true, adapterId: undefined, configJson: '' })
    }
    setProviderModalOpen(true)
  }

  const saveProvider = async () => {
    const values = await providerForm.validateFields()
    setSaving(true)
    try {
      let configJson: Record<string, unknown> | null = null
      if (values.configJson && typeof values.configJson === 'string' && values.configJson.trim()) {
        try {
          configJson = JSON.parse(values.configJson)
        } catch {
          message.error('扩展配置 JSON 格式错误')
          setSaving(false)
          return
        }
      }
      const body = {
        ...values,
        apiKey: values.apiKey || undefined,
        adapterId: values.adapterId || null,
        configJson,
      }
      const url = editingProvider ? `/api/admin/providers/${editingProvider.id}` : '/api/admin/providers'
      const method = editingProvider ? 'PUT' : 'POST'

      const res = await apiFetch(url, { method, body: JSON.stringify(body) })
      if (res.success) {
        message.success(res.message)
        setProviderModalOpen(false)
        fetchProviders()
      } else { message.error(res.message) }
    } catch { message.error('操作失败') }
    finally { setSaving(false) }
  }

  const deleteProvider = async (id: string) => {
    try {
      const res = await apiFetch(`/api/admin/providers/${id}`, { method: 'DELETE' })
      if (res.success) { message.success('删除成功'); fetchProviders() }
      else { message.error(res.message) }
    } catch { message.error('删除失败') }
  }

  const testProvider = async (id: string) => {
    setTesting(id)
    try {
      const res = await apiFetch<{ status: string }>(`/api/admin/providers/${id}/test`, { method: 'POST' })
      if (res.success && res.data) {
        if (res.data.status === 'ok') message.success(res.message)
        else if (res.data.status === 'auth_error') message.warning(res.message)
        else message.error(res.message)
      } else { message.error(res.message) }
    } catch { message.error('测试失敗') }
    finally { setTesting(null) }
  }

  // ---- Model CRUD ----
  const openModelModal = (m?: ModelItem) => {
    setEditingModel(m || null)
    modelForm.resetFields()
    setProviderModels([])
    if (m) {
      // IMAGE 模型：DB 存的是 metadata.sizes（["比例@档位"]），表单的"可用比例/分辨率档位"用 sizeRatios/sizeTiers，
      // 需把 sizes 反解析回填，否则编辑时看不到之前配的比例/档位（且再次保存会清空）。
      let meta = m.metadata
      if (m.type === 'IMAGE' && meta && Array.isArray((meta as Record<string, unknown>).sizes)) {
        const metaCopy = { ...(meta as Record<string, unknown>) }
        const cap = getImageCapabilities({ metadata: metaCopy })
        metaCopy.sizeRatios = cap.ratios
        metaCopy.sizeTiers = cap.tiers
        meta = metaCopy
      }
      // VIDEO 模型：durationSelectable 默认 true（表单 Switch 需要显式 checked），
      // durations 存的是数组，表单是逗号输入框，回填前先转字符串。
      if (m.type === 'VIDEO') {
        const metaCopy = { ...(meta ?? {}) } as Record<string, unknown>
        const video = { ...((metaCopy.video ?? {}) as Record<string, unknown>) }
        const constraints = { ...((video.constraints ?? {}) as Record<string, unknown>) }
        constraints.durationSelectable = constraints.durationSelectable !== false
        if (Array.isArray(constraints.durations)) constraints.durations = constraints.durations.join(',')
        video.constraints = constraints
        metaCopy.video = video
        meta = metaCopy
      }
      modelForm.setFieldsValue({
        name: m.name, modelName: m.modelName, type: m.type, pricingType: m.pricingType,
        costPoints: m.costPoints, providerId: m.providerId, isActive: m.isActive,
        isPublic: m.isPublic ?? true,
        supportsVision: m.supportsVision, contextWindow: m.contextWindow,
        metadata: meta, discount: m.discount, isFree: m.isFree, videoCost: m.videoCost,
        discountStartsAt: m.discountStartsAt ? dayjs(m.discountStartsAt) : null,
        discountEndsAt: m.discountEndsAt ? dayjs(m.discountEndsAt) : null,
        dailyUserFreeQuota: m.dailyUserFreeQuota, dailyPlatformFreeQuota: m.dailyPlatformFreeQuota,
      })
    } else {
      modelForm.setFieldsValue({ type: 'TEXT', pricingType: 'PER_TOKEN', isActive: true, isPublic: true, supportsVision: false, providerId: selectedProviderId || undefined })
    }
    setModelModalOpen(true)
  }

  const loadProviderModels = async () => {
    const providerId = modelForm.getFieldValue('providerId')
    if (!providerId) {
      message.warning('请先选择 Provider')
      return
    }
    setLoadingProviderModels(true)
    try {
      const res = await apiFetch<{ id: string; object: string }[]>(`/api/admin/providers/${providerId}/models`)
      if (res.success && res.data) {
        setProviderModels(res.data)
        message.success(res.message)
      } else {
        message.error(res.message)
      }
    } catch {
      message.error('加载失败')
    } finally {
      setLoadingProviderModels(false)
    }
  }

  const saveModel = async () => {
    const values = await modelForm.validateFields()
    setSaving(true)
    try {
      const selectedType = values.type
      const metadata = buildMetadata(selectedType, values)

      // 视频模型保存前的计费配置体检（生产审计发现的血案）：
      //   只配「按分辨率档定价」而没配任何兜底价 → 用户选未列出的分辨率时计价为 0，
      //   付费模型静默变免费（2026-10-15 事故的同一个洞）。这里在**保存时**就拦住，
      //   而不是等运行时靠拒单兜底 —— 让配置错误当场暴露在后台。
      if (selectedType === 'VIDEO' && !values.isFree) {
        // 计费因子的类型直接取自引擎（lib/billing/billing-plans 的 VideoBillingSpec）。
        // 原先这里连写六次 `as Record<string, any>`：`any` 把这条链路彻底断开 ——
        // 引擎哪天改字段名（perOutputSecond → perSecond 之类），面板照旧编译通过、
        // 照旧显示「已配置价格」，而实际算出来是 0 豆。**这个洞本身就是 2026-10-15 事故的那一类**。
        const billing = (metadata?.video as { billing?: VideoBillingSpec } | undefined)?.billing
        const hasAnyPrice =
          Number(values.videoCost) > 0 ||
          Number(metadata?.perSecondBeans) > 0 ||
          Number(billing?.perCall) > 0 ||
          Number(billing?.perOutputSecond) > 0 ||
          Object.values(billing?.perSecondByResolution ?? {}).some((v) => Number(v) > 0) ||
          Number(billing?.perInputImage) > 0
        if (!hasAnyPrice) {
          message.error('视频模型必须配置至少一种豆价（一口价 / 按秒 / 按分辨率档 / 按张），否则用户使用会算成 0 豆')
          setSaving(false)
          return
        }
        // 只配了档位价、没配兜底价 → 必须警告：未列出的分辨率会按最低档或拒单
        const perRes = billing?.perSecondByResolution
        const hasPerRes = Object.values(perRes ?? {}).some((v) => Number(v) > 0)
        const hasFallback =
          Number(billing?.perOutputSecond) > 0 ||
          Number(metadata?.perSecondBeans) > 0 ||
          Number(values.videoCost) > 0
        if (hasPerRes && !hasFallback) {
          message.warning('只配了「按分辨率档定价」而没有兜底价：用户选择未列出的分辨率时会按最低档计价，请确认这是预期行为')
        }
      }

      const body = {
        ...values,
        metadata,
        costPoints: Number(values.costPoints),
        videoCost: values.videoCost == null || values.videoCost === '' ? null : Number(values.videoCost),
        discount: values.discount == null || values.discount === '' ? null : Number(values.discount),
        discountStartsAt: values.discountStartsAt ? (values.discountStartsAt as dayjs.Dayjs).toISOString() : null,
        discountEndsAt: values.discountEndsAt ? (values.discountEndsAt as dayjs.Dayjs).toISOString() : null,
        isFree: !!values.isFree,
        dailyUserFreeQuota: values.dailyUserFreeQuota == null || values.dailyUserFreeQuota === '' ? null : Number(values.dailyUserFreeQuota),
        dailyPlatformFreeQuota: values.dailyPlatformFreeQuota == null || values.dailyPlatformFreeQuota === '' ? null : Number(values.dailyPlatformFreeQuota),
        contextWindow: values.contextWindow ? Number(values.contextWindow) : null,
        // 多模态读图模型必然支持图片输入，强制为 true，避免入库 false 导致对话页无法传图
        supportsVision: values.type === 'VISION' ? true : !!values.supportsVision,
      }

      const url = editingModel ? `/api/admin/models/${editingModel.id}` : '/api/admin/models'
      const method = editingModel ? 'PUT' : 'POST'

      const res = await apiFetch(url, { method, body: JSON.stringify(body) })
      if (res.success) {
        message.success(res.message)
        setModelModalOpen(false)
        fetchModels()
      } else { message.error(res.message) }
    } catch { message.error('操作失败') }
    finally { setSaving(false) }
  }

  const deleteModel = async (id: string) => {
    try {
      const res = await apiFetch(`/api/admin/models/${id}`, { method: 'DELETE' })
      if (res.success) { message.success('删除成功'); fetchModels() }
      else { message.error(res.message) }
    } catch { message.error('删除失败') }
  }

  const providerColumns: ColumnsType<ProviderItem> = [
    { title: '名称', dataIndex: 'name', width: 130 },
    { title: '代码', dataIndex: 'code', width: 110, render: (c: string) => <Text code>{c}</Text> },
    { title: '接口地址', dataIndex: 'baseUrl', ellipsis: true, width: 200,
      render: (url: string) => <Tooltip title={url}><Text className="text-xs">{url}</Text></Tooltip>
    },
    {
      title: 'Key', dataIndex: 'apiKey', width: 120,
      render: (k: string | null) => k ? <Text className="text-xs text-success">已配置</Text> : <Text className="text-xs text-text-disabled">未设置</Text>,
    },
    {
      title: 'Adapter', width: 130,
      render: (_: unknown, r: ProviderItem) => {
        const adapter = adapters.find(a => a.id === r.adapterId)
        return adapter ? <StatusTag tone={adapter.isBuiltin ? 'accent' : 'primary'} className="text-xs">{adapter.name}</StatusTag> : <Tag className="text-xs">默认 OpenAI</Tag>
      },
    },
    {
      title: '启用', dataIndex: 'isActive', width: 60, align: 'center',
      render: (v: boolean, r: ProviderItem) => (
        <Switch
          size="small"
          checked={v}
          // ⚠️ 这里以前错调成 `/api/admin/models/${r.id}` —— 拿**供应商 id** 去 update
          // **模型**。两个表的 id 各自独立，后果分两种：
          //   1) 找不到（当前生产就是这种）→ Prisma P2025 报错，开关点了没反应；
          //   2) 万一某个模型 id 碰巧等于这个供应商 id → 静默改错模型的启用状态。
          // 供应商必须走自己的接口。
          onChange={async (checked) => {
            const res = await apiFetch(`/api/admin/providers/${r.id}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ isActive: checked }),
            })
            if (res.success) { message.success(checked ? '已启用' : '已停用'); void fetchProviders() }
            else message.error(res.message || '操作失败')
          }}
        />
      ),
    },
    { title: '模型数', dataIndex: 'modelCount', width: 60, align: 'center' },
    {
      title: '操作', width: 220,
      render: (_: unknown, r: ProviderItem) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openProviderModal(r)}>编辑</Button>
          <Button type="link" size="small" icon={testing === r.id ? <LoadingOutlined /> : <ApiOutlined />}
            onClick={() => testProvider(r.id)} loading={testing === r.id}>
            测试
          </Button>
          <Popconfirm title="确定删除？" onConfirm={() => deleteProvider(r.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const selectedProvider = providers.find((p) => p.id === selectedProviderId) || null
  const filteredModels = selectedProviderId ? models.filter((m) => m.providerId === selectedProviderId) : models

  const modelColumns: ColumnsType<ModelItem> = [
    {
      title: '显示名称', dataIndex: 'name', width: 180, ellipsis: true,
      render: (n: string, r: ModelItem) => (
        <Tooltip title={n || r.modelName || '(未命名)'}>
          <Text className="text-sm">{n || '(未命名)'}</Text>
        </Tooltip>
      ),
    },
    { title: '上游标识', dataIndex: 'modelName', width: 160, ellipsis: true,
      render: (n: string) => <Text code className="text-xs">{n || '(同显示名)'}</Text>,
    },
    {
      title: '类型', dataIndex: 'type', width: 120,
      render: (t: string) => <StatusTag tone={typeTones[t] || 'primary'}>{typeLabels[t] || t}</StatusTag>,
    },
    {
      title: '计费', width: 110,
      render: (_: unknown, r: ModelItem) => (
        <div className="flex flex-col gap-0.5">
          <Text className="text-xs">{r.pricingType === 'PER_TOKEN' ? `${r.costPoints} 积分/Token` : `${r.costPoints} 积分/次`}</Text>
          {/* 这里显示的是「配置的折扣率」（后台配置口径，便于核对填了什么）。
              用户端展示的是「实付/原价」回算值——因为积分取整后二者可能不同
              （配置 0.6、原价 6 → 实付 4，用户端会显示 6.7 折）。 */}
          {r.isFree ? (
            <StatusTag tone="success">免费</StatusTag>
          ) : r.discount != null ? (
            (() => {
              // 后台显示配置口径 + 窗口状态：配置了时间窗但当前在窗口外时明确标出，
              // 避免运营看到「6折」以为活动价还在生效（实际用户端已回落原价）。
              const now = Date.now()
              const notStarted = r.discountStartsAt ? now < new Date(r.discountStartsAt).getTime() : false
              const expired = r.discountEndsAt ? now > new Date(r.discountEndsAt).getTime() : false
              const label = `${(r.discount * 10).toFixed(1)}折${notStarted ? '（未开始）' : expired ? '（已过期）' : ''}`
              return <StatusTag tone={notStarted || expired ? 'primary' : 'warning'}>{label}</StatusTag>
            })()
          ) : null}
          {(r.dailyUserFreeQuota ?? 0) > 0 ? (
            <StatusTag tone="accent">每日免费 {r.dailyUserFreeQuota} 次{r.dailyPlatformFreeQuota ? ` / 平台 ${r.dailyPlatformFreeQuota}` : ''}</StatusTag>
          ) : null}
        </div>
      ),
    },
    {
      title: '启用', dataIndex: 'isActive', width: 60, align: 'center',
      render: (v: boolean) => v ? <CheckCircleOutlined className="text-success" /> : <CloseCircleOutlined className="text-text-disabled" />,
    },
    {
      title: '对外', dataIndex: 'isPublic', width: 56, align: 'center',
      render: (v: boolean | undefined) =>
        v === false
          ? <EyeInvisibleOutlined className="text-text-disabled" />
          : <EyeOutlined className="text-success" />,
    },
    {
      title: '操作', width: 120,
      render: (_: unknown, r: ModelItem) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openModelModal(r)}>编辑</Button>
          <Popconfirm title="确定删除？" onConfirm={() => deleteModel(r.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      {/* 供应商管理：上方全宽 Provider 列表，下方选中 Provider 的模型 */}
      <Card
        variant="outlined"
        title={<Space><ApiOutlined />供应商管理</Space>}
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => openProviderModal()}>新增 Provider</Button>}
      >
        <Paragraph className="text-xs text-text-secondary mb-4">
          Provider 是上游 AI 服务的接入点。点击上方 Provider 查看其模型；模型与 Provider 关联管理。
        </Paragraph>

        {/* ① 全宽 Provider 列表：先看全所有 Provider，点选后再看对应模型 */}
        <div className="flex flex-col gap-6">
          <div>
            <div className="flex items-center justify-between mb-3">
              <Space>
                <Text strong className="text-sm">Provider 列表</Text>
                <Text className="text-xs text-text-secondary">点击一行选中，下方展示其模型</Text>
              </Space>
            </div>
            <Table
              dataSource={providers}
              columns={providerColumns}
              rowKey="id"
              loading={loadingProviders}
              size="small"
              rowSelection={{
                type: 'radio',
                selectedRowKeys: selectedProviderId ? [selectedProviderId] : [],
                onChange: (keys) => setSelectedProviderId(keys[0] as string),
              }}
              onRow={(r) => ({ onClick: () => setSelectedProviderId(r.id), style: { cursor: 'pointer' } })}
              rowClassName={(r) =>
                r.id === selectedProviderId
                  ? '[&>td]:bg-accent-light!'
                  : 'hover:[&>td]:bg-accent-soft!'
              }
              pagination={false}
              scroll={{ x: 1030 }}
            />
          </div>

          {/* ② 选中 Provider 的模型（全宽） */}
          <div className="border-t border-border pt-6">
            {selectedProvider ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Space>
                    <Text strong>{selectedProvider.name}</Text>
                    <StatusTag tone="primary">{selectedProvider.code}</StatusTag>
                    <Text className="text-xs text-text-secondary">{selectedProvider.baseUrl}</Text>
                  </Space>
                  <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => openModelModal()}>新增模型</Button>
                </div>
                <Table
                  dataSource={filteredModels}
                  columns={modelColumns}
                  rowKey="id"
                  loading={loadingModels}
                  size="small"
                  pagination={false}
                  scroll={{ x: 900 }}
                  locale={{ emptyText: (
                    <div className="py-6 text-center">
                      <Text className="text-sm text-text-disabled">该 Provider 下还没有模型</Text>
                      <div className="mt-1">
                        <Text className="text-xs text-text-disabled">点右上角「新增模型」添加</Text>
                      </div>
                    </div>
                  ) }}
                />
              </div>
            ) : (
              <div className="min-h-[200px] flex items-center justify-center border border-dashed border-border rounded-lg">
                <Text className="text-sm text-text-disabled">← 点击上方 Provider 查看其模型</Text>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* 适配器库：高级操作，折叠收纳。Adapter 描述如何与上游通信，可在 Provider 编辑时选用 */}
      <Collapse
        ghost
        items={[{
          key: 'adapter-lib',
          label: <Space><ApiOutlined />适配器库（高级）<Text className="text-xs text-text-disabled">自定义上游协议适配代码</Text></Space>,
          children: <AdapterManager />,
        }]}
      />

      {/* Provider Modal */}
      <Modal
        title={editingProvider ? '编辑 Provider' : '新增 Provider'}
        open={providerModalOpen} onCancel={() => setProviderModalOpen(false)}
        onOk={saveProvider} confirmLoading={saving} width={560}
      >
        <Form form={providerForm} layout="vertical" className="mt-4">
          <Form.Item name="name" label="显示名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：custom-provider" />
          </Form.Item>
          <Form.Item name="code" label="代码标识" rules={[{ required: true, message: '请输入代码' }]}
            extra="唯一标识符，例如 custom-provider。创建后不可修改">
            <Input placeholder="custom-provider" disabled={!!editingProvider} />
          </Form.Item>

          <Form.Item name="adapterId" label="适配器" extra="选择上游协议适配器。没有合适的？前往底部「适配器库」创建自定义协议。">
            <Select
              placeholder="选择适配器（留空使用内置 OpenAI 兼容适配器）"
              allowClear
              loading={loadingAdapters}
              options={adapters.map((a) => ({ value: a.id, label: `${a.name}${a.isBuiltin ? '（内置）' : '（自定义）'}` }))}
            />
          </Form.Item>

          <Form.Item name="baseUrl" label="接口地址" rules={[{ required: true, message: '请输入接口地址' }]}
            extra="OpenAI 兼容格式：https://api.example.com/v1 (会自动拼接 /chat/completions)">
            <Input placeholder="https://api.example.invalid/v1" />
          </Form.Item>
          <Form.Item name="apiKey" label="API Key" extra={editingProvider ? '留空则不修改已有 Key' : 'Provider 的 API 密钥'}>
            <Input.Password placeholder={editingProvider ? '留空保持现有' : 'sk-...'} />
          </Form.Item>
          <Form.Item name="configJson" label="扩展配置 (configJson)"
            extra={"Adapter 自定义参数，JSON 格式。例如 {\"/images/generations\": {}}"}>
            <Input.TextArea rows={3} placeholder='{}' />
          </Form.Item>
          <Form.Item name="isActive" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      {/* Model Modal */}
      <Modal
        title={editingModel ? '编辑模型' : '新增模型'}
        open={modelModalOpen} onCancel={() => setModelModalOpen(false)}
        onOk={saveModel} confirmLoading={saving} width={640}
      >
        <Form form={modelForm} layout="vertical" className="mt-4">
          {/* 第一步：先选「模型类型」——不同类型配置项差别很大（文本要上下文、
              图片要比例档位、视频要时长/分辨率/素材上限），先定类型再展示对应表单，
              避免「所有模型共用一个大表单、一堆用不到的字段」。
              编辑已有模型时类型可切换（切换仅影响展示，保存时才落库）。 */}
          <Form.Item name="type" rules={[{ required: true, message: '请选择模型类型' }]} className="mb-5">
            <ModelTypePicker />
          </Form.Item>

          <Form.Item name="name" label="显示名称" rules={[{ required: true }]}
            extra="用户界面显示的模型名称，如 'GPT-4o'">
            <Input placeholder="GPT-4o" />
          </Form.Item>
          <Form.Item name="modelName" label="上游模型标识"
            extra="发送给 Provider API 的 model 参数值。留空则使用显示名称">
            <Input placeholder="openai/gpt-4o" />
          </Form.Item>
          <Form.Item name="providerId" label="所属 Provider" rules={[{ required: true }]}>
            <Select
              placeholder="选择 Provider"
              onChange={() => setProviderModels([])}
              options={providers.filter(p => p.isActive).map((p) => ({ value: p.id, label: `${p.name} (${p.code})` }))}
            />
          </Form.Item>

          <div className="flex items-end gap-2 mb-6">
            <div className="flex-1">
              <Text className="text-xs text-text-secondary">通过上游 /models 接口加载可用模型列表，选择后自动填充上游模型标识</Text>
            </div>
            <Button
              icon={loadingProviderModels ? <LoadingOutlined /> : <ReloadOutlined />}
              onClick={loadProviderModels}
              loading={loadingProviderModels}
            >
              加载模型列表
            </Button>
          </div>

          {providerModels.length > 0 && (
            <Form.Item label="从上游模型中选择">
              <Select
                showSearch
                placeholder={`已加载 ${providerModels.length} 个模型，选择以填充上游标识`}
                optionFilterProp="label"
                options={providerModels.map((m) => ({ value: m.id, label: m.id }))}
                onSelect={(value: string) => {
                  modelForm.setFieldsValue({ modelName: value })
                  if (!modelForm.getFieldValue('name')) {
                    modelForm.setFieldsValue({ name: value.split('/').pop() || value })
                  }
                }}
              />
            </Form.Item>
          )}

          <div className="grid grid-cols-3 gap-4">
            <Form.Item name="pricingType" label="计费方式" rules={[{ required: true }]}>
              <Select options={[{ value: 'PER_TOKEN', label: '按 Token' }, { value: 'PER_CALL', label: '按次' }]} />
            </Form.Item>
            <Form.Item
              name="costPoints"
              label="消耗积分 / 单价"
              rules={[{ required: true, message: '必填' }]}
              extra="按类型语义不同：文本=每次调用积分、图片=1K 参考价、视频=见下方豆价、音频=按次积分。支持小数。"
            >
              <InputNumber min={0} max={100000} step={0.1} precision={2} className="w-full" />
            </Form.Item>
            <Form.Item name="discount" label="促销折扣率 (0~1，留空=无)" className="mb-0">
              <InputNumber min={0.01} max={1} step={0.05} className="w-full" placeholder="如 0.8 = 八折" />
            </Form.Item>
            <Form.Item name="discountStartsAt" label="折扣开始时间" className="mb-0">
              <DatePicker showTime className="w-full" placeholder="留空 = 立即生效" />
            </Form.Item>
            <Form.Item name="discountEndsAt" label="折扣结束时间" className="mb-0"
              extra="限时活动价：到点自动恢复原价，无需手动改回">
              <DatePicker showTime className="w-full" placeholder="留空 = 一直生效" />
            </Form.Item>
            <Form.Item name="isFree" label="促销免费" valuePropName="checked" className="mb-0">
              <Switch />
            </Form.Item>
          </div>

          {/* 全平台每日免费额度：两级同时生效，任一耗尽即按正常价计费；每日 0 点重置 */}
          <div className="bg-surface rounded-lg p-4 mb-4">
            <Text strong className="text-sm mb-1 block">每日免费额度</Text>
            <Text type="secondary" className="text-xs block mb-3">
              两级额度同时生效，任一耗尽即按正常价计费；每日 0 点自动重置。留空或 0 = 不参与免费额度。
            </Text>
            <div className="grid grid-cols-2 gap-4">
              <Form.Item name="dailyUserFreeQuota" label="每用户每天免费次数" className="mb-0"
                extra="例：10 = 每个用户每天前 10 次免费">
                <InputNumber min={0} max={100000} className="w-full" placeholder="留空 = 关闭" />
              </Form.Item>
              <Form.Item name="dailyPlatformFreeQuota" label="全平台每天总次数上限" className="mb-0"
                extra="例：300 = 该模型全平台每天最多免费 300 次">
                <InputNumber min={0} max={1000000} className="w-full" placeholder="留空 = 平台侧不限" />
              </Form.Item>
            </div>
            {/* 免费额度按「次数」计，但生图成本随档位翻倍。不限制档位的话，
                用户能把 10 次免费额度全用在 4K 上 —— 平台按 1K 的价位备额度、付 4K 的成本。 */}
            <Form.Item
              name={['metadata', 'freeQuotaMaxTier']}
              label="免费额度可用档位上限"
              className="mb-0 mt-3"
              extra="超出此档位的生成不走免费额度，按正常价扣积分（用户仍可付费出 4K）。留空 = 不限制档位。仅对图片模型生效。"
            >
              <Select
                allowClear
                className="w-full"
                placeholder="不限制档位"
                options={[
                  { value: '1K', label: '仅 1K' },
                  { value: '2K', label: '1K + 2K' },
                  { value: '4K', label: '1K + 2K + 4K（不限制）' },
                ]}
              />
            </Form.Item>
          </div>

          {/* Type-specific fields */}
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.type !== cur.type}>
            {({ getFieldValue }) => {
              const t = getFieldValue('type') as string
              if (t === 'TEXT' || t === 'VISION') {
                return (
                  <div className="bg-surface rounded-lg p-4 mb-4">
                    <Text strong className="text-sm mb-3 block">{t === 'VISION' ? '多模态读图模型配置' : '语言模型配置'}</Text>
                    <div className="grid grid-cols-2 gap-4">
                      <Form.Item name="contextWindow" label="上下文窗口 (Tokens)" className="mb-0">
                        <InputNumber min={1} max={2000000} className="w-full" placeholder="128000" />
                      </Form.Item>
                      <Form.Item name="supportsVision" label="支持图片输入" valuePropName="checked" className="mb-0"
                        extra={t === 'VISION' ? '多模态模型默认支持读图' : '支持读图的语言模型可开启'}>
                        <Switch />
                      </Form.Item>
                    </div>
                    <Form.Item name={['metadata', 'think']} label="思考增强 (Think)" valuePropName="checked" className="mt-3 mb-0">
                      <Switch />
                    </Form.Item>
                    <Form.Item
                      name={['metadata', 'imageTransport']}
                      label="图片传输方式"
                      className="mt-3 mb-0"
                      extra="仅影响此模型读图。未设置时沿用供应商配置；无供应商配置时，站内图压缩后内联，外链用 URL。"
                    >
                      <Select
                        allowClear
                        placeholder="沿用供应商配置"
                        options={[
                          { value: 'url', label: '公网 URL（兼容只认链接的模型）' },
                          { value: 'base64', label: '优先内联 Base64（含可下载的外链）' },
                          { value: 'auto', label: '自动（站内图内联，外链用 URL）' },
                        ]}
                      />
                    </Form.Item>
                  </div>
                )
              }
              if (t === 'IMAGE') {
                return (
                  <div className="bg-surface rounded-lg p-4 mb-4">
                    <Text strong className="text-sm mb-3 block">生图模型配置</Text>
                    <Paragraph className="text-xs text-text-secondary mb-3">
                      生图模型要求 Provider 支持 OpenAI 兼容的 <Text code>/v1/images/generations</Text> 接口。
                    </Paragraph>
                    <Form.Item name={['metadata', 'modes']} label="生成模式" className="mb-0">
                      <Checkbox.Group options={[
                        { label: '文生图 (text)', value: 'text' },
                        { label: '单图编辑 (singleImage)', value: 'singleImage' },
                        { label: '多图参考 (multiReference)', value: 'multiReference' },
                      ]} />
                    </Form.Item>
                    <Form.Item
                      name={['metadata', 'rehost']}
                      label="转存图片到本站"
                      valuePropName="checked"
                      className="mt-4 mb-0"
                      extra="默认关闭：直接用上游链接（省一次下载与磁盘写入，但链接过期后图片失效，用户需尽快保存）。开启后落盘到本站，长期可用。"
                    >
                      <Switch />
                    </Form.Item>
                    <Form.Item
                      name={['metadata', 'sizeRatios']}
                      label="可用比例"
                      className="mt-4 mb-0"
                      extra="勾选后用户只能选这些比例；全部不勾 = 不限制尺寸"
                    >
                      {/* 14 个比例在窄列里排成一行会溢出到右边界（AntD Checkbox.Group
                          的外层 flex 不作用到内部 item），改用手动网格逐个渲染，自动折行。 */}
                      <Checkbox.Group className="w-full">
                        <div className="grid grid-cols-4 gap-x-2 gap-y-1.5 sm:grid-cols-5">
                          {ASPECT_RATIOS.map((r) => (
                            <Checkbox key={r} value={r} className="!m-0 text-xs">{r}</Checkbox>
                          ))}
                        </div>
                      </Checkbox.Group>
                    </Form.Item>
                    <Form.Item
                      name={['metadata', 'sizeTiers']}
                      label="分辨率档位"
                      className="mt-4 mb-0"
                      extra="与比例组合生成尺寸预设（1:1·1K=1024x1024 … 9:21·4K=1648x3840）"
                    >
                      <Checkbox.Group options={RES_TIERS.map((t) => ({ label: t, value: t }))} />
                    </Form.Item>
                    <Text strong className="text-sm block mt-4 mb-2">各档位积分（留空 = 用上面的参考价）</Text>
                    <Text type="secondary" className="text-xs block mb-2">
                      只填了「1K」时，2K/4K 会沿用 1K 的价格；想区分定价就各自填上。支持小数。
                    </Text>
                    <div className="grid grid-cols-3 gap-3">
                      <Form.Item name={['metadata', 'tierCost1K']} label="1K 积分" className="mb-0">
                        <InputNumber min={0} max={100000} step={0.1} precision={2} className="w-full" placeholder="用参考价" />
                      </Form.Item>
                      <Form.Item name={['metadata', 'tierCost2K']} label="2K 积分" className="mb-0">
                        <InputNumber min={0} max={100000} step={0.1} precision={2} className="w-full" placeholder="用参考价" />
                      </Form.Item>
                      <Form.Item name={['metadata', 'tierCost4K']} label="4K 积分" className="mb-0">
                        <InputNumber min={0} max={100000} step={0.1} precision={2} className="w-full" placeholder="用参考价" />
                      </Form.Item>
                    </div>
                  </div>
                )
              }
              if (t === 'VIDEO') {
                return (
                  <div className="bg-surface rounded-lg p-4 mb-4">
                    <Text strong className="text-sm mb-3 block">视频模型配置</Text>
                    <div className="grid grid-cols-2 gap-4">
                      <Form.Item
                        name="videoCost"
                        label="按条计费（豆/条）"
                        className="mb-0"
                        extra="按生成条数扣豆，三种生成方式同价。与下方「统一按秒」二选一（都填则按秒优先）；配了高级计费因子后以高级区为准。"
                      >
                        <InputNumber min={1} max={100000} className="w-full" />
                      </Form.Item>
                      <Form.Item name={['metadata', 'perSecondBeans']} label="统一按秒（豆/秒）" className="mb-0"
                        extra="不区分分辨率时用：生成时长 × 单价。与按条可同时作为兜底，但建议只留一种口径。">
                        <InputNumber min={1} max={100000} className="w-full" placeholder="如 1 = 每秒 1 豆" />
                      </Form.Item>
                      <Form.Item name={['metadata', 'audio']} label="音频支持" className="mb-0">
                        <Select
                          options={[
                            { value: false, label: '不支持音频' },
                            { value: 'optional', label: '可选音频' },
                            { value: true, label: '始终生成音频' },
                          ]}
                        />
                      </Form.Item>
                      <Form.Item
                        name={['metadata', 'rehost']}
                        label="转存到本站"
                        valuePropName="checked"
                        className="mb-0"
                        extra="默认关闭：直接用上游链接。开启后落盘到本站，长期可用。"
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item
                        name={['metadata', 'video', 'exclusiveTool']}
                        label="仅限专属工具"
                        valuePropName="checked"
                        className="mb-0"
                        extra="开启后不进入通用「视频模型」选择器。数字人对口型 / 动作迁移固定走各自工具。"
                      >
                        <Switch />
                      </Form.Item>
                    </div>

                    {/* 计价口径回显：引擎优先级 spec(billing) > perSecondBeans > videoCost，
                        三套字段同时存在时后台必须说清楚「哪一套真的在生效」，否则运营会以为改价生效了。 */}
                    <Form.Item noStyle shouldUpdate>
                      {(form) => {
                        const vv = (form.getFieldValue(['metadata', 'video']) ?? {}) as Record<string, unknown>
                        const billing = (vv.billing ?? {}) as Record<string, unknown>
                        const perRes = (billing.perSecondByResolution ?? {}) as Record<string, unknown>
                        const hasSpec = Number(billing.perCall) > 0
                          || Number(billing.perOutputSecond) > 0
                          || Number(billing.perInputImage) > 0
                          || Number(billing.perInputAudioSecond) > 0
                          || Number(billing.perInputVideoSecond) > 0
                          || Object.values(perRes).some((x) => Number(x) > 0)
                        const perSecond = Number(form.getFieldValue(['metadata', 'perSecondBeans'])) > 0
                        const perCall = Number(form.getFieldValue('videoCost')) > 0
                        let text = '尚未配置豆价：保存会被拦截，用户无法使用'
                        if (hasSpec) {
                          const bits: string[] = []
                          if (Number(billing.perCall) > 0) bits.push(`按条 ${billing.perCall} 豆`)
                          if (Number(billing.perOutputSecond) > 0) bits.push(`按秒 ${billing.perOutputSecond} 豆/秒`)
                          const resBits = Object.entries(perRes).filter(([, x]) => Number(x) > 0)
                            .map(([k, x]) => `${k} ${x}`)
                          if (resBits.length > 0) bits.push(`分档 ${resBits.join(' / ')} 豆/秒`)
                          const inputRes = (billing.perInputVideoSecondByResolution ?? {}) as Record<string, unknown>
                          const inputResBits = Object.entries(inputRes).filter(([, x]) => Number(x) > 0)
                          if (inputResBits.length > 0) {
                            bits.push(`参考视频 ${inputResBits.map(([k, x]) => `${k} ${x}`).join(' / ')} 豆/秒`)
                          } else if (Number(billing.perInputVideoSecond) > 0) {
                            bits.push(`参考视频 ${billing.perInputVideoSecond} 豆/秒`)
                          }
                          if (Number(billing.perInputAudioSecond) > 0) bits.push(`参考音频 ${billing.perInputAudioSecond} 豆/秒`)
                          if (Number(billing.perInputImage) > 0) bits.push(`参考图 ${billing.perInputImage} 豆/张`)
                          text = `当前生效：高级因子 —— ${bits.join(' + ')}`
                        } else if (perSecond) {
                          text = `当前生效：统一按秒 ${form.getFieldValue(['metadata', 'perSecondBeans'])} 豆/秒`
                          if (perCall) text += `（上方按条价不生效）`
                        } else if (perCall) {
                          text = `当前生效：按条 ${form.getFieldValue('videoCost')} 豆/条`
                        }
                        return (
                          <div className={`mt-3 rounded-lg px-3 py-2 text-xs ${hasSpec || perSecond || perCall ? 'bg-emerald-50/70 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                            {text}
                          </div>
                        )
                      }}
                    </Form.Item>

                    {/* ===== 高级：计费因子 + 能力约束（声明式，见 lib/billing/billing-plans）=====
                        口袋更全的计费口径（按输入图/音频、组合计费）与提交前约束校验。
                        不填就回退上面的「一口价 / 豆每秒」。 */}
                    <Collapse
                      ghost
                      className="mt-3"
                      items={[{
                        key: 'adv',
                        label: <Text className="text-xs text-text-secondary">生成方式 / 输出规格 / 计费因子 / 素材能力</Text>,
                        children: (
                          <div className="grid grid-cols-2 gap-3">
                            <div className="col-span-2 mt-1 text-[11px] font-semibold uppercase tracking-wide text-black/40">
                              生成方式（决定使用端展示哪套输入面板）
                            </div>
                            <Form.Item
                              name={['metadata', 'video', 'constraints', 'modes']}
                              label="可用生成方式（勾 ≥2 种才会显示切换器）"
                              className="mb-0 col-span-2"
                              tooltip="文生视频只收提示词；首尾帧只收首帧/尾帧；全能参考按下方素材上限显示图/音频/视频口。只勾一种 = 单形态模型，不显示切换器。"
                            >
                              <Checkbox.Group className="w-full">
                                <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 sm:grid-cols-3">
                                  {Object.entries(VIDEO_MODE_LABELS).map(([value, label]) => (
                                    <Checkbox key={value} value={value} className="!m-0 text-xs">{label}</Checkbox>
                                  ))}
                                </div>
                              </Checkbox.Group>
                            </Form.Item>
                            <Form.Item
                              name={['metadata', 'video', 'constraints', 'durationSelectable']}
                              label="时长可选"
                              valuePropName="checked"
                              className="mb-0"
                              tooltip="上游工作流不收 duration（如动作迁移）时关掉，面板会隐藏整个时长选择行。"
                            >
                              <Switch />
                            </Form.Item>

                            <div className="col-span-2 mt-1 text-[11px] font-semibold uppercase tracking-wide text-black/40">
                              高级计费因子（可选，配置后覆盖上方按条 / 统一按秒）
                            </div>
                            <Form.Item name={['metadata', 'video', 'billing', 'perCall']} label="按条（豆/条）" className="mb-0">
                              <InputNumber min={0} className="w-full" placeholder="如 5.5" />
                            </Form.Item>
                            <Form.Item name={['metadata', 'video', 'billing', 'perOutputSecond']} label="按输出秒（豆/秒）" className="mb-0">
                              <InputNumber min={0} className="w-full" placeholder="如 0.5" />
                            </Form.Item>
                            {/* 按分辨率档定价：同一模型不同清晰度单价不同（如 480P ¥0.03/秒、
                                768P ¥0.04/秒）。填了就按所选档位取价，未填的档回退上面的按输出秒。 */}
                            <div className="col-span-2 rounded-lg border border-black/[0.07] bg-black/[0.02] px-3 py-2">
                              <Text className="text-xs text-text-secondary block mb-2">
                                按分辨率档定价（豆/秒，可选）—— 不填则用上面的「按输出秒」统一价
                              </Text>
                              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                                {VIDEO_RES_TIERS.map((r) => (
                                  <Form.Item
                                    key={r}
                                    name={['metadata', 'video', 'billing', 'perSecondByResolution', r]}
                                    label={r}
                                    className="mb-0"
                                  >
                                    <InputNumber min={0} className="w-full" placeholder="—" />
                                  </Form.Item>
                                ))}
                              </div>
                            </div>
                            <Form.Item name={['metadata', 'video', 'billing', 'perInputImage']} label="按输入图（豆/张）" className="mb-0">
                              <InputNumber min={0} className="w-full" placeholder="如 0.1" />
                            </Form.Item>
                            <Form.Item name={['metadata', 'video', 'billing', 'perInputAudioSecond']} label="按输入音频秒（豆/秒）" className="mb-0">
                              <InputNumber min={0} className="w-full" placeholder="如 0.2" />
                            </Form.Item>
                            {/* 输入参考视频可按输出档位定价。 */}
                            <div className="col-span-2 rounded-lg border border-black/[0.07] bg-black/[0.02] px-3 py-2">
                              <Text className="text-xs text-text-secondary block mb-2">
                                参考视频输入按输出档定价（豆/秒，可选）—— 不填则用上面的单值
                              </Text>
                              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                                {VIDEO_RES_TIERS.map((r) => (
                                  <Form.Item
                                    key={r}
                                    name={['metadata', 'video', 'billing', 'perInputVideoSecondByResolution', r]}
                                    label={r}
                                    className="mb-0"
                                  >
                                    <InputNumber min={0} className="w-full" placeholder="—" />
                                  </Form.Item>
                                ))}
                              </div>
                            </div>

                            <div className="col-span-2 mt-1 text-[11px] font-semibold uppercase tracking-wide text-black/40">
                              输出规格（使用端按此限制比例 / 分辨率 / 秒数）
                            </div>
                            <Form.Item name={['metadata', 'video', 'constraints', 'minDuration']} label="最短时长(秒)" className="mb-0">
                              <InputNumber min={1} className="w-full" placeholder="如 4" />
                            </Form.Item>
                            <Form.Item name={['metadata', 'video', 'constraints', 'maxDuration']} label="最长时长(秒)" className="mb-0">
                              <InputNumber min={1} className="w-full" placeholder="如 15" />
                            </Form.Item>
                            <Form.Item name={['metadata', 'video', 'constraints', 'fixedDuration']} label="固定时长(秒)" className="mb-0">
                              <InputNumber min={1} className="w-full" placeholder="固定档型号如 30" />
                            </Form.Item>
                            <Form.Item name={['metadata', 'video', 'constraints', 'durations']} label="离散时长（逗号分隔；留空 = 用最短~最长连续秒数）" className="mb-0 col-span-2">
                              <Input placeholder="如 5,10,15,30；留空则按 4~30 每秒可选" />
                            </Form.Item>
                            {/* 秒数回显：后台填的范围/离散值直接决定面板下拉，必须能一眼核对 */}
                            <Form.Item noStyle shouldUpdate>
                              {(form) => {
                                const c = (form.getFieldValue(['metadata', 'video', 'constraints']) ?? {}) as Record<string, unknown>
                                const durations = Array.isArray(c.durations)
                                  ? c.durations.map(Number).filter((n) => Number.isFinite(n) && n > 0)
                                  : (typeof c.durations === 'string' && c.durations.trim()
                                    ? c.durations.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
                                    : [])
                                const min = Number(c.minDuration)
                                const max = Number(c.maxDuration)
                                const fixed = Number(c.fixedDuration)
                                let text = '面板回退：5 / 10 / 15 秒（未声明时长规格）'
                                if (c.durationSelectable === false) text = '面板不显示时长选择（「时长可选」已关）'
                                else if (fixed > 0) text = `面板固定：${fixed} 秒`
                                else if (durations.length > 0) text = `面板离散档：${[...new Set(durations)].sort((a, b) => a - b).join(' / ')} 秒`
                                else if (min > 0 && max >= min) text = `面板连续档：${min}–${max} 秒（共 ${max - min + 1} 档）`
                                return <div className="col-span-2 -mt-1 rounded-lg bg-black/[0.03] px-3 py-1.5 text-[11px] text-black/50">{text}</div>
                              }}
                            </Form.Item>
                            <Form.Item name={['metadata', 'video', 'constraints', 'ratios']} label="支持比例（不勾=不限制）" className="mb-0 col-span-2">
                              <Checkbox.Group className="w-full">
                                <div className="grid grid-cols-4 gap-x-2 gap-y-1.5 sm:grid-cols-6">
                                  {VIDEO_RATIO_OPTIONS.map((r) => (
                                    <Checkbox key={r} value={r} className="!m-0 text-xs">{r}</Checkbox>
                                  ))}
                                </div>
                              </Checkbox.Group>
                            </Form.Item>
                            <Form.Item name={['metadata', 'video', 'constraints', 'resolutions']} label="支持分辨率（不勾=不限制）" className="mb-0 col-span-2">
                              <Checkbox.Group options={VIDEO_RES_OPTIONS.map((r) => ({ label: r, value: r }))} />
                            </Form.Item>
                            <div className="col-span-2 mt-1 text-[11px] font-semibold uppercase tracking-wide text-black/40">
                              全能参考素材上限（0 = 不支持该素材，面板会隐藏对应输入口）
                            </div>
                            <Form.Item name={['metadata', 'video', 'constraints', 'maxImages']} label="最多参考图" className="mb-0">
                              <InputNumber min={0} className="w-full" placeholder="如 9" />
                            </Form.Item>
                            <Form.Item name={['metadata', 'video', 'constraints', 'maxVideos']} label="最多参考视频" className="mb-0">
                              <InputNumber min={0} className="w-full" placeholder="如 1" />
                            </Form.Item>
                            <Form.Item name={['metadata', 'video', 'constraints', 'maxAudios']} label="最多参考音频" className="mb-0">
                              <InputNumber min={0} className="w-full" placeholder="如 3" />
                            </Form.Item>
                            <div className="col-span-2 mt-1 text-[11px] font-semibold uppercase tracking-wide text-black/40">
                              必填素材（提交前校验，避免上游失败再退款）
                            </div>
                            <Form.Item name={['metadata', 'video', 'constraints', 'requireImage']} label="必须提供参考图" valuePropName="checked" className="mb-0">
                              <Switch />
                            </Form.Item>
                            <Form.Item
                              name={['metadata', 'video', 'constraints', 'requireVideo']}
                              label="必须提供参考视频"
                              valuePropName="checked"
                              className="mb-0"
                              tooltip="动作迁移这类工作流必须有动作视频。只有「最多N个」表达不了「至少1个」，缺这个开关空值会提交给上游然后失败扣费。"
                            >
                              <Switch />
                            </Form.Item>
                            <Form.Item
                              name={['metadata', 'video', 'constraints', 'requireAudio']}
                              label="必须提供参考音频"
                              valuePropName="checked"
                              className="mb-0"
                              tooltip="对口型这类工作流必须有音频。同 requireVideo。"
                            >
                              <Switch />
                            </Form.Item>
                          </div>
                        ),
                      }]}
                    />
                  </div>
                )
              }
              if (t === 'AUDIO') {
                return (
                  <div className="bg-surface rounded-lg p-4 mb-4">
                    <Text strong className="text-sm mb-3 block">音频模型配置</Text>
                    <Form.Item name={['metadata', 'kind']} label="音频能力" className="mb-0">
                      <Select
                        allowClear
                        placeholder="选音频能力（音乐/配音/音效/人声分离/识别）"
                        options={[
                          { value: 'music', label: '音乐生成 (music)' },
                          { value: 'tts', label: '配音 TTS (tts)' },
                          { value: 'sfx', label: '音效生成 (sfx)' },
                          { value: 'isolate', label: '人声分离 (isolate)' },
                          { value: 'asr', label: '语音识别 ASR (asr)' },
                        ]}
                      />
                    </Form.Item>
                    <Form.Item name={['metadata', 'perSecondCost']} label="积分/秒（按时长计费，可选）" className="mt-3 mb-0"
                      extra="音频生成/音效填了则按 时长 × 单价 扣积分（音效/可指定时长的音乐）；未填时按次（costPoints）">
                      <InputNumber min={1} max={100000} className="w-full" placeholder="如 2 = 每秒 2 积分" />
                    </Form.Item>
                    <Form.Item
                      name={['metadata', 'rehost']}
                      label="转存到本站"
                      valuePropName="checked"
                      className="mt-3 mb-0"
                      extra="默认关闭：直接用上游链接。开启后落盘到本站，长期可用。"
                    >
                      <Switch />
                    </Form.Item>
                  </div>
                )
              }
              return null
            }}
          </Form.Item>

          <Form.Item name="isActive" label="启用此模型" valuePropName="checked">
            <Switch />
          </Form.Item>
          {/* 「启用」= 能不能跑；「对外展示」= 要不要让用户在价格页/模型列表看到。
              两者必须分开：测试模型、灰度 alpha 模型能跑，但不该出现在用户面前。 */}
          <Form.Item
            name="isPublic"
            label="对外展示"
            valuePropName="checked"
            extra="关闭后，用户在价格页与模型列表都看不到这个模型（内部仍可调用）。测试模型 / 灰度版建议关闭。"
          >
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

    </div>
  )
}

/** 模型类型选择卡：先定类型，再展示对应配置（区别很大，不能共用一个表单） */
const MODEL_TYPE_META: Array<{ value: string; label: string; desc: string; icon: React.ReactNode }> = [
  { value: 'TEXT', label: '文本模型', desc: '对话/推理，按 Token 计费', icon: <FileTextOutlined /> },
  { value: 'VISION', label: '读图模型', desc: '多模态，能看图的对话模型', icon: <PictureOutlined /> },
  { value: 'IMAGE', label: '图片模型', desc: '文生图 / 图生图，按档位积分', icon: <PictureOutlined /> },
  { value: 'VIDEO', label: '视频模型', desc: '文生/图生视频，按豆计费', icon: <VideoCameraOutlined /> },
  { value: 'AUDIO', label: '音频模型', desc: '音乐 / 配音 / 音效 / 识别', icon: <SoundOutlined /> },
]

function ModelTypePicker({ value, onChange }: { value?: string; onChange?: (v: string) => void }) {
  return (
    <div className="grid grid-cols-5 gap-2">
      {MODEL_TYPE_META.map((m) => {
        const on = value === m.value
        return (
          <button
            key={m.value}
            type="button"
            onClick={() => onChange?.(m.value)}
            className={`flex flex-col items-center gap-1 rounded-xl border px-2 py-3 text-center transition ${
              on
                ? 'border-accent bg-accent-soft text-accent shadow-sm'
                : 'border-black/8 bg-white text-black/60 hover:border-accent-ring hover:text-accent'
            }`}
          >
            <span className="text-lg">{m.icon}</span>
            <span className="text-[12px] font-medium">{m.label}</span>
          </button>
        )
      })}
    </div>
  )
}

function buildMetadata(type: string, values: Record<string, unknown>): Record<string, unknown> | null {
  if (type === 'TEXT' || type === 'VISION') {
    const meta: Record<string, unknown> = {}
    const think = values.metadata && typeof values.metadata === 'object' ? (values.metadata as Record<string, unknown>).think : undefined
    if (think !== undefined) meta.think = think
    const transport = values.metadata && typeof values.metadata === 'object' ? (values.metadata as Record<string, unknown>).imageTransport : undefined
    if (transport === 'url' || transport === 'base64' || transport === 'auto') meta.imageTransport = transport
    if (Object.keys(meta).length === 0) return null
    return meta
  }
  if (type === 'IMAGE') {
    const meta = values.metadata && typeof values.metadata === 'object' ? (values.metadata as Record<string, unknown>) : {}
    const modes = meta.modes
    const ratios = Array.isArray(meta.sizeRatios) ? (meta.sizeRatios as string[]) : []
    const tiers = Array.isArray(meta.sizeTiers) ? (meta.sizeTiers as string[]) : []
    const result: Record<string, unknown> = {}
    if (modes && Array.isArray(modes) && modes.length > 0) result.modes = modes
    // 转存开关（默认关）：显式勾选才写入，避免存一堆 false
    if (meta.rehost === true) result.rehost = true
    // 勾选了比例+档位才生成尺寸预设；只勾一边视为未配置（不限制）
    if (ratios.length > 0 && tiers.length > 0) result.sizes = expandSizes(ratios, tiers)
    // 档位差价：仅保留勾选档位的定价
    for (const t of RES_TIERS) {
      const v = meta[`tierCost${t}`]
      // 保留小数（roundPoints 在提交时统一处理）
      if (tiers.includes(t) && v != null && v !== '') result[`tierCost${t}`] = Number(v)
    }
    // 免费额度档位上限（freeQuotaMaxTier）：空值/未选 = 不限制，保持既有行为
    if (typeof meta.freeQuotaMaxTier === 'string' && meta.freeQuotaMaxTier.trim() !== '') {
      result.freeQuotaMaxTier = meta.freeQuotaMaxTier.trim().toUpperCase()
    }
    // 只填了 1K 没填参考价时，用 1K 价补上参考价，避免「参考价空缺 + 档位价存在」的歧义
    if (result.tierCost1K != null && (values.costPoints == null || values.costPoints === '')) {
      values.costPoints = result.tierCost1K
    }
    if (Object.keys(result).length === 0) return null
    return result
  }
  if (type === 'VIDEO') {
    const meta = values.metadata && typeof values.metadata === 'object' ? (values.metadata as Record<string, unknown>) : {}
    const result: Record<string, unknown> = {}
    if (meta.audio !== undefined) result.audio = meta.audio
    // 按秒豆价：此前这里漏了 perSecondBeans —— 后台填了也被丢掉，
    // 导致「按秒计价」永远配不上（只能走 videoCost 一口价）。
    if (meta.perSecondBeans != null && meta.perSecondBeans !== '') result.perSecondBeans = Number(meta.perSecondBeans)
    if (meta.rehost === true) result.rehost = true
    // 高级：计费因子 + 能力约束（声明式视频规格）。
    // 表单里用点号路径收集，这里组装成 { billing, constraints }；
    // 逗号分隔的输入（分辨率/比例）拆成数组；空值剔除，避免存一堆 null。
    const v = (meta.video && typeof meta.video === 'object' ? meta.video : {}) as Record<string, unknown>
    // 专属工具标记：不让该模型出现在通用视频模型选择器里
    if (v.exclusiveTool === true) result.exclusiveTool = true
    const billing = (v.billing && typeof v.billing === 'object' ? v.billing : {}) as Record<string, unknown>
    const constraints = (v.constraints && typeof v.constraints === 'object' ? v.constraints : {}) as Record<string, unknown>
    const cleanNum = (o: Record<string, unknown>) => Object.fromEntries(
      Object.entries(o).filter(([, x]) => x != null && x !== '').map(([k, x]) => [k, Number(x)]),
    )
    const splitList = (x: unknown): string[] | undefined =>
      typeof x === 'string' && x.trim() ? x.split(',').map((s) => s.trim()).filter(Boolean) : undefined
    // 勾选组给的是数组（新）；兼容旧的逗号字符串写法
    const normList = (x: unknown): string[] | undefined =>
      Array.isArray(x) ? (x.filter((v): v is string => typeof v === 'string' && !!v).length > 0
        ? x.filter((v): v is string => typeof v === 'string' && !!v) : undefined)
        : splitList(x)
    const video: Record<string, unknown> = {}
    // 按分辨率档定价是**嵌套对象**，不能走 cleanNum（Number(obj) = NaN）。
    // 先摘出来单独清洗，再把剩下的标量因子走 cleanNum。
    const perResRaw = (billing.perSecondByResolution && typeof billing.perSecondByResolution === 'object'
      ? billing.perSecondByResolution : {}) as Record<string, unknown>
    const perResClean = Object.fromEntries(
      Object.entries(perResRaw)
        .filter(([, x]) => x != null && x !== '')
        .map(([k, x]) => [k, Number(x)])
        .filter(([, n]) => Number.isFinite(n as number) && (n as number) >= 0),
    )
    // 同样是嵌套对象，必须单独清洗，否则 Number(obj)=NaN 存成 null。
    const inputPerResRaw = (billing.perInputVideoSecondByResolution && typeof billing.perInputVideoSecondByResolution === 'object'
      ? billing.perInputVideoSecondByResolution : {}) as Record<string, unknown>
    const inputPerResClean = Object.fromEntries(
      Object.entries(inputPerResRaw)
        .filter(([, x]) => x != null && x !== '')
        .map(([k, x]) => [k, Number(x)])
        .filter(([, n]) => Number.isFinite(n as number) && (n as number) >= 0),
    )
    const { perSecondByResolution: _drop, perInputVideoSecondByResolution: _drop2, ...billingScalar } = billing
    const billingClean = cleanNum(billingScalar)
    if (Object.keys(perResClean).length > 0) billingClean.perSecondByResolution = perResClean
    if (Object.keys(inputPerResClean).length > 0) billingClean.perInputVideoSecondByResolution = inputPerResClean
    if (Object.keys(billingClean).length > 0) video.billing = billingClean
    // 非标量字段必须先摘出去：cleanNum 会对每个值做 Number()，
    // 数组/逗号串会变成 NaN 再被 JSON 序列化成 null ——
    // 「modes / durations 后台一保存就消失」就是这么来的。
    const durRaw = constraints.durations
    const durationSelectable = constraints.durationSelectable
    const scalarConstraints: Record<string, unknown> = { ...constraints }
    for (const key of ['durations', 'resolutions', 'ratios', 'modes', 'durationSelectable']) delete scalarConstraints[key]
    const constraintsClean: Record<string, unknown> = cleanNum(scalarConstraints)
    const numList = (x: unknown): number[] | undefined => {
      const list = Array.isArray(x) ? x : (typeof x === 'string' && x.trim() ? x.split(',') : [])
      const out = list.map((s) => Number(String(s).trim())).filter((n) => Number.isFinite(n) && n > 0)
      return out.length > 0 ? out : undefined
    }
    const durations = numList(durRaw)
    if (durations) constraintsClean.durations = durations; else delete constraintsClean.durations
    const res = normList(constraints.resolutions)
    const ratios = normList(constraints.ratios)
    const modes = normList(constraints.modes)
    if (res) constraintsClean.resolutions = res; else delete constraintsClean.resolutions
    if (ratios) constraintsClean.ratios = ratios; else delete constraintsClean.ratios
    if (modes) constraintsClean.modes = modes; else delete constraintsClean.modes
    // 默认可选；只有显式关掉才写入 false
    if (durationSelectable === false) constraintsClean.durationSelectable = false; else delete constraintsClean.durationSelectable
    if (constraints.requireImage === true) constraintsClean.requireImage = true; else delete constraintsClean.requireImage
    // requireVideo / requireAudio：2026-10-18 新增。与 requireImage 同理，
    // 只保存 true、false 时删掉，避免 metadata 里堆一串 `requireVideo:false` 噪音。
    if (constraints.requireVideo === true) constraintsClean.requireVideo = true; else delete constraintsClean.requireVideo
    if (constraints.requireAudio === true) constraintsClean.requireAudio = true; else delete constraintsClean.requireAudio
    if (Object.keys(constraintsClean).length > 0) video.constraints = constraintsClean
    if (Object.keys(video).length > 0) result.video = video
    if (Object.keys(result).length === 0) return null
    return result
  }
  if (type === 'AUDIO') {
    // 音频模型：保留能力类型(kind) / 按秒单价(perSecondCost) / 转存开关(rehost)
    const meta = values.metadata && typeof values.metadata === 'object' ? (values.metadata as Record<string, unknown>) : {}
    const result: Record<string, unknown> = {}
    if (meta.kind !== undefined && meta.kind !== null && meta.kind !== '') result.kind = meta.kind
    if (meta.perSecondCost != null && meta.perSecondCost !== '') result.perSecondCost = Number(meta.perSecondCost)
    if (meta.rehost === true) result.rehost = true
    if (Object.keys(result).length === 0) return null
    return result
  }
  return null
}
