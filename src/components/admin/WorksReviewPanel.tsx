'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, Table, Tag, Button, Typography, App, Space, Segmented, Popconfirm, InputNumber, Modal, Form, Input, Select } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { CheckOutlined, CloseOutlined, StarOutlined, CrownFilled, DeleteOutlined, EditOutlined, EyeOutlined } from '@ant-design/icons'
import { BrandTag } from '@/components/ui/BrandTag'
import { WORK_CATEGORIES } from '@/lib/constants/categories'
import dayjs from 'dayjs'

const { Text } = Typography

type WorkItem = {
  id: string
  slug: string
  title: string
  description: string
  type: string
  category?: string | null
  images?: string[]
  status: string
  featured?: boolean
  prompts?: string[]
  authorName: string
  createdAt: string
  coverUrl?: string | null
}

import { StatusTag, type StatusTone } from '@/components/ui/StatusTag'
import { apiFetch } from '@/lib/api-client'
import { workTypeGlyph } from '@/lib/media-kinds'

const statusMeta: Record<string, { text: string; tone: StatusTone }> = {
  PENDING: { text: '待审核', tone: 'warning' },
  APPROVED: { text: '已通过', tone: 'success' },
  REJECTED: { text: '已驳回', tone: 'danger' },
}

const PAGE_SIZE = 10

