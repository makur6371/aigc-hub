'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Card,
  Modal,
  Pagination,
  Typography,
  App,
  Button,
  Segmented,
  Tooltip,
  Popconfirm,
} from 'antd'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageState } from '@/components/ui/PageState'
import { StatusTag } from '@/components/ui/StatusTag'
import { MediaActionsBar } from '@/components/ui/MediaActionsBar'
import { apiFetch } from '@/lib/api-client'
import type { StatusTone } from '@/components/ui/StatusTag'
import { PictureOutlined, VideoCameraOutlined, SoundOutlined, CopyOutlined, CheckOutlined, DeleteOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'

const { Title, Text } = Typography

const PAGE_SIZE = 24

type AssetItem = {
  id: string
  type: string
  url: string
  fileName: string | null
  mime: string | null
  size: number | null
  source: string
  expiresAt: string | null
  createdAt: string
}

const typeMeta: Record<string, { label: string; icon: React.ReactNode; tone: StatusTone }> = {
  image: { label: '图片', icon: <PictureOutlined />, tone: 'accent' },
  video: { label: '视频', icon: <VideoCameraOutlined />, tone: 'warning' },
  audio: { label: '音频', icon: <SoundOutlined />, tone: 'primary' },
}

export default function UserAssetsPage() {
  const { message } = App.useApp()
  const [assets, setAssets] = useState<AssetItem[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [preview, setPreview] = useState<AssetItem | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const fetchAssets = useCallback(
    async (currentPage: number, type: string) => {
      setLoading(true)
      try {
        const params: Record<string, string | number> = { page: currentPage, pageSize: PAGE_SIZE }
        if (type !== 'all') params.type = type
        const res = await apiFetch<{ items: AssetItem[]; total: number }>('/api/assets', { params })
        if (res.success && res.data) {
          setAssets(res.data.items)
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
    const timer = window.setTimeout(() => void fetchAssets(1, typeFilter), 0)
    return () => window.clearTimeout(timer)
  }, [fetchAssets, typeFilter])

  const handleDelete = async (id: string) => {
    try {
      const res = await apiFetch(`/api/assets/${id}`, { method: 'DELETE' })
      if (res.success) {
        message.success('已删除')
        fetchAssets(page, typeFilter)
      } else {
        message.error(res.message || '删除失败')
      }
    } catch {
      message.error('删除失败')
    }
  }

  const handleCopy = async (asset: AssetItem) => {
    try {
      await navigator.clipboard.writeText(asset.url)
      setCopiedId(asset.id)
      setTimeout(() => setCopiedId(null), 2000)
    } catch { /* ignore */ }
  }

  const handlePageChange = (p: number) => {
    setPage(p)
    fetchAssets(p, typeFilter)
  }

  const renderMedia = (a: AssetItem) => {
    if (a.type === 'video') {
      return (

        <video src={a.url} className="w-full h-full object-cover" muted />
      )
    }
    if (a.type === 'audio') {
      return (
        <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-surface-hover">
          <SoundOutlined className="text-3xl text-success" />
          <audio src={a.url} controls className="w-[80%]" />
        </div>
      )
    }
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={a.url} alt={a.fileName || '素材'} className="w-full h-full object-cover" />
  }

  return (
    <PageContainer>
      <div className="space-y-5">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <Title level={4} className="mb-0">
            素材库
          </Title>
          <div className="flex items-center gap-3">
            <Segmented
              value={typeFilter}
              onChange={(v) => setTypeFilter(String(v))}
              options={[
                { label: '全部', value: 'all' },
                { label: '图片', value: 'image' },
                { label: '视频', value: 'video' },
                { label: '音频', value: 'audio' },
              ]}
            />
          </div>
        </div>

        {loading && assets.length === 0 ? (
          <PageState status="loading" description="加载素材..." minHeight="280px" />
        ) : assets.length === 0 ? (
          <PageState
            status="empty"
            description="暂无素材，去创作或查看生成记录"
            minHeight="280px"
          >
          </PageState>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
              {assets.map((a) => (
                <Card
                  key={a.id}
                  variant="outlined"
                  hoverable
                  className="overflow-hidden"
                  cover={
                    <div
                      className="relative w-full aspect-square bg-surface-hover cursor-pointer group"
                      onClick={() => setPreview(a)}
                    >
                      {renderMedia(a)}
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                        <Text className="text-white text-xs">预览</Text>
                      </div>
                    </div>
                  }
                >
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <StatusTag tone={typeMeta[a.type]?.tone}>{typeMeta[a.type]?.label || a.type}</StatusTag>
                      {a.source === 'generated' && <StatusTag tone="primary" className="m-0">生成</StatusTag>}
                      <span className="ml-auto" />
                      <span onClick={(e) => e.stopPropagation()}>
                        <MediaActionsBar
                          compact
                          url={a.url}
                          kind={a.type}
                          name={a.fileName || '素材'}
                        />
                      </span>
                      <Tooltip title="复制 URL">
                        <Button
                          type="text"
                          size="small"
                          icon={copiedId === a.id ? <CheckOutlined className="text-success" /> : <CopyOutlined />}
                          onClick={(e) => { e.stopPropagation(); handleCopy(a) }}
                        />
                      </Tooltip>
                      <Popconfirm
                        title="删除该素材？"
                        onConfirm={(e) => { e?.stopPropagation(); handleDelete(a.id) }}
                        onCancel={(e) => e?.stopPropagation()}
                        okText="删除"
                        cancelText="取消"
                      >
                        <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
                      </Popconfirm>
                    </div>
                    <Text ellipsis={{ tooltip: a.fileName }} className="block text-xs text-text-secondary">
                      {a.fileName || '未命名素材'}
                    </Text>
                    <Text className="text-[10px] text-text-disabled block">
                      {dayjs(a.createdAt).format('MM-DD HH:mm')}
                      {a.size ? ` · ${(a.size / 1024 / 1024).toFixed(1)}MB` : ''}
                      {a.expiresAt ? ` · ${dayjs(a.expiresAt).format('MM-DD HH:mm')} 过期` : ''}
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
        open={!!preview}
        footer={null}
        centered
        width={720}
        onCancel={() => setPreview(null)}
        title={preview?.fileName || '素材预览'}
      >
        {preview && (
          <div className="space-y-3">
            <div className="flex justify-center bg-surface rounded-lg p-3">
              {preview.type === 'video' ? (

                <video src={preview.url} controls className="max-w-full max-h-[60vh]" />
              ) : preview.type === 'audio' ? (
                <audio src={preview.url} controls className="w-full" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={preview.url} alt={preview.fileName || '素材'} className="max-w-full max-h-[60vh] object-contain" />
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <StatusTag tone={typeMeta[preview.type]?.tone}>{typeMeta[preview.type]?.label}</StatusTag>
                <Text className="text-xs text-text-secondary">{preview.url}</Text>
              </div>
              <MediaActionsBar
                url={preview.url}
                kind={preview.type}
                name={preview.fileName || '素材'}
                onClose={() => setPreview(null)}
              />
            </div>
          </div>
        )}
      </Modal>
    </PageContainer>
  )
}
