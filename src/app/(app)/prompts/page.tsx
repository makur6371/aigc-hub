'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Card,
  Typography,
  App,
  Button,
  Input,
  Modal,
  Form,
  Switch,
  Select,
  Pagination,
  Segmented,
  Tooltip,
  Popconfirm,
} from 'antd'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageState } from '@/components/ui/PageState'
import { BrandTag } from '@/components/ui/BrandTag'
import { StatusTag } from '@/components/ui/StatusTag'
import { PlusOutlined, CopyOutlined, CheckOutlined, DeleteOutlined, EditOutlined, SearchOutlined, BookOutlined } from '@ant-design/icons'
import { apiFetch } from '@/lib/api-client'
import { PROMPT_CATEGORIES } from '@/lib/constants/categories'
import { toAssetProxyUrl, toProxyUrl } from '@/lib/media-url'
import { MediaActionsBar } from '@/components/ui/MediaActionsBar'
import { FirstUseGuide, GUIDE_STEPS } from '@/components/ui/FirstUseGuide'

const { Title, Text } = Typography

type PromptItem = {
  id: string
  title: string
  content: string
  category: string
  kind?: string // creative=创作型成品（有图）/ functional=功能型模板
  coverUrl: string | null
  isPublic: boolean
  status?: string
  useCount: number
  creatorName: string
  isMine: boolean
  createdAt: string
}

const PAGE_SIZE = 18
// 与导入的真实分类一致（提示词库数据来自 open source 创意库）；Select 会用 'all' 做"全部分类"哨兵
const CATEGORIES = [...PROMPT_CATEGORIES]

