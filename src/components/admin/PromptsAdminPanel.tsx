'use client'

import { useState, useEffect, useCallback } from 'react'
import { Table, Button, Modal, Form, Input, Select, Switch, App, Space, Tag, Popconfirm, Segmented, Typography } from 'antd'
import { EditOutlined, DeleteOutlined, CrownOutlined, SearchOutlined } from '@ant-design/icons'
import { apiFetch } from '@/lib/api-client'
import { PROMPT_CATEGORIES } from '@/lib/constants/categories'
import { StatusTag, type StatusTone } from '@/components/ui/StatusTag'
import type { ColumnsType } from 'antd/es/table'

const { TextArea } = Input
const { Text } = Typography

const statusMeta: Record<string, { text: string; tone: StatusTone }> = {
  PENDING: { text: '待审核', tone: 'warning' },
  APPROVED: { text: '已上架', tone: 'success' },
  REJECTED: { text: '已下架', tone: 'danger' },
}

type PromptRecord = {
  id: string
  title: string
  content: string
  category: string
  kind: string
  coverUrl: string | null
  isPublic: boolean
  status: string
  isOfficial: boolean
  useCount: number
  creatorId: string
  creatorName: string
  createdAt: string
}

export function PromptsAdminPanel() {
  const { message } = App.useApp()
  const [items, setItems] = useState<PromptRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState<'all' | 'creative' | 'functional'>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  // 分页状态：筛选与页码都交服务端（数据量已近千条，不能全量拉回本地过滤）
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const PAGE_SIZE = 20
  const [previewing, setPreviewing] = useState<PromptRecord | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<PromptRecord | null>(null)
  const [form] = Form.useForm()

  // 加载：筛选 + 页码一并交服务端（keyword 参数名与后端约定一致）
  const load = useCallback(async (opts?: { page?: number }) => {
    const targetPage = opts?.page ?? page
    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: String(targetPage),
        pageSize: String(PAGE_SIZE),
      })
      if (kindFilter !== 'all') params.set('kind', kindFilter)
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (search.trim()) params.set('keyword', search.trim())
      const res = await apiFetch<{ items: PromptRecord[]; total: number }>(`/api/admin/prompts?${params.toString()}`)
      if (res.success && res.data) {
        setItems(Array.isArray(res.data.items) ? res.data.items : [])
        setTotal(Number(res.data.total) || 0)
      } else {
        message.error(res.message || '加载失败')
      }
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }, [message, page, kindFilter, statusFilter, search])

  // 加载：延后一帧，避免在 effect 同步体内 setState 触发级联渲染（项目统一写法）
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  // 筛选已在服务端完成（分页后本地过滤只能过滤当前页，会漏掉其它页的命中项）
  const filteredItems = items

  const handleEdit = (record: PromptRecord) => {
    setEditing(record)
    form.setFieldsValue({
      title: record.title,
      content: record.content,
      category: record.category,
      kind: record.kind,
      isPublic: record.isPublic,
    })
    setModalOpen(true)
  }

  const handleDelete = async (id: string) => {
    try {
      const res = await apiFetch(`/api/admin/prompts/${id}`, { method: 'DELETE' })
      if (res.success) {
        message.success('删除成功')
        load()
      } else {
        message.error(res.message || '删除失败')
      }
    } catch {
      message.error('删除失败')
    }
  }

  const handleToggleOfficial = async (record: PromptRecord) => {
    try {
      const res = await apiFetch(`/api/admin/prompts/${record.id}/official`, {
        method: 'POST',
        body: JSON.stringify({ isOfficial: !record.isOfficial }),
      })
      if (res.success) {
        message.success(res.message)
        load()
      } else {
        message.error(res.message || '操作失败')
      }
    } catch {
      message.error('操作失败')
    }
  }

  const handleStatus = async (record: PromptRecord, nextStatus: 'APPROVED' | 'REJECTED') => {
    try {
      const res = await apiFetch(`/api/admin/prompts/${record.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      })
      if (res.success) {
        message.success(nextStatus === 'APPROVED' ? '已上架' : '已下架')
        load()
      } else {
        message.error(res.message || '操作失败')
      }
    } catch {
      message.error('网络错误')
    }
  }

  const handleSubmit = async () => {
    if (!editing) return
    try {
      const values = await form.validateFields()
      const res = await apiFetch(`/api/admin/prompts/${editing.id}`, {
        method: 'PATCH',
        body: JSON.stringify(values),
      })
      if (res.success) {
        message.success('保存成功')
        setModalOpen(false)
        setEditing(null)
        form.resetFields()
        load()
      } else {
        message.error(res.message || '保存失败')
      }
    } catch {
      message.error('保存失败')
    }
  }

  const columns: ColumnsType<PromptRecord> = [
    {
      title: '标题',
      dataIndex: 'title',
      key: 'title',
      width: 200,
      render: (title: string, record: PromptRecord) => (
        <button type="button" className="cursor-pointer text-left text-sm font-medium text-accent hover:underline" onClick={() => setPreviewing(record)}>
          {title}
        </button>
      ),
    },
    {
      title: '内容',
      dataIndex: 'content',
          width: 330,
      render: (content: string) => <Text className="line-clamp-2 text-xs text-text-muted">{content}</Text>,
    },
    {
      title: '分类',
      dataIndex: 'category',
      key: 'category',
      width: 120,
    },
    {
      title: '类型',
      dataIndex: 'kind',
      key: 'kind',
      width: 100,
      render: (kind: string) => kind === 'creative' ? <Tag color="blue">创作成品</Tag> : <Tag>功能模板</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 150,
      render: (status: string, record: PromptRecord) => {
        const meta = statusMeta[status] || { text: status, tone: 'primary' as StatusTone }
        return (
        <Space size={4}>
          <StatusTag tone={meta.tone}>{meta.text}</StatusTag>
          {record.isOfficial && <Tag color="gold" icon={<CrownOutlined />}>官方</Tag>}
          {record.isPublic && status === 'APPROVED' && <Tag color="green">公开</Tag>}
        </Space>
        )
      },
    },
    {
      title: '使用次数',
      dataIndex: 'useCount',
      key: 'useCount',
      width: 100,
      sorter: (a, b) => a.useCount - b.useCount,
    },
    {
      title: '创建者',
      dataIndex: 'creatorName',
      key: 'creatorName',
      width: 120,
    },
    {
      title: '操作',
      key: 'actions',
      width: 260,
      fixed: 'right' as const,
      render: (_: unknown, record: PromptRecord) => (
        <Space size="small">
          <Button
            type="link"
            size="small"
            icon={<CrownOutlined />}
            onClick={() => handleToggleOfficial(record)}
          >
            {record.isOfficial ? '取消官方' : '设为官方'}
          </Button>
          {record.status === 'PENDING' ? (
            <>
              <Button type="link" size="small" onClick={() => handleStatus(record, 'APPROVED')}>通过</Button>
              <Button type="link" size="small" danger onClick={() => handleStatus(record, 'REJECTED')}>驳回</Button>
            </>
          ) : (
            <Button type="link" size="small" onClick={() => handleStatus(record, record.status === 'APPROVED' ? 'REJECTED' : 'APPROVED')}>
              {record.status === 'APPROVED' ? '下架' : '上架'}
            </Button>
          )}
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
          >
            编辑
          </Button>
          <Popconfirm
            title="确认删除该提示词？"
            description="删除后不可恢复。"
            okButtonProps={{ danger: true }}
            onConfirm={() => handleDelete(record.id)}
            okText="删除"
            cancelText="取消"
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Text strong>提示词管理</Text>
        <Space wrap>
          <Input
            allowClear
            className="!w-56"
            prefix={<SearchOutlined className="opacity-45" />}
            placeholder="搜索标题 / 内容 / 作者"
            value={search}
            onChange={(event) => { setSearch(event.target.value); setPage(1) }}
          />
          <Segmented
            value={kindFilter}
            onChange={(value) => { setKindFilter(value as typeof kindFilter); setPage(1) }}
            options={[
              { label: '全部', value: 'all' },
              { label: '创作成品', value: 'creative' },
              { label: '功能模板', value: 'functional' },
            ]}
          />
          <Segmented
            value={statusFilter}
            onChange={(value) => { setStatusFilter(String(value)); setPage(1) }}
            options={[
              { label: '全部', value: 'all' },
              { label: '待审核', value: 'PENDING' },
              { label: '已上架', value: 'APPROVED' },
              { label: '已下架', value: 'REJECTED' },
            ]}
          />
        </Space>
      </div>

      <Table
        dataSource={filteredItems}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total,
          showSizeChanger: false,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p) => setPage(p),
        }}
        scroll={{ x: 1200 }}
      />

      <Modal
        title="编辑提示词"
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => {
          setModalOpen(false)
          setEditing(null)
          form.resetFields()
        }}
        width={700}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="content" label="内容" rules={[{ required: true, message: '请输入内容' }]}>
            <TextArea rows={6} />
          </Form.Item>
          <Form.Item name="category" label="分类" rules={[{ required: true }]}>
            <Select>
              {PROMPT_CATEGORIES.map((c) => (
                <Select.Option key={c} value={c}>{c}</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="kind" label="类型" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="creative">创作成品（关联作品）</Select.Option>
              <Select.Option value="functional">功能模板（可套用）</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="isPublic" label="公开" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={previewing?.title}
        open={!!previewing}
        onCancel={() => setPreviewing(null)}
        footer={null}
        width={760}
        centered
        destroyOnHidden
      >
        {previewing && (
          <div className="space-y-4 pt-1">
            {previewing.coverUrl && (
              <div className="aspect-[16/9] overflow-hidden rounded-xl bg-surface">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={previewing.coverUrl} alt={previewing.title} className="size-full object-cover" />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Tag color="blue">{previewing.kind === 'creative' ? '创作成品' : '功能模板'}</Tag>
              <Tag>{previewing.category}</Tag>
              {previewing.isOfficial && <Tag color="gold" icon={<CrownOutlined />}>官方</Tag>}
              {previewing.isPublic && <Tag color="green">公开</Tag>}
              <span className="text-xs text-text-disabled">使用 {previewing.useCount} 次 · {previewing.creatorName || '未知创建者'}</span>
            </div>
            <div className="max-h-56 overflow-auto whitespace-pre-wrap rounded-xl bg-surface p-4 text-sm leading-relaxed aigc-hub-scrollbar">
              {previewing.content}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
