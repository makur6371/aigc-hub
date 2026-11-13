'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Card,
  Table,
  Button,
  Form,
  Input,
  Select,
  Modal,
  Tag,
  Space,
  Popconfirm,
  Typography,
  App,
} from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ApartmentOutlined,
  LockOutlined,
  MinusCircleOutlined,
  SyncOutlined,
  CopyOutlined,
  SnippetsOutlined,
  RobotOutlined,
  StopOutlined,
  CheckOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { StatusTag } from '@/components/ui/StatusTag'
import { CodeTemplateBlock } from './CodeTemplateBlock'
import { apiFetch } from '@/lib/api-client'

const { Text, Paragraph } = Typography
const { TextArea } = Input

// 画布节点 codeSchema 模板（含元数据注释 + 端口注释 + 内置工具示例）
const NODE_CODE_TEMPLATE = `// 节点元数据（一键粘贴时自动解析）
// @type: custom-summarize
// @label: 文本摘要
// @category: llm  (可选值: llm | image | video | logic | data | io)
// @description: 调用 LLM 对长文本进行摘要提取

// 节点代码：定义一个 async function run(inputs)，返回对象供下游节点使用。
// inputs 的字段名 = 你在「输入端口」里配的 key；return 的字段名 = 「输出端口」里配的 key。
async function run(inputs) {
  // 输入端口注释格式：// @input: key (类型, required/optional) - 说明
  // 端口类型可选值: string | number | boolean | object | array | image | stream
  // @input: prompt (string, required) - 用户提示词
  // @input: systemPrompt (string, optional) - 系统提示词
  // @input: temperature (number, optional) - 温度参数

  const res = await callLLM({
    prompt: inputs.prompt,
    systemPrompt: inputs.systemPrompt,
    temperature: inputs.temperature ?? 0.7,
  })
  // res = { content: string, usage: { totalTokens: number }, reasoning?: string }

  // 输出端口注释格式：// @output: key (类型) - 说明
  // @output: text (string) - 生成文本
  // @output: tokens (number) - Token 消耗
  return { text: res.content, tokens: res.usage.totalTokens }
}`

const NODE_CODE_DESCRIPTION = `节点 codeSchema 是一段 async function run(inputs) 的 JS 代码，定义节点运行时行为。

**一键粘贴自动解析规则：**
• 元数据注释（自动填充节点标识/名称/分类/描述）：
  - @type: 节点标识（kebab-case，如 json-parser-enhanced）
  - @label: 显示名称
  - @category: 分类（llm/image/video/logic/data/io）
  - @description: 功能描述
• 输入端口注释（自动创建输入端口）：
  - @input: key (类型, required/optional) - 说明
  - 示例：// @input: prompt (string, required) - 用户提示词
• 输出端口注释（自动创建输出端口）：
  - @output: key (类型) - 说明
  - 示例：// @output: text (string) - 生成文本
• 兜底解析：若无注释，自动提取 inputs.xxx 和 return { xxx }

**可调用内置工具：**
• callLLM({ prompt, systemPrompt?, model?, temperature?, images? }) → { content, usage:{ totalTokens }, reasoning? }
• generateImage({ prompt, negativePrompt?, width?, height?, model? }) → { imageUrl }

**代码约束：**
• 禁用 fetch / require / process / import，仅可用 JSON/Math/Date/console
• 复制此模板给 AI 编写，或手动填写后粘贴到「一键粘贴」`

const PORT_TYPES = ['string', 'number', 'boolean', 'object', 'array', 'image', 'stream']
const NODE_CATEGORIES = [
  { value: 'llm', label: 'LLM 处理' },
  { value: 'image', label: '图像生成' },
  { value: 'video', label: '视频处理' },
  { value: 'logic', label: '逻辑控制' },
  { value: 'data', label: '数据转换' },
  { value: 'io', label: '输入输出' },
  { value: 'custom', label: '自定义节点' },
]

type NodeItem = {
  id: string
  nodeType: string
  label: string
  category: string
  description: string
  codeSchema: string
  inputs: Record<string, { type: string; label: string; required?: boolean; defaultValue?: unknown }>
  outputs: Record<string, { type: string; label: string }>
  isOfficial: boolean
  isBuiltin: boolean
  isDisabled?: boolean
  createdAt: string | null
}

type ModelOption = { id: string; name: string; type: string }