export default function PromptsPage() {
  const { message } = App.useApp()
  const [items, setItems] = useState<PromptItem[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  // 来源：mine=我创建打磨的 / official=官方 / favorite=收藏的（作品广场收藏 = 复制进我的，归 mine；official 为官方账号发布）
  const [source, setSource] = useState<'mine' | 'official'>('mine')
  const [kind, setKind] = useState<'all' | 'creative' | 'functional'>('all')
  const [category, setCategory] = useState<string>('all')
  const [keyword, setKeyword] = useState('')
  const [editing, setEditing] = useState<PromptItem | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  // 点击卡片查看详情（小卡片弹层）
  const [viewing, setViewing] = useState<PromptItem | null>(null)
  const [form] = Form.useForm()

  const fetchItems = useCallback(
    async (p: number, src: string, kd: string, cat: string, kw: string) => {
      setLoading(true)
      try {
        const res = await apiFetch<{ items: PromptItem[]; total: number }>('/api/prompts', {
          params: { page: String(p), pageSize: String(PAGE_SIZE), scope: src, kind: kd !== 'all' ? kd : undefined, category: cat, keyword: kw.trim() || undefined },
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
    },
    [message]
  )

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchItems(1, source, kind, category, keyword), 0)
    return () => window.clearTimeout(timer)
  }, [fetchItems, source, kind, category, keyword])

  const handleCopy = async (item: PromptItem) => {
    try {
      await navigator.clipboard.writeText(item.content)
      setCopiedId(item.id)
      setTimeout(() => setCopiedId(null), 2000)
      await apiFetch(`/api/prompts/${item.id}/use`, { method: 'POST' }).catch(() => {})
      setItems((prev) => prev.map((it) => it.id === item.id ? { ...it, useCount: it.useCount + 1 } : it))
    } catch { /* ignore */ }
  }

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ category: '通用', isPublic: false, kind: 'creative' })
    setModalOpen(true)
  }

  const openEdit = (item: PromptItem) => {
    setEditing(item)
    form.setFieldsValue({ title: item.title, content: item.content, category: item.category, isPublic: item.isPublic, kind: item.kind === 'functional' ? 'functional' : 'creative' })
    setModalOpen(true)
  }

  const handleSave = async () => {
    const values = await form.validateFields()
    const url = editing ? `/api/prompts/${editing.id}` : '/api/prompts'
    const method = editing ? 'PUT' : 'POST'
    try {
      const res = await apiFetch(url, {
        method,
        body: JSON.stringify(values),
      })
      if (res.success) {
        message.success(editing ? '已更新' : '已保存')
        setModalOpen(false)
        fetchItems(page, source, kind, category, keyword)
      } else {
        message.error(res.message || '保存失败')
      }
    } catch {
      message.error('保存失败')
    }
  }

  const handleDelete = async (id: string) => {
    try {
      const res = await apiFetch(`/api/prompts/${id}`, { method: 'DELETE' })
      if (res.success) {
        message.success('已删除')
        fetchItems(page, source, kind, category, keyword)
      } else {
        message.error(res.message || '删除失败')
      }
    } catch {
      message.error('删除失败')
    }
  }

  return (
    <PageContainer>
      <FirstUseGuide storageKey="prompts" steps={[...GUIDE_STEPS.prompts]} />
      <div className="space-y-5">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <Title level={4} className="mb-0"><BookOutlined className="mr-2 text-accent" />提示词库</Title>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建提示词</Button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            data-guide="prompts-source"
            value={source}
            onChange={(v) => setSource(v as 'mine' | 'official')}
            options={[
              { label: '我创建的', value: 'mine' },
              { label: '官方', value: 'official' },
            ]}
          />
          <Segmented
            value={kind}
            onChange={(v) => setKind(v as 'all' | 'creative' | 'functional')}
            options={[
              { label: '全部', value: 'all' },
              { label: '创作型成品', value: 'creative' },
              { label: '功能型模板', value: 'functional' },
            ]}
          />
          <Select
            value={category}
            onChange={setCategory}
            className="w-[130px]"
            options={['all', ...CATEGORIES].map((c) => ({ value: c, label: c === 'all' ? '全部分类' : c }))}
          />
          <Input
            data-guide="prompts-search"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onPressEnter={() => fetchItems(1, source, kind, category, keyword)}
            placeholder="搜索标题/内容，支持语义检索"
            prefix={<SearchOutlined className="text-text-disabled" />}
            className="w-[240px]"
            allowClear
          />
        </div>

        {loading && items.length === 0 ? (
          <PageState status="loading" description="加载中…" minHeight="280px" />
        ) : items.length === 0 ? (
          <PageState status="empty" description="还没有保存的提示词，去作品广场浏览时点击「添加到提示词库」收藏" minHeight="280px" />
        ) : (
          <>
            <div className="columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-4">
              {items.map((item) => (
                <Card
                  key={item.id}
                  variant="outlined"
                  hoverable
                  className="break-inside-avoid mb-4 flex flex-col overflow-hidden cursor-pointer"
                  onClick={() => setViewing(item)}
                >
                  {item.coverUrl && (
                    <div id={'prompt-cover-' + item.id} className="relative w-full overflow-hidden bg-surface-hover">
                      {/*eslint-disable-next-line @next/next/no-img-element*/}
                      <img src={toProxyUrl(item.coverUrl)} alt={item.title} loading="lazy" decoding="async"
                        className="h-auto w-full object-cover"
                        onError={() => { const el = document.getElementById('prompt-cover-' + item.id); if (el) el.style.display = 'none' }} />
                    </div>
                  )}
                  <div className="flex items-start gap-2 mb-2 pt-3 px-3">
                    <BrandTag className="m-0 shrink-0">{item.category}</BrandTag>
                    {item.isPublic && item.status === 'PENDING' && <StatusTag tone="warning" className="m-0 shrink-0">待审核</StatusTag>}
                    {item.isPublic && item.status === 'REJECTED' && <StatusTag tone="danger" className="m-0 shrink-0">未通过</StatusTag>}
                    {item.isPublic && item.status === 'APPROVED' && <StatusTag tone="primary" className="m-0 shrink-0">公开</StatusTag>}
                    <Text strong className="text-sm text-foreground flex-1 min-w-0 truncate">{item.title}</Text>
                  </div>
                  <div className="px-3">
                  <Text className="whitespace-pre-wrap text-xs text-text-secondary line-clamp-3 flex-1">
                    {item.content}
                  </Text>
                  </div>
                  <div className="flex items-center justify-between mt-3 pt-2 border-t border-surface-hover px-3 pb-3" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-1.5">
                      <Text className="text-xs text-text-muted">{item.creatorName}</Text>
                      <Text className="text-xs text-text-disabled">·</Text>
                      <Text className="text-xs font-medium text-accent">{item.useCount} 次使用</Text>
                    </div>
                    <div className="flex items-center gap-1">
                      {item.isMine && (
                        <>
                          <Tooltip title="编辑">
                            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEdit(item)} />
                          </Tooltip>
                          <Tooltip title="删除">
                            <Popconfirm
                              title="删除提示词"
                              description="确定删除这条提示词？此操作不可恢复。"
                              okText="删除"
                              cancelText="取消"
                              okButtonProps={{ danger: true }}
                              onConfirm={() => handleDelete(item.id)}
                            >
                              <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                            </Popconfirm>
                          </Tooltip>
                        </>
                      )}
                      <Button
                        type="primary"
                        size="small"
                        icon={copiedId === item.id ? <CheckOutlined /> : <CopyOutlined />}
                        onClick={() => handleCopy(item)}
                      >
                        {copiedId === item.id ? '已复制' : '复制'}
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>

            <div className="flex justify-end pt-2">
              <Pagination
                current={page}
                pageSize={PAGE_SIZE}
                total={total}
                showSizeChanger={false}
                onChange={(p) => { setPage(p); fetchItems(p, source, kind, category, keyword) }}
              />
            </div>
          </>
        )}
      </div>

      {/* 详情小卡片弹层 */}
      <Modal
        open={!!viewing}
        onCancel={() => setViewing(null)}
        footer={null}
        title={viewing?.title}
        width={480}
        centered
      >
        {viewing && (
          <div className="space-y-3">
            {viewing.coverUrl && (
              //eslint-disable-next-line @next/next/no-img-element
              <img src={toProxyUrl(viewing.coverUrl)} alt={viewing.title} className="w-full rounded-xl object-cover"
                onError={(e) => { e.currentTarget.style.display = 'none' }} />
            )}
            <div className="flex items-center gap-2">
              <BrandTag>{viewing.category}</BrandTag>
              <Text className="text-xs text-text-muted">{viewing.creatorName}</Text>
              <Text className="text-xs font-medium text-accent">{viewing.useCount} 次使用</Text>
            </div>
            <div className="rounded-xl bg-surface p-3 text-xs text-foreground whitespace-pre-wrap leading-relaxed aigc-hub-scrollbar max-h-72 overflow-y-auto">
              {viewing.content}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {viewing.coverUrl && (
                <MediaActionsBar
                  url={toAssetProxyUrl(viewing.coverUrl)}
                  kind="image"
                  name={viewing.title}
                  onClose={() => setViewing(null)}
                />
              )}
              <Button
                type="primary"
                icon={copiedId === viewing.id ? <CheckOutlined /> : <CopyOutlined />}
                onClick={() => { handleCopy(viewing); setViewing(null) }}
              >
                {copiedId === viewing.id ? '已复制' : '复制提示词'}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSave}
        title={editing ? '编辑提示词' : '新建提示词'}
        width={640}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" className="mt-4">
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input placeholder="例如：电商主图提示词" maxLength={60} />
          </Form.Item>
          <Form.Item name="content" label="内容" rules={[{ required: true, message: '请输入内容' }]}>
            <Input.TextArea rows={6} placeholder="提示词内容，可包含 {变量} 占位符" />
          </Form.Item>
          <div className="flex gap-4">
            <Form.Item name="kind" label="类型" className="flex-1">
              <Select
                options={[
                  { value: 'creative', label: '创作型成品（配成品图，靠图选用）' },
                  { value: 'functional', label: '功能型模板（可套用，靠标题/描述选用）' },
                ]}
              />
            </Form.Item>
            <Form.Item name="category" label="分类" className="flex-1">
              <Select options={CATEGORIES.map((c) => ({ value: c, label: c }))} />
            </Form.Item>
            <Form.Item name="isPublic" label="公开到公共库" valuePropName="checked">
              <Switch />
            </Form.Item>
          </div>
        </Form>
      </Modal>
    </PageContainer>
  )
}
