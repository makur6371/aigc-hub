'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Card,
  Pagination,
  Typography,
  App,
  Button,
  Tooltip,
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
import { apiFetch } from '@/lib/api-client'
import { SoundOutlined, PlayCircleOutlined, CopyOutlined, CheckOutlined, ReloadOutlined, DeleteOutlined, ClearOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'

const { Title, Text } = Typography

const PAGE_SIZE = 12

type AudioModel = {
  id: string
  name: string
  modelName: string
  type: string
}

type AudioRecord = {
  id: string
  prompt: string
  audioUrl: string | null
  costPoints: number
  status: string
  errorMessage: string | null
  createdAt: string
  /** 是否已失效（后端算好） */
  expired?: boolean
  model: AudioModel
}

type PaginatedResponse = {
  items: AudioRecord[]
  total: number
}

export default function UserAudiosPage() {
  const { message } = App.useApp()
  const [records, setRecords] = useState<AudioRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<'all' | 'valid' | 'expired'>('all')
  const [selected, setSelected] = useState<string[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [pollingIds, setPollingIds] = useState<Set<string>>(new Set())

  const fetchRecords = useCallback(
    async (currentPage: number, f: 'all' | 'valid' | 'expired') => {
      setLoading(true)
      try {
        const res = await apiFetch<PaginatedResponse>('/api/user/audios', {
          params: { page: currentPage, pageSize: PAGE_SIZE, ...(f !== 'all' ? { filter: f } : {}) },
        })
        if (res.success && res.data) {
          setRecords(res.data.items)
          setTotal(res.data.total)
          setSelected([])
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

  const handleDeleteSelected = async () => {
    if (selected.length === 0) return
    try {
      const res = await apiFetch<{ deleted: number }>('/api/user/audios', {
        method: 'DELETE', body: JSON.stringify({ ids: selected }),
      })
      if (res.success) { message.success(res.message || '已删除'); setSelected([]); void fetchRecords(page, filter) }
      else message.error(res.message || '删除失败')
    } catch { message.error('删除失败') }
  }

  const handlePurgeExpired = async () => {
    try {
      const res = await apiFetch<{ deleted: number }>('/api/user/audios', { method: 'POST' })
      if (res.success) { message.success(res.message || '已清理'); setSelected([]); void fetchRecords(1, filter) }
      else message.error(res.message || '清理失败')
    } catch { message.error('清理失败') }
  }

  const handlePoll = async (record: AudioRecord) => {
    if (pollingIds.has(record.id)) return
    setPollingIds((prev) => new Set(prev).add(record.id))
    try {
      const res = await apiFetch<{ status: string; error?: string }>(`/api/audio/status/${record.id}`)
      if (res.success && res.data) {
        if (res.data.status === 'SUCCESS') {
          message.success('音频已生成')
          fetchRecords(page, filter)
        } else if (res.data.status === 'FAILED') {
          message.error(res.data.error || '音频生成失败，积分已退回')
          fetchRecords(page, filter)
        } else {
          message.info('任务处理中，请稍后再试')
        }
      }
    } catch {
      message.error('查询失败')
    } finally {
      setPollingIds((prev) => {
        const next = new Set(prev)
        next.delete(record.id)
        return next
      })
    }
  }

  const handleCopy = async (record: AudioRecord) => {
    if (!record.audioUrl) return
    try {
      await navigator.clipboard.writeText(record.audioUrl)
      setCopiedId(record.id)
      setTimeout(() => setCopiedId(null), 2000)
    } catch { /* ignore */ }
  }

  const statusTag = (status: string) => {
    if (status === 'SUCCESS') return <StatusTag tone="success">成功</StatusTag>
    if (status === 'FAILED') return <StatusTag tone="danger">失败</StatusTag>
    return <StatusTag tone="warning">生成中</StatusTag>
  }

  return (
    <PageContainer>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Title level={4} className="mb-0">
            <SoundOutlined className="mr-2 text-accent" />
            我的音频
          </Title>
          <Space wrap>
            <Segmented value={filter} onChange={(v) => { setFilter(v as 'all' | 'valid' | 'expired'); setPage(1) }}
              options={[{ label: '全部', value: 'all' }, { label: '有效', value: 'valid' }, { label: '已失效', value: 'expired' }]} />
            {selected.length > 0 && (
              <Popconfirm title={`删除选中的 ${selected.length} 条记录？`} onConfirm={handleDeleteSelected} okText="删除" cancelText="取消">
                <Button danger icon={<DeleteOutlined />}>删除选中（{selected.length}）</Button>
              </Popconfirm>
            )}
            <Popconfirm title="清理全部已失效记录？" onConfirm={handlePurgeExpired} okText="清理" cancelText="取消">
              <Button icon={<ClearOutlined />}>清理失效</Button>
            </Popconfirm>
          </Space>
        </div>

        {loading && records.length === 0 ? (
          <MediaGridSkeleton />
        ) : records.length === 0 ? (
          <PageState status="empty" description="暂无音频记录，去对话或画布生成音频吧" minHeight="280px" />
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {records.map((record) => (
                <Card key={record.id} variant="outlined" hoverable className="overflow-hidden">
                  <div className="relative w-full bg-surface-hover px-3 py-4">
                    <div className="absolute left-2 top-2 z-10">
                      <Checkbox checked={selected.includes(record.id)}
                        onChange={(e) => setSelected((prev) => e.target.checked ? [...prev, record.id] : prev.filter((x) => x !== record.id))} />
                    </div>
                    {record.status === 'SUCCESS' && record.audioUrl && !record.expired ? (
                      <audio src={record.audioUrl} controls className="w-full" />
                    ) : record.status === 'FAILED' ? (
                      <div className="py-6 flex items-center justify-center bg-danger/10">
                        <Text className="text-xs text-danger px-3 text-center">{record.errorMessage || '生成失败'}</Text>
                      </div>
                    ) : (
                      <div className="py-6 flex flex-col items-center justify-center gap-2 bg-warning-bg">
                        <PlayCircleOutlined className="text-3xl text-warning" />
                        <Text className="text-xs text-warning">生成中…</Text>
                        <Button size="small" icon={<ReloadOutlined />} onClick={() => handlePoll(record)} loading={pollingIds.has(record.id)}>
                          刷新状态
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="p-4 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      {statusTag(record.status)}
                      <BrandTag>{record.model?.name || '未知模型'}</BrandTag>
                      <StatusTag tone="gold">{record.costPoints > 0 ? `-${record.costPoints} 积分` : ''}</StatusTag>
                    </div>
                    <Text ellipsis={{ tooltip: record.prompt }} className="block text-sm font-medium text-foreground">
                      {record.prompt}
                    </Text>
                    <div className="flex items-center justify-between">
                      <Text className="text-xs text-text-secondary">
                        {dayjs(record.createdAt).format('YYYY-MM-DD HH:mm')}
                      </Text>
                      {record.status === 'SUCCESS' && record.audioUrl && (
                        <Tooltip title="复制音频地址">
                          <Button
                            type="text"
                            size="small"
                            icon={copiedId === record.id ? <CheckOutlined className="text-success" /> : <CopyOutlined />}
                            onClick={() => handleCopy(record)}
                          />
                        </Tooltip>
                      )}
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
                onChange={handlePageChange}
              />
            </div>
          </>
        )}
      </div>
    </PageContainer>
  )
}
