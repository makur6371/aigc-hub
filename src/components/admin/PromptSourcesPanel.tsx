'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Table,
  Button,
  App,
  Space,
  Tag,
  Switch,
  Input,
  Modal,
  Form,
  Typography,
  Popconfirm,
  Tooltip,
} from 'antd'
import { PlusOutlined, ReloadOutlined, SyncOutlined, DeleteOutlined, EditOutlined, LinkOutlined } from '@ant-design/icons'
import { apiFetch } from '@/lib/api-client'
import type { ColumnsType } from 'antd/es/table'

const { Text, Paragraph } = Typography

type SourceRecord = {
  id: string
  name: string
  url: string
  homepage: string | null
  enabled: boolean
  builtIn: boolean
  cacheCover: boolean
  lastStatus: string | null
  lastError: string | null
  lastCount: number | null
  lastPulledAt: string | null
  promptCount: number
  createdAt: string
}

function fmtTime(value: string | null): string {
  if (!value) return '从未'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function PromptSourcesPanel() {
  const { message } = App.useApp()
  const [items, setItems] = useState<SourceRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [pullingId, setPullingId] = useState<string | null>(null)
  const [pullingAll, setPullingAll] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<SourceRecord | null>(null)
  const [form] = Form.useForm()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch<{ items: SourceRecord[] }>('/api/admin/prompt-sources')
      if (res.success && res.data) setItems(Array.isArray(res.data.items) ? res.data.items : [])
      else message.error(res.message || '加载失败')
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const toggle = async (record: SourceRecord, key: 'enabled' | 'cacheCover', value: boolean) => {
    const res = await apiFetch(`/api/admin/prompt-sources/${record.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ [key]: value }),
    }).catch(() => null)
    if (res?.success) load()
    else message.error(res?.message || '操作失败')
  }

  const pullOne = async (record: SourceRecord) => {
    setPullingId(record.id)
    try {
      const res = await apiFetch(`/api/admin/prompt-sources/${record.id}/pull`, { method: 'POST' })
      if (res.success) {
        message[res.data && (res.data as { ok: boolean }).ok ? 'success' : 'warning'](res.message || '完成')
        load()
      } else {
        message.error(res.message || '拉取失败')
      }
    } catch {
      message.error('拉取失败')
    } finally {
      setPullingId(null)
    }
  }

  const pullAll = async () => {
    setPullingAll(true)
    try {
      const res = await apiFetch('/api/admin/prompt-sources/pull-all', { method: 'POST' })
      if (res.success) {
        message.success(res.message || '完成')
        load()
      } else {
        message.error(res.message || '拉取失败')
      }
    } catch {
      message.error('拉取失败')
    } finally {
      setPullingAll(false)
    }
  }

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ enabled: true, cacheCover: true })
    setModalOpen(true)
  }

  const openEdit = (record: SourceRecord) => {
    setEditing(record)
    form.setFieldsValue({
      name: record.name,
      url: record.url,
      homepage: record.homepage || '',
    })
    setModalOpen(true)
  }

  const submit = async () => {
    const values = await form.validateFields()
    const res = editing
      ? await apiFetch(`/api/admin/prompt-sources/${editing.id}`, { method: 'PATCH', body: JSON.stringify(values) }).catch(() => null)
      : await apiFetch('/api/admin/prompt-sources', { method: 'POST', body: JSON.stringify(values) }).catch(() => null)
    if (res?.success) {
      message.success(res.message || '已保存')
      setModalOpen(false)
      load()
    } else {
      message.error(res?.message || '保存失败')
    }
  }

  const remove = async (record: SourceRecord) => {
    const res = await apiFetch(`/api/admin/prompt-sources/${record.id}`, { method: 'DELETE' }).catch(() => null)
    if (res?.success) {
      message.success(res.message || '已删除')
      load()
    } else {
      message.error(res?.message || '删除失败')
    }
  }

  const columns: ColumnsType<SourceRecord> = [
    {
      title: '来源',
      dataIndex: 'name',
      width: 320,
      render: (_: unknown, record) => (
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{record.name}</span>
            {record.builtIn && <Tag className="m-0 shrink-0">内置</Tag>}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-text-disabled">
            {record.homepage ? (
              <a className="max-w-[240px] truncate hover:underline" href={record.homepage} target="_blank" rel="noreferrer">
                {record.homepage}
              </a>
            ) : (
              <span className="max-w-[240px] truncate">{record.url}</span>
            )}
          </div>
        </div>
      ),
    },
    {
      title: '已入库',
      dataIndex: 'promptCount',
      width: 90,
      render: (count: number, record) => (
        <div className="text-sm">
          <span className="tabular-nums">{count}</span>
          {record.lastCount != null && record.lastCount !== count && (
            <span className="ml-1 text-xs text-text-disabled">/ 源 {record.lastCount}</span>
          )}
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'lastStatus',
      width: 200,
      render: (_: unknown, record) => {
        if (record.lastStatus === 'FAILED') {
          return (
            <Tooltip title={record.lastError || '拉取失败'}>
              <div className="flex items-center gap-2">
                <Tag color="error" className="m-0">失败</Tag>
                <span className="text-xs text-text-disabled">上次成功 {fmtTime(record.lastPulledAt)}</span>
              </div>
            </Tooltip>
          )
        }
        if (record.lastStatus === 'SUCCESS') {
          return (
            <div className="flex items-center gap-2">
              <Tag color="success" className="m-0">正常</Tag>
              <span className="text-xs text-text-disabled">上次拉取 {fmtTime(record.lastPulledAt)}</span>
            </div>
          )
        }
        return <Tag className="m-0">未拉取</Tag>
      },
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 70,
      render: (value: boolean, record) => (
        <Switch size="small" checked={value} onChange={(v) => toggle(record, 'enabled', v)} />
      ),
    },
    {
      title: '缓存封面',
      dataIndex: 'cacheCover',
      width: 90,
      render: (value: boolean, record) => (
        <Tooltip title="关闭后该源的提示词卡不显示封面（GitHub 系图片在境内常拉不动，建议关闭）">
          <Switch size="small" checked={value} onChange={(v) => toggle(record, 'cacheCover', v)} />
        </Tooltip>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 220,
      render: (_: unknown, record) => (
        <Space size="small" wrap>
          <Button size="small" icon={<SyncOutlined />} loading={pullingId === record.id} onClick={() => void pullOne(record)}>
            拉取
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          {!record.builtIn && (
            <Popconfirm
              title="删除来源"
              description="已入库的提示词会保留，仅解除来源关联。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void remove(record)}
            >
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Paragraph type="secondary" className="!mb-3 text-[13px]">
        可配置自己的标准 JSON 提示词来源。
        拉取时会自动尝试国内镜像；已入库的提示词可编辑、可审核，与用户自建提示词共用同一套管理。
      </Paragraph>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Text strong>提示词来源</Text>
        <Space wrap>
          <Button icon={<ReloadOutlined />} loading={pullingAll} onClick={() => void pullAll()}>
            全部拉取
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增来源
          </Button>
        </Space>
      </div>

      <Table
        dataSource={items}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={false}
        scroll={{ x: 1000 }}
      />

      <Modal
        title={editing ? '编辑来源' : '新增来源'}
        open={modalOpen}
        onOk={() => void submit()}
        onCancel={() => setModalOpen(false)}
        okText="保存"
        cancelText="取消"
        width={620}
      >
        <Form form={form} layout="vertical" className="mt-2">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：My Prompt Collection" disabled={!!editing?.builtIn} />
          </Form.Item>
          <Form.Item
            name="url"
            label="标准 JSON 地址"
            rules={[
              { required: true, message: '请输入 URL' },
              { pattern: /^https?:\/\//i, message: '必须是 http(s) 地址' },
            ]}
          >
            <Input placeholder="https://raw.githubusercontent.com/owner/repo/main/prompts.json" prefix={<LinkOutlined className="opacity-45" />} />
          </Form.Item>
          <Form.Item name="homepage" label="原始主页（可选）">
            <Input placeholder="https://github.com/owner/repo" disabled={!!editing?.builtIn} />
          </Form.Item>
          <div className="text-xs text-text-disabled">
            数据格式：JSON 数组，每项至少包含 <Text code>title</Text> 与 <Text code>prompt</Text>；
            可选 <Text code>coverUrl / tags / author / sourceUrl / id</Text>。
          </div>
        </Form>
      </Modal>
    </div>
  )
}
