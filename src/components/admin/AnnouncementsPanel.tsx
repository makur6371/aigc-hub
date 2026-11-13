'use client'

import { useState, useEffect, useCallback } from 'react'
import dayjs from 'dayjs'
import {
  Card,
  Table,
  Button,
  Form,
  Input,
  Switch,
  Modal,
  Space,
  Popconfirm,
  Typography,
  Select,
  DatePicker,
  App,
} from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  NotificationOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { apiFetch } from '@/lib/api-client'

const { Text, Paragraph } = Typography

type AnnouncementItem = {
  id: string
  title: string
  content: string
  type: string // general / featured
  isActive: boolean
  publishedAt: string | null
  endsAt: string | null
  createdAt: string
  updatedAt: string
}

export function AnnouncementsPanel() {
  const { message } = App.useApp()
  const [items, setItems] = useState<AnnouncementItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<AnnouncementItem | null>(null)
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)

  const fetchItems = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch<{ items: AnnouncementItem[]; total: number }>('/api/admin/announcements', {
        params: {
          page: String(page),
          pageSize: String(pageSize),
          isActive: statusFilter,
        },
      })
      if (res.success && res.data) {
        setItems(res.data.items)
        setTotal(res.data.total)
      } else {
        message.error(res.message)
      }
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, statusFilter, message])

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchItems(), 0)
    return () => window.clearTimeout(timer)
  }, [fetchItems])

  const openModal = (a?: AnnouncementItem) => {
    setEditing(a || null)
    form.resetFields()
    if (a) {
      form.setFieldsValue({
        title: a.title,
        content: a.content,
        type: a.type,
        isActive: a.isActive,
        publishedAt: a.publishedAt ? dayjs(a.publishedAt) : null,
        endsAt: a.endsAt ? dayjs(a.endsAt) : null,
      })
    } else {
      form.setFieldsValue({ type: 'general', isActive: true })
    }
    setModalOpen(true)
  }

  const save = async () => {
    const values = await form.validateFields()
    // publishedAt 是 dayjs 对象 → 转 ISO 字符串（后端空则立即上线）
    const payload = {
      ...values,
      publishedAt: values.publishedAt ? (values.publishedAt as dayjs.Dayjs).toISOString() : null,
      endsAt: values.endsAt ? (values.endsAt as dayjs.Dayjs).toISOString() : null,
    }
    setSaving(true)
    try {
      const url = editing ? `/api/admin/announcements/${editing.id}` : '/api/admin/announcements'
      const method = editing ? 'PUT' : 'POST'
      const res = await apiFetch(url, {
        method,
        body: JSON.stringify(payload),
      })
      if (res.success) {
        message.success(res.message)
        setModalOpen(false)
        fetchItems()
      } else {
        message.error(res.message)
      }
    } catch {
      message.error('操作失败')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: string) => {
    try {
      const res = await apiFetch(`/api/admin/announcements/${id}`, { method: 'DELETE' })
      if (res.success) {
        message.success('删除成功')
        fetchItems()
      } else {
        message.error(res.message)
      }
    } catch {
      message.error('删除失败')
    }
  }

  const columns: ColumnsType<AnnouncementItem> = [
    { title: '标题', dataIndex: 'title', width: 180, ellipsis: true },
    {
      title: '类型', dataIndex: 'type', width: 80, align: 'center',
      render: (t: string) => t === 'featured'
        ? <span className="text-xs font-medium text-warning-deep">精选</span>
        : <span className="text-xs text-accent">常规</span>,
    },
    {
      title: '内容', dataIndex: 'content', ellipsis: true,
      render: (c: string) => <Text className="text-xs text-text-secondary">{c}</Text>,
    },
    {
      title: '上线时间', dataIndex: 'publishedAt', width: 170,
      render: (v: string | null) => v
        ? <Text className="text-xs text-text-secondary">{dayjs(v).format('YYYY-MM-DD HH:mm')}</Text>
        : <Text className="text-xs text-text-disabled">立即</Text>,
    },
    {
      title: '下线时间', dataIndex: 'endsAt', width: 170,
      render: (v: string | null) => v
        ? <Text className="text-xs text-text-secondary">{dayjs(v).format('YYYY-MM-DD HH:mm')}</Text>
        : <Text className="text-xs text-text-disabled">不过期</Text>,
    },
    {
      title: '状态', dataIndex: 'isActive', width: 80, align: 'center',
      render: (v: boolean) => v
        ? <CheckCircleOutlined className="text-success" />
        : <CloseCircleOutlined className="text-text-disabled" />,
    },
    {
      title: '创建时间', dataIndex: 'createdAt', width: 170,
      render: (v: string) => <Text className="text-xs text-text-secondary">{dayjs(v).format('YYYY-MM-DD HH:mm')}</Text>,
    },
    {
      title: '操作', width: 140,
      render: (_: unknown, r: AnnouncementItem) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openModal(r)}>编辑</Button>
          <Popconfirm title="确定删除？" onConfirm={() => remove(r.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <Card
        variant="outlined"
        title={<Space><NotificationOutlined />公告管理</Space>}
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>新增公告</Button>}
      >
        <Paragraph className="text-xs text-text-secondary mb-4">
          公告用于向用户展示系统通知。仅「启用」状态的公告会展示给用户。
        </Paragraph>
        <Space className="mb-4">
          <Text className="text-xs text-text-secondary">状态：</Text>
          <Select
            allowClear
            placeholder="全部"
            style={{ width: 120 }}
            value={statusFilter}
            onChange={(v) => { setStatusFilter(v); setPage(1) }}
            options={[
              { value: 'true', label: '已启用' },
              { value: 'false', label: '已停用' },
            ]}
          />
        </Space>
        <Table
          dataSource={items}
          columns={columns}
          rowKey="id"
          loading={loading}
          size="middle"
          scroll={{ x: 800 }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            onChange: (p, ps) => { setPage(p); setPageSize(ps) },
          }}
        />
      </Card>

      <Modal
        title={editing ? '编辑公告' : '新增公告'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={save}
        confirmLoading={saving}
        width={520}
      >
        <Form form={form} layout="vertical" className="mt-4">
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input placeholder="公告标题" maxLength={100} />
          </Form.Item>
          <Form.Item name="content" label="内容" rules={[{ required: true, message: '请输入内容' }]}>
            <Input.TextArea placeholder="公告内容" rows={5} maxLength={2000} showCount />
          </Form.Item>
          <div className="grid grid-cols-2 gap-4">
            <Form.Item name="type" label="类型">
              <Select
                options={[
                  { value: 'general', label: '常规公告' },
                  { value: 'featured', label: '精选公告' },
                ]}
              />
            </Form.Item>
            <Form.Item name="publishedAt" label="上线时间（留空=立即）">
              <DatePicker showTime className="w-full" placeholder="选择时间" />
            </Form.Item>
            <Form.Item name="endsAt" label="下线时间（留空=不过期）"
              extra="活动公告到点自动隐藏">
              <DatePicker showTime className="w-full" placeholder="选择时间" />
            </Form.Item>
          </div>
          <Form.Item name="isActive" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