export function WorksReviewPanel() {
  const { message, modal } = App.useApp()
  const [items, setItems] = useState<WorkItem[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState<string>('all')
  const [reviewing, setReviewing] = useState<string | null>(null)
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editing, setEditing] = useState<WorkItem | null>(null)
  const [previewing, setPreviewing] = useState<WorkItem | null>(null)
  const [form] = Form.useForm()

  const fetchWorks = useCallback(async (p: number, s: string) => {
    setLoading(true)
    try {
      const res = await apiFetch<{ items: WorkItem[]; total: number }>('/api/admin/works', {
        params: {
          page: String(p),
          pageSize: String(PAGE_SIZE),
          featured: s === 'FEATURED' ? '1' : undefined,
          status: s !== 'all' && s !== 'FEATURED' ? s : undefined,
        },
      })
      if (res.success && res.data) {
        setItems(res.data.items)
        setTotal(res.data.total)
      } else {
        message.error(res.message || '加载失败')
      }
    } catch {
      message.error('网络错误')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchWorks(1, status), 0)
    return () => window.clearTimeout(timer)
  }, [fetchWorks, status])

  const handleReview = async (id: string, action: 'approve' | 'reject' | 'official', points = 0) => {
    setReviewing(id)
    try {
      const res = await apiFetch(`/api/admin/works/${id}/review`, {
        method: 'POST',
        body: JSON.stringify({ action, points }),
      })
      if (res.success) {
        message.success(res.message)
        fetchWorks(page, status)
      } else {
        message.error(res.message || '操作失败')
      }
    } catch {
      message.error('操作失败')
    } finally {
      setReviewing(null)
    }
  }

  // 通过 / 封官方：弹窗手输奖励积分（通过 0~1000、封官方 0~10000）
  const reviewWithPoints = (r: WorkItem, action: 'approve' | 'official') => {
    const max = action === 'official' ? 10000 : 1000
    let points = action === 'official' ? 100 : 20
    modal.confirm({
      title: action === 'official' ? `封为官方作品「${r.title}」` : `通过审核「${r.title}」`,
      content: (
        <div className="pt-2">
          <div className="mb-1.5 text-[13px] text-black/60">
            {action === 'official' ? '官方作品会在作品广场置顶精选，奖励作者积分（0~10000）：' : '审核通过并展示在作品广场，奖励作者积分（0~1000）：'}
          </div>
          <InputNumber min={0} max={max} defaultValue={points} onChange={(v) => { points = Number(v || 0) }} className="!w-40" addonAfter="积分" />
        </div>
      ),
      okText: action === 'official' ? '封为官方' : '通过并发放',
      onOk: async () => {
        await handleReview(r.id, action, points)
      },
    })
  }

  const handleToggleFeatured = async (id: string, featured: boolean) => {
    setReviewing(id)
    try {
      const res = await apiFetch(`/api/admin/works/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ featured }),
      })
      if (res.success) {
        message.success(res.message)
        fetchWorks(page, status)
      } else {
        message.error(res.message || '操作失败')
      }
    } catch {
      message.error('操作失败')
    } finally {
      setReviewing(null)
    }
  }

  const handleEdit = (record: WorkItem) => {
    setEditing(record)
    form.setFieldsValue({
      title: record.title,
      description: record.description,
      category: record.category,
    })
    setEditModalOpen(true)
  }

  const handleSaveEdit = async () => {
    if (!editing) return
    try {
      const values = await form.validateFields()
      const res = await apiFetch(`/api/admin/works/${editing.id}`, {
        method: 'PATCH',
        body: JSON.stringify(values),
      })
      if (res.success) {
        message.success('保存成功')
        setEditModalOpen(false)
        setEditing(null)
        form.resetFields()
        fetchWorks(page, status)
      } else {
        message.error(res.message || '保存失败')
      }
    } catch {
      message.error('保存失败')
    }
  }

  const handleStatus = async (id: string, nextStatus: 'APPROVED' | 'REJECTED') => {
    setReviewing(id)
    try {
      const res = await apiFetch(`/api/admin/works/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      })
      if (res.success) {
        message.success(res.message)
        fetchWorks(page, status)
      } else {
        message.error(res.message || '操作失败')
      }
    } catch {
      message.error('网络错误')
    } finally {
      setReviewing(null)
    }
  }

  const handleDelete = async (id: string) => {
    setReviewing(id)
    try {
      const res = await apiFetch(`/api/admin/works/${id}`, { method: 'DELETE' })
      if (res.success) {
        message.success(res.message)
        fetchWorks(page, status)
      } else {
        message.error(res.message || '删除失败')
      }
    } catch {
      message.error('网络错误')
    } finally {
      setReviewing(null)
    }
  }

  const columns: ColumnsType<WorkItem> = [
    {
      title: '封面',
      dataIndex: 'coverUrl',
      width: 90,
      render: (url: string | null | undefined, r) => (
        url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={r.title} className="size-14 rounded object-cover" loading="lazy" />
        ) : (
          <div className="grid size-14 place-items-center rounded bg-surface text-text-disabled">
            {workTypeGlyph(r.type)}
          </div>
        )
      ),
    },
    {
      title: '标题',
      dataIndex: 'title',
      ellipsis: true,
      render: (t: string, r) => (
        <button type="button" className="cursor-pointer text-left text-sm font-medium text-accent hover:underline" onClick={() => setPreviewing(r)}>
          {t}
        </button>
      ),
    },
    {
      title: '类型',
      dataIndex: 'type',
      width: 90,
      render: (t: string) => <BrandTag>{t === 'workflow' ? '工作流' : t}</BrandTag>,
    },
    {
      title: '分类',
      dataIndex: 'category',
      width: 120,
      render: (c: string | null) => c ? <Tag>{c}</Tag> : <Text type="secondary">未分类</Text>,
    },
    {
      title: '关联提示词',
      dataIndex: 'prompts',
      width: 220,
      render: (prompts: string[] | undefined) => prompts?.length
        ? <Text className="line-clamp-2 text-xs text-text-muted">{prompts[0]}</Text>
        : <Text type="secondary">未提取到</Text>,
    },
    {
      title: '作者',
      dataIndex: 'authorName',
      width: 120,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string) => {
        const meta = statusMeta[s] || { text: s, tone: 'primary' as StatusTone }
        return <StatusTag tone={meta.tone}>{meta.text}</StatusTag>
      },
    },
    {
      title: '发布时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (d: string) => dayjs(d).format('YYYY-MM-DD HH:mm'),
    },
    {
      title: '操作',
      width: 370,
      render: (_: unknown, r: WorkItem) => (
        <Space size="small">
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleEdit(r)}
          >
            编辑
          </Button>
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => setPreviewing(r)}>预览</Button>
          {r.status === 'PENDING' ? (
            <>
              <Button
                type="link"
                size="small"
                icon={<CheckOutlined />}
                loading={reviewing === r.id}
                onClick={() => reviewWithPoints(r, 'approve')}
              >
                通过
              </Button>
              <Button
                type="link"
                size="small"
                icon={<CrownFilled />}
                loading={reviewing === r.id}
                onClick={() => reviewWithPoints(r, 'official')}
              >
                封官方
              </Button>
              <Popconfirm
                title="确认驳回该作品？"
                description="驳回后作品将下架，作者可修改后重新提交。"
                okText="驳回"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => handleReview(r.id, 'reject')}
              >
                <Button type="link" size="small" danger icon={<CloseOutlined />} loading={reviewing === r.id}>
                  驳回
                </Button>
              </Popconfirm>
            </>
          ) : (
            <Button
              type="link"
              size="small"
              loading={reviewing === r.id}
              onClick={() => handleStatus(r.id, r.status === 'APPROVED' ? 'REJECTED' : 'APPROVED')}
            >
              {r.status === 'APPROVED' ? '下架' : '上架'}
            </Button>
          )}
          {/* 首页精选开关（仅已通过作品可设） */}
          {r.status === 'APPROVED' && (
            <Button
              type="link"
              size="small"
              icon={<StarOutlined />}
              loading={reviewing === r.id}
              onClick={() => handleToggleFeatured(r.id, !r.featured)}
              className={r.featured ? 'text-warning-amber' : ''}
            >
              {r.featured ? '取消精选' : '首页精选'}
            </Button>
          )}
          <Popconfirm
            title="确认删除该作品？"
            description="删除后作品及其后台快照将不可恢复。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => handleDelete(r.id)}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />} loading={reviewing === r.id}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <>
      <Card variant="outlined">
        <div className="flex items-center justify-between mb-4">
          <Text strong>作品管理</Text>
          <Segmented
            value={status}
            onChange={(v) => setStatus(String(v))}
            options={[
              { label: '全部', value: 'all' },
              { label: '待审核', value: 'PENDING' },
              { label: '已通过', value: 'APPROVED' },
              { label: '已驳回', value: 'REJECTED' },
              { label: '已精选', value: 'FEATURED' },
            ]}
          />
        </div>
        <Table
          dataSource={items}
          columns={columns}
          rowKey="id"
          loading={loading}
          scroll={{ x: 'max-content' }}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total,
            showSizeChanger: false,
            onChange: (p) => { setPage(p); fetchWorks(p, status) },
          }}
          size="middle"
        />
      </Card>

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
            <div className="grid max-h-[45vh] grid-cols-2 gap-2 overflow-auto rounded-xl bg-surface p-2 aigc-hub-scrollbar">
              {(previewing.images?.length ? previewing.images : previewing.coverUrl ? [previewing.coverUrl] : []).map((url, index) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={`${url}-${index}`} src={url} alt={`${previewing.title} ${index + 1}`} className="max-h-[38vh] w-full rounded-lg object-contain" />
              ))}
              {!previewing.coverUrl && !previewing.images?.length && (
                <div className="col-span-2 grid h-40 place-items-center rounded-lg bg-white text-sm text-text-disabled">
                  该作品暂无可预览的图片
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><Text type="secondary" className="block text-xs">类型 / 分类</Text>{previewing.type} / {previewing.category || '未分类'}</div>
              <div><Text type="secondary" className="block text-xs">状态</Text>{statusMeta[previewing.status]?.text || previewing.status}</div>
              <div><Text type="secondary" className="block text-xs">作者</Text>{previewing.authorName}</div>
              <div><Text type="secondary" className="block text-xs">提交时间</Text>{dayjs(previewing.createdAt).format('YYYY-MM-DD HH:mm')}</div>
            </div>
            <div>
              <Text type="secondary" className="block text-xs">描述</Text>
              <div className="mt-1 max-h-32 overflow-auto rounded-lg bg-white p-3 text-sm leading-relaxed aigc-hub-scrollbar">
                {previewing.description || '暂无描述'}
              </div>
            </div>
            {previewing.prompts?.length ? (
              <div>
                <Text type="secondary" className="block text-xs">关联提示词</Text>
                <div className="mt-1 max-h-40 overflow-auto rounded-lg bg-white p-3 text-xs leading-relaxed whitespace-pre-wrap text-text-muted aigc-hub-scrollbar">
                  {previewing.prompts.join('\n---\n')}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </Modal>

      <Modal
        title="编辑作品"
        open={editModalOpen}
        onOk={handleSaveEdit}
        onCancel={() => {
          setEditModalOpen(false)
          setEditing(null)
          form.resetFields()
        }}
        width={600}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="category" label="分类">
            <Select allowClear placeholder="选择分类">
              {WORK_CATEGORIES.map((c) => (
                <Select.Option key={c} value={c}>{c}</Select.Option>
              ))}
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