const categoryLabels: Record<string, string> = {
  llm: 'LLM 处理',
  image: '图像生成',
  video: '视频处理',
  logic: '逻辑控制',
  data: '数据转换',
  io: '输入输出',
  custom: '自定义节点',
}

export function AgentsNodesPanel() {
  const { message } = App.useApp()
  const [nodes, setNodes] = useState<NodeItem[]>([])
  const [models, setModels] = useState<ModelOption[]>([])
  const [loadingNodes, setLoadingNodes] = useState(false)
  const [nodeModalOpen, setNodeModalOpen] = useState(false)
  const [editingNode, setEditingNode] = useState<NodeItem | null>(null)
  const [nodeForm] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const [quickCreateModalOpen, setQuickCreateModalOpen] = useState(false)
  const [aiGenerateModalOpen, setAiGenerateModalOpen] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiGenerating, setAiGenerating] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [pasteModalOpen, setPasteModalOpen] = useState(false)
  const [pasteCode, setPasteCode] = useState('')

  const fetchNodes = useCallback(async () => {
    setLoadingNodes(true)
    try {
      const res = await apiFetch<NodeItem[]>('/api/admin/canvas-nodes')
      if (res.success && res.data) setNodes(res.data)
    } catch { /* */ }
    finally { setLoadingNodes(false) }
  }, [])

  const fetchModels = useCallback(async () => {
    try {
      const res = await apiFetch<{ id: string; name: string; type: string }[]>('/api/admin/models')
      if (res.success && res.data) setModels(res.data.map((m) => ({ id: m.id, name: m.name, type: m.type })))
    } catch { /* */ }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => { void fetchNodes(); void fetchModels() }, 0)
    return () => window.clearTimeout(timer)
  }, [fetchNodes, fetchModels])

  // ---- Canvas Node CRUD ----
  const openNodeModal = (n?: NodeItem) => {
    if (n?.isBuiltin) return
    setEditingNode(n || null)
    nodeForm.resetFields()
    if (n) {
      // 端口 Record 转为数组回填 Form.List
      const inputsArr = Object.entries(n.inputs || {}).map(([key, p]) => ({ key, label: p.label, type: p.type, required: !!p.required, defaultValue: p.defaultValue }))
      const outputsArr = Object.entries(n.outputs || {}).map(([key, p]) => ({ key, label: p.label, type: p.type }))
      nodeForm.setFieldsValue({
        nodeType: n.nodeType, label: n.label, category: n.category || 'custom',
        description: n.description || '', codeSchema: n.codeSchema, isOfficial: n.isOfficial,
        inputs: inputsArr, outputs: outputsArr,
      })
    } else {
      nodeForm.setFieldsValue({ isOfficial: true, category: 'custom', inputs: [], outputs: [] })
    }
    setNodeModalOpen(true)
  }

  const saveNode = async () => {
    const values = await nodeForm.validateFields()
    setSaving(true)
    try {
      // Form.List 数组转 Record<string, NodePort>
      const toRecord = (arr: { key: string; label: string; type: string; required?: boolean; defaultValue?: unknown }[] | undefined) => {
        const rec: Record<string, { type: string; label: string; required?: boolean; defaultValue?: unknown }> = {}
        ;(arr || []).forEach((p) => {
          if (!p.key) return
          const port: { type: string; label: string; required?: boolean; defaultValue?: unknown } = { type: p.type, label: p.label }
          if (p.required) port.required = true
          if (p.defaultValue !== undefined && p.defaultValue !== '') port.defaultValue = p.defaultValue
          rec[p.key] = port
        })
        return rec
      }
      const body = {
        ...values,
        inputs: toRecord(values.inputs),
        outputs: toRecord(values.outputs),
      }
      const url = editingNode ? `/api/admin/canvas-nodes/${editingNode.id}` : '/api/admin/canvas-nodes'
      const method = editingNode ? 'PUT' : 'POST'

      const res = await apiFetch(url, { method, body: JSON.stringify(body) })
      if (res.success) {
        message.success(res.message)
        setNodeModalOpen(false)
        fetchNodes()
      } else { message.error(res.message) }
    } catch { message.error('操作失败') }
    finally { setSaving(false) }
  }

  const deleteNode = async (id: string) => {
    try {
      const res = await apiFetch(`/api/admin/canvas-nodes/${id}`, { method: 'DELETE' })
      if (res.success) { message.success('删除成功'); fetchNodes() }
      else { message.error(res.message) }
    } catch { message.error('删除失败') }
  }

  // 切换节点禁用/启用（内置节点与自定义节点通用）
  const toggleDisabled = async (r: NodeItem) => {
    const next = !r.isDisabled
    try {
      const res = await apiFetch(`/api/admin/canvas-nodes/${r.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isDisabled: next }),
      })
      if (res.success) { message.success(res.message); fetchNodes() }
      else { message.error(res.message) }
    } catch { message.error('操作失败') }
  }

  // AI 生成节点定义
  const generateNodeWithAI = async () => {
    if (!aiPrompt.trim()) {
      message.warning('请输入节点需求描述')
      return
    }
    setAiGenerating(true)
    try {
      const res = await fetch('/api/canvas/copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            {
              role: 'system',
              content: `你是画布节点代码生成器。用户描述节点需求，你返回完整的节点定义 JSON。
要求：
1. 返回纯 JSON，无其他文字
2. 格式：{ "type": "节点标识", "label": "显示名称", "category": "分类", "description": "描述", "inputs": { "key": { "type": "类型", "required": true/false, "label": "标签", "description": "说明" } }, "outputs": { "key": { "type": "类型", "label": "标签" } }, "codeSchema": "async function run(inputs) { ... }" }
3. type 用 kebab-case（如 video-generate）
4. category 只能是：llm, image, video, logic, data, io 之一
5. port type 只能是：string, number, boolean, object, array, image, stream
6. codeSchema 必须是完整可执行的 JS 代码，可调用 callLLM/generateImage 内置工具
7. 代码中不要用 fetch/require，仅用 JSON/Math/Date/console`,
            },
            { role: 'user', content: aiPrompt },
          ],
        }),
      })
      const data = await res.json()
      if (data.success && data.data.content) {
        try {
          const nodeDef = JSON.parse(data.data.content)
          // 验证必需字段
          if (!nodeDef.type || !nodeDef.label || !nodeDef.category || !nodeDef.inputs || !nodeDef.outputs || !nodeDef.codeSchema) {
            throw new Error('节点定义缺少必需字段')
          }
          // 填充到新增表单
          type PortDef = { label?: string; type?: string; required?: boolean; description?: string; defaultValue?: unknown }
          const inputsArr = Object.entries(nodeDef.inputs as Record<string, PortDef>).map(([key, p]) => ({
            key,
            label: p.label,
            type: p.type,
            required: !!p.required,
            defaultValue: p.defaultValue,
          }))
          const outputsArr = Object.entries(nodeDef.outputs as Record<string, PortDef>).map(([key, p]) => ({
            key,
            label: p.label,
            type: p.type,
          }))
          nodeForm.setFieldsValue({
            nodeType: nodeDef.type,
            label: nodeDef.label,
            category: nodeDef.category,
            description: nodeDef.description || '',
            codeSchema: nodeDef.codeSchema,
            isOfficial: true,
            inputs: inputsArr,
            outputs: outputsArr,
          })
          setAiGenerateModalOpen(false)
          setNodeModalOpen(true)
          setEditingNode(null)
          message.success('AI 已生成节点定义，请检查后保存')
        } catch (e) {
          message.error('AI 返回的 JSON 格式有误：' + (e as Error).message)
        }
      } else {
        message.error(data.message || 'AI 生成失败')
      }
    } catch {
      message.error('网络错误')
    } finally {
      setAiGenerating(false)
    }
  }

  // 快速创建预置模板
  const quickCreateTemplates = [
    {
      key: 'video-generate',
      label: '视频生成节点',
      nodeType: 'video-generate',
      nodeName: '视频生成',
      category: 'video' as const,
      description: '调用视频生成模型生成视频',
      inputs: [
        { key: 'prompt', label: '视频描述', type: 'string', required: true },
        { key: 'duration', label: '时长(秒)', type: 'number', required: false },
        { key: 'model', label: '模型选择', type: 'string', required: false },
      ],
      outputs: [
        { key: 'videoUrl', label: '视频地址', type: 'string' },
      ],
      codeSchema: `async function run(inputs) {
  const result = await generateVideo({
    prompt: inputs.prompt,
    duration: inputs.duration ?? 5,
    model: inputs.model,
  })
  return { videoUrl: result.videoUrl }
}`,
    },
    {
      key: 'image-to-text',
      label: '图片分析节点',
      nodeType: 'image-to-text',
      nodeName: '图片分析',
      category: 'llm' as const,
      description: '用 LLM 分析图片内容',
      inputs: [
        { key: 'imageUrl', label: '图片地址', type: 'image', required: true },
        { key: 'prompt', label: '分析指令', type: 'string', required: true },
        { key: 'model', label: '模型选择', type: 'string', required: false },
      ],
      outputs: [
        { key: 'text', label: '分析结果', type: 'string' },
      ],
      codeSchema: `async function run(inputs) {
  const res = await callLLM({
    prompt: inputs.prompt,
    images: [inputs.imageUrl],
    model: inputs.model,
  })
  return { text: res.content }
}`,
    },
    {
      key: 'array-expand',
      label: '数组展开节点',
      nodeType: 'array-expand',
      nodeName: '数组展开',
      category: 'data' as const,
      description: '将数组透传，供下游连接按索引取单个元素',
      inputs: [
        { key: 'items', label: '数组', type: 'array', required: true },
      ],
      outputs: [
        { key: 'items', label: '数组', type: 'array' },
      ],
      codeSchema: `async function run(inputs) {
  return { items: inputs.items }
}`,
    },
  ]

  const applyQuickTemplate = (template: typeof quickCreateTemplates[0]) => {
    nodeForm.setFieldsValue({
      nodeType: template.nodeType,
      label: template.nodeName,
      category: template.category,
      description: template.description,
      codeSchema: template.codeSchema,
      isOfficial: true,
      inputs: template.inputs,
      outputs: template.outputs,
    })
    setQuickCreateModalOpen(false)
    setNodeModalOpen(true)
    setEditingNode(null)
  }

  // 同步内置节点到数据库
  const syncBuiltinNodes = async () => {
    setSyncing(true)
    try {
      const res = await apiFetch('/api/admin/canvas-nodes/sync-builtin', { method: 'POST' })
      if (res.success) {
        message.success(res.message || '内置节点已同步')
        fetchNodes()
      } else {
        message.error(res.message)
      }
    } catch {
      message.error('同步失败')
    } finally {
      setSyncing(false)
    }
  }

  // 一键粘贴代码，自动解析并填充表单
  const parseAndFillFromCode = () => {
    if (!pasteCode.trim()) {
      message.warning('请粘贴节点代码')
      return
    }

    try {
      // 1. 解析元数据注释
      const typeMatch = pasteCode.match(/\/\/\s*@type:\s*(.+)/i)
      const labelMatch = pasteCode.match(/\/\/\s*@label:\s*(.+)/i)
      const categoryMatch = pasteCode.match(/\/\/\s*@category:\s*(.+)/i)
      const descriptionMatch = pasteCode.match(/\/\/\s*@description:\s*(.+)/i)

      const nodeType = typeMatch?.[1]?.trim() || ''
      const label = labelMatch?.[1]?.trim() || ''
      const category = categoryMatch?.[1]?.trim() || 'custom'
      const description = descriptionMatch?.[1]?.trim() || ''

      // 2. 解析输入端口注释：// @input: key (类型, required/optional) - 说明
      const inputCommentMatches = pasteCode.matchAll(/\/\/\s*@input:\s*(\w+)\s*\(([^,\)]+)(?:,\s*(required|optional))?\)\s*(?:-\s*(.+))?/gi)
      const inputsFromComments: Array<{ key: string; label: string; type: string; required: boolean; description?: string }> = []
      for (const match of inputCommentMatches) {
        inputsFromComments.push({
          key: match[1].trim(),
          label: match[4]?.trim() || match[1].trim(),
          type: match[2].trim().toLowerCase(),
          required: match[3]?.toLowerCase() === 'required',
          description: match[4]?.trim(),
        })
      }

      // 3. 解析输出端口注释：// @output: key (类型) - 说明
      const outputCommentMatches = pasteCode.matchAll(/\/\/\s*@output:\s*(\w+)\s*\(([^\)]+)\)\s*(?:-\s*(.+))?/gi)
      const outputsFromComments: Array<{ key: string; label: string; type: string; description?: string }> = []
      for (const match of outputCommentMatches) {
        outputsFromComments.push({
          key: match[1].trim(),
          label: match[3]?.trim() || match[1].trim(),
          type: match[2].trim().toLowerCase(),
          description: match[3]?.trim(),
        })
      }

      // 4. 兜底：若无注释，自动提取 inputs.xxx 和 return { xxx }
      let inputsArr = inputsFromComments
      let outputsArr = outputsFromComments

      if (inputsArr.length === 0) {
        const inputMatches = pasteCode.matchAll(/inputs\.(\w+)/g)
        const inputKeys = new Set<string>()
        for (const match of inputMatches) {
          inputKeys.add(match[1])
        }
        inputsArr = Array.from(inputKeys).map((key) => ({
          key,
          label: key,
          type: 'string',
          required: false,
        }))
      }

      if (outputsArr.length === 0) {
        const returnMatch = pasteCode.match(/return\s*\{([^}]+)\}/)
        const outputKeys = new Set<string>()
        if (returnMatch) {
          const returnBody = returnMatch[1]
          const fieldMatches = returnBody.matchAll(/(\w+)\s*:/g)
          for (const match of fieldMatches) {
            outputKeys.add(match[1])
          }
        }
        outputsArr = Array.from(outputKeys).map((key) => ({
          key,
          label: key,
          type: key.includes('Count') || key.includes('count') ? 'number' : key.includes('items') || key.includes('Items') ? 'array' : 'string',
        }))
      }

      // 5. 填充表单
      nodeForm.setFieldsValue({
        nodeType: nodeType || undefined,
        label: label || undefined,
        category: category || 'custom',
        description: description || undefined,
        codeSchema: pasteCode,
        inputs: inputsArr,
        outputs: outputsArr,
        isOfficial: true,
      })

      setPasteModalOpen(false)
      setNodeModalOpen(true)
      setEditingNode(null)

      const metaInfo = nodeType ? `节点标识: ${nodeType}, 名称: ${label}` : '未找到元数据注释'
      message.success(`已解析：${metaInfo}，${inputsArr.length} 个输入，${outputsArr.length} 个输出`)
    } catch (error) {
      message.error('代码解析失败：' + (error as Error).message)
    }
  }

  const nodeColumns: ColumnsType<NodeItem> = [
    {
      title: '节点标识', dataIndex: 'nodeType', width: 140,
      render: (t: string) => <Text code className="text-xs">{t}</Text>,
    },
    { title: '名称', dataIndex: 'label', width: 120 },
    {
      title: '分类', dataIndex: 'category', width: 110,
      render: (c: string) => <StatusTag tone="primary">{categoryLabels[c] || c}</StatusTag>,
    },
    {
      title: '来源', dataIndex: 'isBuiltin', width: 90,
      render: (v: boolean) => v ? <Tag icon={<LockOutlined />}>内置</Tag> : <StatusTag tone="success">自定义</StatusTag>,
    },
    {
      title: '操作', width: 220,
      render: (_: unknown, r: NodeItem) => (
        <Space size="small">
          {r.isBuiltin ? (
            <Button
              type="link"
              size="small"
              danger={r.isDisabled}
              icon={r.isDisabled ? <CheckOutlined /> : <StopOutlined />}
              onClick={() => toggleDisabled(r)}
            >
              {r.isDisabled ? '启用' : '禁用'}
            </Button>
          ) : (
            <>
              <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openNodeModal(r)}>编辑</Button>
              <Button
                type="link"
                size="small"
                danger={r.isDisabled}
                icon={r.isDisabled ? <CheckOutlined /> : <StopOutlined />}
                onClick={() => toggleDisabled(r)}
              >
                {r.isDisabled ? '启用' : '禁用'}
              </Button>
              <Popconfirm title="确定删除？" onConfirm={() => deleteNode(r.id)}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <Card
        variant="outlined"
        title={<Space><ApartmentOutlined />画布节点</Space>}
        extra={
          <Space>
            <Button icon={<SyncOutlined />} onClick={syncBuiltinNodes} loading={syncing}>
              同步内置节点
            </Button>
            <Button icon={<CopyOutlined />} onClick={() => {
              navigator.clipboard.writeText(NODE_CODE_TEMPLATE).then(() => {
                message.success('模板已复制到剪贴板，可直接粘贴到「一键粘贴」')
              }).catch(() => {
                message.error('复制失败')
              })
            }}>
              复制模板
            </Button>
            <Button icon={<SnippetsOutlined />} onClick={() => setPasteModalOpen(true)}>
              一键粘贴
            </Button>
            <Button icon={<PlusOutlined />} onClick={() => setQuickCreateModalOpen(true)}>
              快速创建
            </Button>
            <Button icon={<RobotOutlined />} onClick={() => setAiGenerateModalOpen(true)}>
              AI 生成
            </Button>
          </Space>
        }
      >
        <Paragraph className="text-xs text-text-secondary mb-4">
          禁用的节点将从用户节点库隐藏（旧画布仍照常渲染执行）；内置节点代码不可改，但可启用/禁用；自定义节点可编辑、禁用、删除。
        </Paragraph>
        <Table dataSource={nodes} columns={nodeColumns} rowKey="id" loading={loadingNodes} size="middle" scroll={{ x: 700 }} />
      </Card>

      {/* Canvas Node Modal */}
      <Modal
        title={editingNode ? '编辑自定义节点' : '新增自定义节点'}
        open={nodeModalOpen} onCancel={() => setNodeModalOpen(false)}
        onOk={saveNode} confirmLoading={saving} width={760}
      >
        <Form form={nodeForm} layout="vertical" className="mt-4">
          <div className="grid grid-cols-2 gap-4">
            <Form.Item name="nodeType" label="节点标识" rules={[{ required: true, message: '请输入节点标识' }]}
              extra="唯一标识符，例如 custom-summarize。创建后不可修改">
              <Input placeholder="custom-summarize" disabled={!!editingNode} />
            </Form.Item>
            <Form.Item name="label" label="显示名称" rules={[{ required: true, message: '请输入显示名称' }]}>
              <Input placeholder="文本摘要" />
            </Form.Item>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Form.Item name="category" label="分类" rules={[{ required: true }]}>
              <Select options={NODE_CATEGORIES} />
            </Form.Item>
            <Form.Item name="description" label="描述">
              <Input placeholder="一句话说明节点用途" />
            </Form.Item>
          </div>

          <PortEditor name="inputs" label="输入端口" showRequired />
          <PortEditor name="outputs" label="输出端口" />

          <CodeTemplateBlock
            title="节点代码模板"
            description={NODE_CODE_DESCRIPTION}
            code={NODE_CODE_TEMPLATE}
            maxHeight={220}
          />
          <Form.Item name="codeSchema" label="代码 Schema" rules={[{ required: true, message: '请输入代码 Schema' }]}
            extra="节点运行时行为的 JS 代码（async function run）">
            <TextArea rows={10} placeholder={'async function run(inputs) {\n  // ...\n}'} className="font-mono" />
          </Form.Item>
          <Form.Item name="isOfficial" label="标记为官方节点">
            <Select
              options={[
                { value: true, label: '是（所有用户可见）' },
                { value: false, label: '否（仅创建者可见）' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 快速创建模板选择 */}
      <Modal
        title="快速创建节点"
        open={quickCreateModalOpen}
        onCancel={() => setQuickCreateModalOpen(false)}
        footer={null}
        width={600}
      >
        <div className="space-y-3 mt-4">
          <Text className="text-xs text-text-secondary block mb-3">
            选择预置模板，自动填充节点定义，一键创建常用节点：
          </Text>
          {quickCreateTemplates.map((tpl) => (
            <Card
              key={tpl.key}
              size="small"
              hoverable
              onClick={() => applyQuickTemplate(tpl)}
              className="cursor-pointer"
            >
              <div className="flex items-start justify-between">
                <div>
                  <Text strong className="text-sm">{tpl.label}</Text>
                  <div className="text-xs text-text-secondary mt-1">{tpl.description}</div>
                  <div className="flex gap-2 mt-2">
                    <StatusTag tone="primary">{categoryLabels[tpl.category]}</StatusTag>
                    <Tag>{tpl.inputs.length} 输入</Tag>
                    <Tag>{tpl.outputs.length} 输出</Tag>
                  </div>
                </div>
                <Button type="primary" size="small">使用</Button>
              </div>
            </Card>
          ))}
        </div>
      </Modal>

      {/* AI 生成节点 */}
      <Modal
        title="AI 生成节点定义"
        open={aiGenerateModalOpen}
        onCancel={() => setAiGenerateModalOpen(false)}
        onOk={generateNodeWithAI}
        confirmLoading={aiGenerating}
        okText="生成"
        width={560}
      >
        <div className="mt-4 space-y-3">
          <Text className="text-xs text-text-secondary block">
            描述你需要的节点功能，AI 会自动生成完整的节点定义（type、label、inputs、outputs、codeSchema）。
          </Text>
          <Text className="text-xs text-text-muted block font-medium">
            示例：<br />
            • 「视频生成节点，输入 prompt 和 duration，输出 videoUrl」<br />
            • 「图片分析节点，输入图片地址和分析指令，调用 LLM 返回分析结果」<br />
            • 「文本翻译节点，输入原文和目标语言，输出译文」
          </Text>
          <TextArea
            rows={4}
            placeholder="描述节点需求..."
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
          />
        </div>
      </Modal>

      {/* 一键粘贴代码 */}
      <Modal
        title="一键粘贴节点代码"
        open={pasteModalOpen}
        onCancel={() => setPasteModalOpen(false)}
        onOk={parseAndFillFromCode}
        okText="解析并填充"
        width={720}
      >
        <div className="mt-4 space-y-3">
          <Text className="text-xs text-text-secondary block">
            粘贴完整的节点代码（含元数据注释），系统会自动解析并填充表单。
          </Text>
          <div className="bg-surface-hover rounded-lg p-3 text-xs space-y-2">
            <Text strong className="block text-foreground">标准注释格式：</Text>
            <div className="font-mono text-text-muted space-y-1">
              <div>{'// @type: 节点标识（kebab-case）'}</div>
              <div>{'// @label: 显示名称'}</div>
              <div>{'// @category: 分类（llm/image/video/logic/data/io）'}</div>
              <div>{'// @description: 功能描述'}</div>
              <div className="mt-2">{'// @input: key (类型, required/optional) - 说明'}</div>
              <div>{'// @output: key (类型) - 说明'}</div>
            </div>
          </div>
          <Text className="text-xs text-text-secondary block">
            兜底：若无注释，自动提取 <code>inputs.xxx</code> 和 <code>return &#123; xxx &#125;</code>（但节点标识/名称需手动填写）
          </Text>
          <TextArea
            rows={16}
            placeholder={`// @type: json-parser-enhanced\n// @label: JSON 解析增强\n// @category: data\n// @description: 解析 LLM 返回的 JSON\n\nasync function run(inputs) {\n  // @input: rawText (string, required) - 原始文本\n  const rawText = inputs.rawText ?? '';\n  // ...\n  // @output: items (array) - 数组\n  // @output: itemCount (number) - 数量\n  return { items, itemCount };\n}`}
            value={pasteCode}
            onChange={(e) => setPasteCode(e.target.value)}
            className="font-mono text-xs"
          />
        </div>
      </Modal>
    </div>
  )
}

// 端口编辑器：用 Form.List 配置输入/输出端口（key/label/type/required/defaultValue）
function PortEditor({ name, label, showRequired = false }: { name: 'inputs' | 'outputs'; label: string; showRequired?: boolean }) {
  return (
    <div className="mb-4">
      <Text strong className="text-sm block mb-2">{label}</Text>
      <Form.List name={name}>
        {(fields, { add, remove }) => (
          <>
            {fields.map(({ key, name: fieldName }) => (
              <div key={key} className="flex items-start gap-2 mb-2">
                <Form.Item
                  name={[fieldName, 'key']}
                  rules={[
                    { required: true, message: 'key' },
                    { pattern: /^[a-zA-Z][a-zA-Z0-9_]*$/, message: '英文标识' },
                  ]}
                  className="flex-1 !mb-0"
                >
                  <Input placeholder="key" className="text-xs" />
                </Form.Item>
                <Form.Item name={[fieldName, 'label']} rules={[{ required: true, message: '名称' }]} className="flex-1 !mb-0">
                  <Input placeholder="显示名称" className="text-xs" />
                </Form.Item>
                <Form.Item name={[fieldName, 'type']} rules={[{ required: true }]} className="w-28 !mb-0">
                  <Select size="small" options={PORT_TYPES.map((t) => ({ value: t, label: t }))} placeholder="类型" />
                </Form.Item>
                {showRequired && (
                  <Form.Item name={[fieldName, 'required']} valuePropName="checked" className="w-16 !mb-0 flex items-center">
                    <Select size="small" options={[{ value: false, label: '可选' }, { value: true, label: '必填' }]} />
                  </Form.Item>
                )}
                <MinusCircleOutlined className="text-text-disabled hover:text-danger mt-2 cursor-pointer" onClick={() => remove(fieldName)} />
              </div>
            ))}
            <Button type="dashed" block size="small" icon={<PlusOutlined />} onClick={() => add({ type: 'string', required: false })}>
              添加{label}
            </Button>
          </>
        )}
      </Form.List>
    </div>
  )
}
