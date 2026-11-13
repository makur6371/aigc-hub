'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Card,
  Image,
  Modal,
  Pagination,
  Typography,
  Tag,
  App,
  Button,
  Segmented,
  Checkbox,
  Popconfirm,
  Space,
} from 'antd'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageState } from '@/components/ui/PageState'
import { MediaGridSkeleton } from '@/components/ui/MediaGridSkeleton'
import { BrandTag } from '@/components/ui/BrandTag'
import { StatusTag } from '@/components/ui/StatusTag'
import { MediaActionsBar } from '@/components/ui/MediaActionsBar'
import { apiFetch } from '@/lib/api-client'
import { PictureOutlined, DeleteOutlined, ClearOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'

const { Title, Text } = Typography

const PAGE_SIZE = 12

type ImageModel = {
  id: string
  name: string
  modelName: string
  type: string
}

type ImageRecord = {
  id: string
  prompt: string
  negativePrompt: string | null
  width: number | null
  height: number | null
  imageUrl: string
  costPoints: number
  status: string
  errorMessage: string | null
  createdAt: string
  /** 是否已失效（后端算好，前端直接用） */
  expired?: boolean
  model: ImageModel
}

type PaginatedResponse = {
  items: ImageRecord[]
  total: number
}

export default function UserImagesPage() {
  const { message } = App.useApp()
  const [records, setRecords] = useState<ImageRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  // 筛选：全部 / 有效 / 已失效
  const [filter, setFilter] = useState<'all' | 'valid' | 'expired'>('all')
  // 多选批量删除
  const [selected, setSelected] = useState<string[]>([])

  const fetchRecords = useCallback(
    async (currentPage: number, f: 'all' | 'valid' | 'expired') => {
      setLoading(true)
      try {
        const res = await apiFetch<PaginatedResponse>('/api/user/images', {
          params: { page: currentPage, pageSize: PAGE_SIZE, ...(f !== 'all' ? { filter: f } : {}) },
        })
        if (res.success && res.data) {
          setRecords(res.data.items)
          setTotal(res.data.total)
          setSelected([])  // 换页/换筛选后清空选中，避免删到看不见的记录
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
    const timer = window.setTimeout(() => void fetchRecords(1, filter), 0)
    return () => window.clearTimeout(timer)
  }, [fetchRecords, filter])

  const handlePageChange = (p: number) => {
    setPage(p)
    fetchRecords(p, filter)
  }

  // 批量删除选中
  const handleDeleteSelected = async () => {
    if (selected.length === 0) return
    try {
      const res = await apiFetch<{ deleted: number }>('/api/user/images', {
        method: 'DELETE',
        body: JSON.stringify({ ids: selected }),
      })
      if (res.success) {
        message.success(res.message || `已删除 ${selected.length} 条`)
        setSelected([])
        void fetchRecords(page, filter)
      } else message.error(res.message || '删除失败')
    } catch { message.error('删除失败') }
  }

  // 一键清理失效
  const handlePurgeExpired = async () => {
    try {
      const res = await apiFetch<{ deleted: number }>('/api/user/images', { method: 'POST' })
      if (res.success) {
        message.success(res.message || '已清理')
        setSelected([])
        void fetchRecords(1, filter)
      } else message.error(res.message || '清理失败')
    } catch { message.error('清理失败') }
  }

  return (
    <PageContainer>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Title level={4} className="mb-0">
            <PictureOutlined className="mr-2 text-accent" />
            我的生图记录
          </Title>
          <Space wrap>
            <Segmented
              value={filter}
              onChange={(v) => { setFilter(v as 'all' | 'valid' | 'expired'); setPage(1) }}
              options={[
                { label: '全部', value: 'all' },
                { label: '有效', value: 'valid' },
                { label: '已失效', value: 'expired' },
              ]}
            />
            {selected.length > 0 && (
              <Popconfirm
                title={`删除选中的 ${selected.length} 条记录？`}
                description="本站素材会一并删除，外链图片只删记录"
                onConfirm={handleDeleteSelected}
                okText="删除"
                cancelText="取消"
              >
                <Button danger icon={<DeleteOutlined />}>删除选中（{selected.length}）</Button>
              </Popconfirm>
            )}
            <Popconfirm
              title="清理全部已失效记录？"
              description="只清理已过期的，有效图片不受影响"
              onConfirm={handlePurgeExpired}
              okText="清理"
              cancelText="取消"
            >
              <Button icon={<ClearOutlined />}>清理失效</Button>
            </Popconfirm>
          </Space>
        </div>

        {loading && records.length === 0 ? (
          <MediaGridSkeleton />
        ) : records.length === 0 ? (
          <PageState status="empty" description="暂无生图记录" minHeight="280px" />
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {records.map((record) => (
                <Card
                  key={record.id}
                  variant="outlined"
                  hoverable
                  className="overflow-hidden"
                  cover={
                    <div
                      className="group relative w-full aspect-square bg-surface-hover cursor-pointer"
                      onClick={() => { if (!record.expired) setPreviewUrl(record.imageUrl) }}
                    >
                      {record.expired ? (
                        // 已失效：不发起请求，直接显示占位（避免裂图）
                        <div className="grid h-full w-full place-items-center bg-black/[0.03]">
                          <div className="text-center">
                            <PictureOutlined className="text-2xl text-black/20" />
                            <div className="mt-1 text-[11px] text-black/35">图片已失效</div>
                          </div>
                        </div>
                      ) : (
                        <Image
                          src={record.imageUrl || '/placeholder.png'}
                          alt={record.prompt}
                          preview={false}
                          className="w-full h-full object-cover"
                          rootClassName="w-full h-full"
                          fallback="/placeholder.png"
                        />
                      )}
                      {/* 多选：左上角勾选框，hover 或已选中时显示 */}
                      <div className="absolute left-2 top-2 z-10" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selected.includes(record.id)}
                          onChange={(e) => setSelected((prev) =>
                            e.target.checked ? [...prev, record.id] : prev.filter((x) => x !== record.id))}
                        />
                      </div>
                      {record.expired && (
                        <div className="absolute right-2 top-2">
                          <StatusTag tone="danger">已失效</StatusTag>
                        </div>
                      )}
                      {!record.expired && (
                        <div
                          className="absolute right-1.5 bottom-1.5 z-10 rounded-lg bg-white/85 p-0.5 opacity-0 shadow-sm backdrop-blur transition group-hover:opacity-100 max-lg:opacity-100"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MediaActionsBar
                            compact
                            url={record.imageUrl}
                            kind="image"
                            name="生成图片"
                          />
                        </div>
                      )}
                    </div>
                  }
                >
                  <div className="space-y-2">
                    <Text
                      ellipsis={{ tooltip: record.prompt }}
                      className="block text-sm font-medium text-foreground"
                    >
                      {record.prompt}
                    </Text>
                    <div className="flex items-center gap-2 flex-wrap">
                      <BrandTag>{record.model?.name || '未知模型'}</BrandTag>
                      {record.width && record.height && (
                        <Tag color="default">{record.width} × {record.height}</Tag>
                      )}
                      <StatusTag tone="primary">-{record.costPoints} 积分</StatusTag>
                    </div>
                    <Text className="text-xs text-text-secondary block">
                      {dayjs(record.createdAt).format('YYYY-MM-DD HH:mm:ss')}
                    </Text>
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
                onChange={handlePageChange}
              />
            </div>
          </>
        )}
      </div>

      <Modal
        open={!!previewUrl}
        footer={null}
        centered
        width="auto"
        onCancel={() => setPreviewUrl(null)}
      >
        {previewUrl && (
          <div className="space-y-3">
            <Image
              src={previewUrl}
              fallback="/placeholder.png"
              alt="预览"
              preview={false}
              className="max-w-full max-h-[76vh] object-contain"
            />
            <MediaActionsBar
              url={previewUrl}
              kind="image"
              name="生成图片"
              onClose={() => setPreviewUrl(null)}
            />
          </div>
        )}
      </Modal>
    </PageContainer>
  )
}
