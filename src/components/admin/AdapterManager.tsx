'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Card,
  Table,
  Button,
  Form,
  Input,
  Select,
  Switch,
  Modal,
  Tag,
  Space,
  Popconfirm,
  Typography,
  Tooltip,
  App,
} from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  EyeOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  ApiOutlined,
  ImportOutlined,
  CopyOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { StatusTag } from '@/components/ui/StatusTag'
import { apiFetch } from '@/lib/api-client'
import type { ProviderAdapter } from '@/types'

const { Text, Paragraph } = Typography

type AdapterItem = ProviderAdapter & {
  sourcePreview?: string
}

const BUILTIN_SOURCE = `const adapter = {
  name: 'OpenAI Compatible',
  version: '1.0.0',
  description: 'Standard OpenAI API compatible adapter',

  buildChatRequest(config, params) {
    return {
      path: '/chat/completions',
      body: {
        model: config.modelName,
        messages: params.messages,
        stream: params.stream ?? true,
        temperature: params.temperature ?? 0.7,
        max_tokens: params.maxTokens,
      },
    }
  },

  parseChatStreamChunk(chunk) {
    const lines = chunk.split('\\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue
      const data = trimmed.slice(6)
      if (data === '[DONE]') return null
      try {
        const parsed = JSON.parse(data)
        const choice = parsed.choices?.[0]
        const content = choice?.delta?.content
        const reasoning = choice?.delta?.reasoning_content || choice?.delta?.reasoning
        const finishReason = choice?.finish_reason
        const usage = parsed.usage
        if (content !== undefined || reasoning !== undefined || finishReason || usage) {
          return { content, reasoning, finishReason, usage }
        }
      } catch {
        // skip malformed
      }
    }
    return null
  },

  parseChatResponse(body) {
    const choice = body.choices?.[0]
    const content = choice?.message?.content || ''
    const reasoning = choice?.message?.reasoning_content || choice?.message?.reasoning
    const finishReason = choice?.finish_reason || 'stop'
    return { content, reasoning, finishReason, usage: body.usage }
  },

  mapChatError(status, body) {
    const msg = body?.error?.message
    const suffix = msg ? ': ' + msg : ''
    if (status === 401 || status === 403) return 'Provider 认证失败，请检查 API Key' + suffix
    if (status === 429) return '请求频率过高，请稍后重试' + suffix
    if (status === 404) return '模型不存在或无权访问' + suffix
    if (status >= 500) return '上游服务异常' + suffix
    return '上游返回错误 (' + status + ')' + suffix
  },

  buildImageRequest(config, params) {
    const body = {
      model: config.modelName,
      prompt: params.prompt,
      n: 1,
    }
    if (params.width && params.height) {
      body.size = params.width + 'x' + params.height
    }
    return { path: '/images/generations', body }
  },

  parseImageResponse(body) {
    const item = body.data?.[0]
    if (!item) return {}
    if (item.url) return { imageUrl: item.url }
    if (item.b64_json) return { b64Json: item.b64_json }
    return {}
  },

  mapImageError(status, body) {
    const msg = body?.error?.message
    const suffix = msg ? ': ' + msg : ''
    if (status === 401 || status === 403) return 'Provider 认证失败，请检查 API Key' + suffix
    if (status === 429) return '请求频率过高，请稍后重试' + suffix
    if (status === 404) return '图像生成接口不存在或模型不可用' + suffix
    if (status >= 500) return '上游服务异常' + suffix
    return '上游返回错误 (' + status + ')' + suffix
  },

  buildTestRequest(config) {
    return { method: 'GET', path: '/models' }
  },

  parseTestResponse(response, body) {
    if (response.ok) return { ok: true, status: 'ok', message: '连接正常' }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, status: 'auth_error', message: '认证失败' }
    }
    return { ok: false, status: 'error', message: '连接失败' }
  },
}
`

export function AdapterManager() {
  const { message } = App.useApp()
  const [adapters, setAdapters] = useState<AdapterItem[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewSource, setPreviewSource] = useState('')
  const [editing, setEditing] = useState<AdapterItem | null>(null)
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [sourceValue, setSourceValue] = useState('')
  const [adapterTemplates, setAdapterTemplates] = useState<{ code: string; name: string; description: string; source: string }[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)

  // 加载可预置的多厂商模板（管理后台「从模板新建」）
  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true)
    try {
      const res = await apiFetch<{ code: string; name: string; description: string; source: string }[]>('/api/admin/adapters?templates=1')
      if (res.success && Array.isArray(res.data)) setAdapterTemplates(res.data)
    } catch { /* 模板加载失败不阻塞 */ }
    finally { setTemplatesLoading(false) }
  }, [])

  // 从源码中解析 name 和 description
  const parseAdapterInfo = (source: string): { name?: string; version?: string; description?: string } => {
    const info: { name?: string; version?: string; description?: string } = {}
    const nameMatch = source.match(/name\s*:\s*['"]([^'"]+)['"]/i)
    if (nameMatch) info.name = nameMatch[1]
    const versionMatch = source.match(/version\s*:\s*['"]([^'"]+)['"]/i)
    if (versionMatch) info.version = versionMatch[1]
    const descMatch = source.match(/description\s*:\s*['"]([^'"]+)['"]/i)
    if (descMatch) info.description = descMatch[1]
    return info
  }

  // 从模板一键填入 source + 自动解析 name/description
  const applyTemplate = useCallback((templateCode: string) => {
    const t = adapterTemplates.find((x) => x.code === templateCode)
    if (!t) return
    const parsed = parseAdapterInfo(t.source)
    form.setFieldsValue({
      type: 'TYPESCRIPT',
      isActive: true,
      source: t.source,
      name: parsed.name || t.name,
      description: parsed.description || t.description,
      code: t.code,
    })
    setSourceValue(t.source)
  }, [adapterTemplates, form])

  // 源码 → 表单：自动解析并填充
  const autoFillFromSource = useCallback((source: string) => {
    if (!editing && source) {
      const parsed = parseAdapterInfo(source)
      const currentName = form.getFieldValue('name') as string | undefined
      const currentDesc = form.getFieldValue('description') as string | undefined

      const updates: Record<string, string> = {}
      if (parsed.name && !currentName) {
        updates.name = parsed.name
      }
      if (parsed.description && !currentDesc) {
        updates.description = parsed.description
      }

      if (Object.keys(updates).length > 0) {
        form.setFieldsValue(updates)
      }
    }
  }, [editing, form])

  // 表单 → 源码：更新源码中的字段值
  const updateSourceField = useCallback((fieldName: 'name' | 'description', newValue: string) => {
    const currentSource = sourceValue
    const regex = new RegExp(`(${fieldName}\\s*:\\s*)['"]([^'"]*)['"](,?)`, 'i')

    if (regex.test(currentSource)) {
      // 字段存在，替换值
      const updatedSource = currentSource.replace(regex, `$1'${newValue.replace(/'/g, "\\'")}'$3`)
      setSourceValue(updatedSource)
      form.setFieldValue('source', updatedSource)
    } else {
      // 字段不存在，在 adapter 对象开头插入
      const adapterMatch = currentSource.match(/(const\s+adapter\s*=\s*\{)/)
      if (adapterMatch) {
        const insertPos = adapterMatch.index! + adapterMatch[0].length
        const insertion = `\n  ${fieldName}: '${newValue.replace(/'/g, "\\'")}',`
        const updatedSource = currentSource.slice(0, insertPos) + insertion + currentSource.slice(insertPos)
        setSourceValue(updatedSource)
        form.setFieldValue('source', updatedSource)
      }
    }
  }, [sourceValue, form])

  const fetchAdapters = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch<AdapterItem[]>('/api/admin/adapters')
      if (res.success && res.data) setAdapters(res.data)
    } catch { /* */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchAdapters(), 0)
    return () => window.clearTimeout(timer)
  }, [fetchAdapters])

  const openModal = (item?: AdapterItem) => {
    setEditing(item || null)
    form.resetFields()
    if (item) {
      form.setFieldsValue({
        name: item.name,
        code: item.code,
        description: item.description || '',
        type: item.type,
        source: item.source,
        isActive: item.isActive,
      })
      setSourceValue(item.source)
    } else {
      // 新建模式：预填模板，并自动解析 name 和 description
      const parsed = parseAdapterInfo(BUILTIN_SOURCE)
      form.setFieldsValue({
        type: 'TYPESCRIPT',
        isActive: true,
        source: BUILTIN_SOURCE,
        name: parsed.name || '',
        description: parsed.description || '',
      })
      setSourceValue(BUILTIN_SOURCE)
    }
    // 新建模式下拉取可用厂商模板
    if (!editing) loadTemplates()
    setModalOpen(true)
  }

  const save = async () => {
    const values = await form.validateFields()
    setSaving(true)
    try {
      const url = editing ? `/api/admin/adapters/${editing.id}` : '/api/admin/adapters'
      const method = editing ? 'PUT' : 'POST'
      const res = await apiFetch(url, {
        method,
        body: JSON.stringify(values),
      })
      if (res.success) {
        message.success(res.message)
        setModalOpen(false)
        fetchAdapters()
      } else { message.error(res.message) }
    } catch { message.error('操作失败') }
    finally { setSaving(false) }
  }

  const deleteAdapter = async (id: string) => {
    try {
      const res = await apiFetch(`/api/admin/adapters/${id}`, { method: 'DELETE' })
      if (res.success) { message.success('删除成功'); fetchAdapters() }
      else { message.error(res.message) }
    } catch { message.error('删除失败') }
  }

  const testAdapter = async (item: AdapterItem) => {
    setTesting(item.id)
    try {
      const res = await apiFetch<{ name: string; hasChat: boolean; hasImage: boolean }>('/api/admin/adapters/parse', {
        method: 'POST',
        body: JSON.stringify({ source: item.source, type: item.type }),
      })
      if (res.success && res.data) {
        message.success(`解析通过：${res.data.name}（对话 ${res.data.hasChat ? '√' : '×'} / 生图 ${res.data.hasImage ? '√' : '×'})`)
      } else {
        message.error(res.message)
      }
    } catch { message.error('测试失败') }
    finally { setTesting(null) }
  }

  const viewSource = (item: AdapterItem) => {
    setPreviewSource(item.source)
    setPreviewOpen(true)
  }

  const copySource = (source: string) => {
    navigator.clipboard.writeText(source).then(() => {
      message.success('源码已复制到剪贴板')
    }).catch(() => {
      message.error('复制失败')
    })
  }


  const columns: ColumnsType<AdapterItem> = [
    {
      title: '名称',
      dataIndex: 'name',
      width: 180,
      render: (name: string, r: AdapterItem) => {
        const parsed = parseAdapterInfo(r.source)
        return (
          <div>
            <div>{name}</div>
            {parsed.version && <Text type="secondary" className="text-xs">v{parsed.version}</Text>}
          </div>
        )
      }
    },
    {
      title: '代码',
      dataIndex: 'code',
      width: 140,
      render: (c: string) => <Text code>{c}</Text>
    },
    {
      title: '描述',
      dataIndex: 'description',
      width: 200,
      render: (desc: string | null, r: AdapterItem) => {
        const parsed = parseAdapterInfo(r.source)
        const displayDesc = desc || parsed.description
        return displayDesc ? (
          <Tooltip title={displayDesc}>
            <Text ellipsis className="text-xs text-text-secondary">{displayDesc}</Text>
          </Tooltip>
        ) : <Text type="secondary" className="text-xs">-</Text>
      }
    },
    {
      title: '类型', dataIndex: 'type', width: 110,
      render: (t: string) => <StatusTag tone={t === 'TYPESCRIPT' ? 'primary' : 'success'}>{t}</StatusTag>,
    },
    {
      title: '内置', dataIndex: 'isBuiltin', width: 80, align: 'center',
      render: (v: boolean) => v ? <StatusTag tone="primary">内置</StatusTag> : <Tag>自定义</Tag>,
    },
    {
      title: '启用', dataIndex: 'isActive', width: 80, align: 'center',
      render: (v: boolean) => v ? <CheckCircleOutlined className="text-success" /> : <CloseCircleOutlined className="text-text-disabled" />,
    },
    {
      title: '操作', width: 220,
      render: (_: unknown, r: AdapterItem) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => viewSource(r)}>查看</Button>
          {!r.isBuiltin && (
            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openModal(r)}>编辑</Button>
          )}
          <Button type="link" size="small" icon={testing === r.id ? <LoadingOutlined /> : <ApiOutlined />}
            onClick={() => testAdapter(r)} loading={testing === r.id}>
            测试
          </Button>
          {!r.isBuiltin && (
            <Popconfirm title="确定删除？" onConfirm={() => deleteAdapter(r.id)}>
              <Button type="link" size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <Card
        variant="outlined"
        title={<Space><ImportOutlined />Adapter 管理</Space>}
        extra={
          <Space>
            <Tooltip title="复制模板代码">
              <Button icon={<CopyOutlined />} onClick={() => copySource(BUILTIN_SOURCE)}>
                复制模板
              </Button>
            </Tooltip>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>新增 Adapter</Button>
          </Space>
        }
      >
        <Paragraph className="text-xs text-text-secondary mb-4">
          Adapter 是可执行的 TypeScript/JSON 代码块，用于描述如何与某个上游 Provider 通信。<br />
          <b>核心字段：</b>name（显示名称，如 &quot;OpenAI Compatible&quot;）、version（版本号）、description（描述）、code（代码标识，如 &quot;openai-compatible&quot;，在数据库字段设置）<br />
          <b>核心钩子：</b>buildChatRequest、parseChatStreamChunk、parseChatResponse、mapChatError（对话必需），buildImageRequest、parseImageResponse（生图可选）<br />
          内置 Adapter 不可编辑，自定义 Adapter 会立即生效。点击「复制模板」获取标准实现参考，粘贴后会自动填入显示名称和描述。
        </Paragraph>
        <Table dataSource={adapters} columns={columns} rowKey="id" loading={loading} size="middle" scroll={{ x: 1100 }} />
      </Card>

      <Modal
        title={editing ? '编辑 Adapter' : '新增 Adapter'}
        open={modalOpen} onCancel={() => setModalOpen(false)}
        onOk={save} confirmLoading={saving} width={720}
      >
        <Form form={form} layout="vertical" className="mt-4">
          {!editing && adapterTemplates.length > 0 && (
            <Form.Item label="从预设模板新建（选填）">
              <Select
                placeholder="选择厂商模板一键填充"
                loading={templatesLoading}
                allowClear
                onChange={(v) => v && applyTemplate(v)}
                options={adapterTemplates.map((t) => ({ value: t.code, label: `${t.name} — ${t.description}` }))}
              />
            </Form.Item>
          )}
          <Form.Item name="name" label="显示名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input
              placeholder="例如：OpenAI Compatible"
              onChange={(e) => {
                const newValue = e.target.value
                form.setFieldValue('name', newValue)
                setTimeout(() => updateSourceField('name', newValue), 300)
              }}
            />
          </Form.Item>
          <Form.Item name="code" label="代码标识" rules={[{ required: true, message: '请输入代码' }]}
            extra="唯一标识符，例如 openai-compatible、custom-provider。创建后不可修改">
            <Input placeholder="openai-compatible" disabled={!!editing} />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input
              placeholder="简短描述该 Adapter 支持的 Provider"
              onChange={(e) => {
                const newValue = e.target.value
                form.setFieldValue('description', newValue)
                setTimeout(() => updateSourceField('description', newValue), 300)
              }}
            />
          </Form.Item>
          <Form.Item name="type" label="类型" rules={[{ required: true }]}>
            <Select options={[
              { value: 'TYPESCRIPT', label: 'TypeScript / JavaScript' },
              { value: 'JSON', label: 'JSON（函数体字符串）' },
            ]} />
          </Form.Item>
          <Form.Item name="source" label="源码" rules={[{ required: true, message: '请输入源码' }]}
            extra={
              <div className="text-xs text-text-secondary mt-1 space-y-1">
                <div><b>必须返回名为 adapter 的对象</b>，包含以下字段和钩子：</div>
                <div><b className="text-primary">字段：</b></div>
                <div>• <code>name</code> (string, 必填) — Adapter 显示名称，如 &quot;OpenAI Compatible&quot;（将自动填入上方「显示名称」字段）</div>
                <div>• <code>version</code> (string, 可选) — 版本号，如 &quot;1.0.0&quot;</div>
                <div>• <code>description</code> (string, 可选) — 简短描述（将自动填入上方「描述」字段）</div>
                <div className="mt-2"><b className="text-primary">钩子函数：</b></div>
                <div>• <code>buildChatRequest(config, params)</code> — 返回 &#123;path, body&#125;</div>
                <div>• <code>parseChatStreamChunk(chunk)</code> — 返回 &#123;content?, reasoning?, finishReason?, usage?&#125; 或 null</div>
                <div>• <code>parseChatResponse(body)</code> — 返回 &#123;content, reasoning?, finishReason, usage?&#125;</div>
                <div>• <code>mapChatError(status, body)</code> — 返回错误消息字符串</div>
                <div>• <code>buildImageRequest(config, params)</code> (生图可选) — 返回 &#123;path, body&#125;</div>
                <div>• <code>parseImageResponse(body)</code> (生图可选) — 返回 &#123;imageUrl?, b64Json?&#125;</div>
                <div className="mt-2 text-text-secondary">
                  <b>注意：</b>上方「代码标识」字段用于数据库唯一标识，与源码中的 name 字段无关。代码标识示例：openai-compatible、custom-adapter 等。
                </div>
              </div>
            }
          >
            <Input.TextArea
              rows={18}
              className="font-mono text-sm"
              placeholder="const adapter = { name: '...', version: '...', ... }"
              value={sourceValue}
              onChange={(e) => {
                const newValue = e.target.value
                setSourceValue(newValue)
                form.setFieldValue('source', newValue)
                // 延迟解析以提升性能
                setTimeout(() => autoFillFromSource(newValue), 300)
              }}
            />
          </Form.Item>
          <Form.Item name="isActive" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="查看 Adapter 源码"
        open={previewOpen} onCancel={() => setPreviewOpen(false)}
        footer={
          <Space>
            <Button icon={<CopyOutlined />} onClick={() => copySource(previewSource)}>
              复制源码
            </Button>
            <Button onClick={() => setPreviewOpen(false)}>关闭</Button>
          </Space>
        }
        width={820}
      >
        <div className="space-y-3">
          <div className="bg-surface-hover rounded-lg p-3 text-xs text-text-muted">
            <div><b>核心钩子函数：</b></div>
            <ul className="ml-4 mt-1 space-y-0.5">
              <li><code>buildChatRequest(config, params)</code> — 构造对话请求的路径和 body</li>
              <li><code>parseChatStreamChunk(chunk)</code> — 解析流式响应的每个数据块</li>
              <li><code>parseChatResponse(body)</code> — 解析非流式响应 body</li>
              <li><code>mapChatError(status, body)</code> — 映射错误状态码为用户友好的消息</li>
              <li><code>buildImageRequest(config, params)</code> — 构造图像生成请求（可选）</li>
              <li><code>parseImageResponse(body)</code> — 解析图像生成响应（可选）</li>
            </ul>
          </div>
          <Input.TextArea rows={20} readOnly value={previewSource} className="font-mono text-sm" />
        </div>
      </Modal>
    </div>
  )
}
