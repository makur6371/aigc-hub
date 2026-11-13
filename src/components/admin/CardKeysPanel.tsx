'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { App, Button, Card, DatePicker, Drawer, Form, Input, InputNumber, Modal, Pagination, Select, Table, Typography } from 'antd'
import { CopyOutlined, DownloadOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { apiFetch } from '@/lib/api-client'
import { formatPoints } from '@/lib/pricing'
import { StatusTag, type StatusTone } from '@/components/ui/StatusTag'

interface CardKeyItem {
  id: string
  code: string
  type: string
  pointsValue: number | null
  beansValue: number | null
  durationDays: number | null
  freeImageDays: number | null
  status: string
  usedByUserId: string | null
  usedBy?: { nickname: string | null; phone: string | null } | null
  usedAt: string | null
  expiresAt: string | null
  createdAt: string
}

interface GeneratorValues {
  type: string
  pointsValue?: number
  beansValue?: number
  durationDays?: number
  freeImageDays?: number
  count: number
  expiresAt?: dayjs.Dayjs
}

const typeOptions = [{ value: 'POINTS_PACKAGE', label: '积分卡' }, { value: 'BEANS_PACKAGE', label: '视频豆卡' }, { value: 'SUBSCRIPTION', label: '订阅卡' }]
const statusOptions = [{ value: 'UNUSED', label: '未使用' }, { value: 'USED', label: '已使用' }, { value: 'EXPIRED', label: '已过期' }]
const statusTones: Record<string, StatusTone> = { UNUSED: 'primary', USED: 'success', EXPIRED: 'warning' }

function benefitLabel(item: CardKeyItem) {
  if (item.type === 'POINTS_PACKAGE') return `${formatPoints(item.pointsValue)} 积分`
  if (item.type === 'BEANS_PACKAGE') return `${formatPoints(item.beansValue)} 视频豆`
  return [`订阅 ${item.durationDays} 天`, item.pointsValue ? `${formatPoints(item.pointsValue)} 积分` : '', item.beansValue ? `${formatPoints(item.beansValue)} 视频豆` : '', item.freeImageDays ? `生图时长 ${item.freeImageDays} 天` : ''].filter(Boolean).join(' · ')
}

export function CardKeysPanel() {
  const { message } = App.useApp()
  const [items, setItems] = useState<CardKeyItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [keyword, setKeyword] = useState('')
  const [query, setQuery] = useState('')
  const [type, setType] = useState<string>()
  const [status, setStatus] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generatorOpen, setGeneratorOpen] = useState(false)
  const [generated, setGenerated] = useState<string[]>([])
  const [resultOpen, setResultOpen] = useState(false)
  const [selection, setSelection] = useState<CardKeyItem[]>([])
  const latestRequest = useRef(0)
  const [form] = Form.useForm<GeneratorValues>()
  const values = Form.useWatch([], form)
  const cardType = values?.type ?? 'POINTS_PACKAGE'

  const load = useCallback(async () => {
    const requestId = ++latestRequest.current
    setLoading(true)
    const response = await apiFetch<{ items: CardKeyItem[]; total: number }>('/api/admin/card-keys', { params: { page, pageSize, keyword: query || undefined, type, status } })
    if (requestId !== latestRequest.current) return
    if (response.success && response.data) {
      setItems(response.data.items)
      setTotal(response.data.total)
      setSelection([])
    } else message.error(response.message || '卡密加载失败')
    setLoading(false)
  }, [page, pageSize, query, type, status, message])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => { window.clearTimeout(timer); latestRequest.current += 1 }
  }, [load])

  const copyCodes = async (codes: string[]) => {
    try { await navigator.clipboard.writeText(codes.join('\n')); message.success(`已复制 ${codes.length} 张卡密`) }
    catch { message.error('复制失败，请从卡密文本中手动复制') }
  }

  const exportCodes = (codes: string[]) => {
    const downloadUrl = URL.createObjectURL(new Blob(['\uFEFFCode\n' + codes.join('\n')], { type: 'text/csv;charset=utf-8;' }))
    const anchor = document.createElement('a')
    anchor.href = downloadUrl
    anchor.download = `card-keys-${dayjs().format('YYYYMMDD-HHmmss')}.csv`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000)
  }

  const generate = async (input: GeneratorValues) => {
    setGenerating(true)
    try {
      const response = await apiFetch<{ codes: string[] }>('/api/admin/card-keys', { method: 'POST', body: JSON.stringify({ ...input, expiresAt: input.expiresAt?.toISOString() ?? null }) })
      if (!response.success || !response.data) { message.error(response.message || '生成失败'); return }
      setGenerated(response.data.codes)
      setGeneratorOpen(false)
      setResultOpen(true)
      form.resetFields()
      setPage(1)
      setKeyword('')
      setQuery('')
      setType(undefined)
      setStatus(undefined)
      if (page === 1 && !query && !type && !status) void load()
    } finally { setGenerating(false) }
  }

  const columns: ColumnsType<CardKeyItem> = [
    { title: '卡密', dataIndex: 'code', width: 270, render: (code: string, item) => <div><Typography.Text code copyable={{ text: code }}>{code}</Typography.Text><div className="mt-1 text-xs text-text-secondary">{typeOptions.find((option) => option.value === item.type)?.label}</div></div> },
    { title: '兑换权益', width: 210, render: (_, item) => <span className="text-xs leading-relaxed">{benefitLabel(item)}</span> },
    { title: '状态', dataIndex: 'status', width: 95, render: (value: string) => <StatusTag tone={statusTones[value] ?? 'primary'}>{statusOptions.find((option) => option.value === value)?.label ?? value}</StatusTag> },
    { title: '兑换人', width: 160, render: (_, item) => <div className="text-xs"><div>{item.usedBy?.nickname || item.usedBy?.phone || item.usedByUserId || '尚未兑换'}</div>{item.usedAt && <div className="mt-1 text-text-secondary">{dayjs(item.usedAt).format('MM-DD HH:mm')}</div>}</div> },
    { title: '兑换截止', dataIndex: 'expiresAt', width: 150, render: (value: string | null) => <span className="text-xs">{value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '不限时间'}</span> },
    { title: '创建时间', dataIndex: 'createdAt', width: 145, render: (value: string) => <span className="text-xs text-text-secondary">{dayjs(value).format('YYYY-MM-DD HH:mm')}</span> },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[24px] border border-accent/10 bg-white/80 p-5">
        <div><h2 className="text-lg font-semibold text-foreground">卡密管理</h2><p className="mt-1 text-xs text-text-muted">共匹配 {total} 张 · 先选类型和权益，再批量生成。</p></div>
        <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setGeneratorOpen(true) }}>生成卡密</Button>
      </div>
      <Card variant="outlined">
        <div className="grid gap-3 md:grid-cols-[minmax(180px,1fr)_140px_140px_auto]">
          <Input.Search aria-label="搜索卡密或兑换人" placeholder="搜索卡密、兑换人昵称或手机号" value={keyword} allowClear onChange={(event) => setKeyword(event.target.value)} onSearch={(value) => { setPage(1); setQuery(value.trim()); if (page === 1 && value.trim() === query) void load() }} />
          <Select aria-label="卡密类型" placeholder="全部类型" allowClear options={typeOptions} value={type} onChange={(value) => { setPage(1); setType(value) }} />
          <Select aria-label="卡密状态" placeholder="全部状态" allowClear options={statusOptions} value={status} onChange={(value) => { setPage(1); setStatus(value) }} />
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
        </div>
        {selection.length > 0 && <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl bg-accent-light p-3"><span className="mr-auto text-xs text-accent">已选 {selection.length} 张</span><Button size="small" icon={<CopyOutlined />} onClick={() => void copyCodes(selection.map((item) => item.code))}>复制所选</Button><Button size="small" icon={<DownloadOutlined />} onClick={() => exportCodes(selection.map((item) => item.code))}>导出所选</Button></div>}
        <Table className="mt-4 hidden md:block" rowKey="id" loading={loading} dataSource={items} columns={columns} scroll={{ x: 1050 }} rowSelection={{ selectedRowKeys: selection.map((item) => item.id), onChange: (_, rows) => setSelection(rows) }} pagination={{ current: page, pageSize, total, showSizeChanger: true, showTotal: (count) => `共 ${count} 张`, onChange: (next, size) => { setPage(next); setPageSize(size) } }} />
        <div className="mt-4 space-y-3 md:hidden">
          {items.map((item) => <div key={item.id} className="rounded-2xl border border-border p-4"><div className="flex items-center justify-between gap-2"><span className="text-xs font-medium">{typeOptions.find((option) => option.value === item.type)?.label}</span><StatusTag tone={statusTones[item.status] ?? 'primary'}>{statusOptions.find((option) => option.value === item.status)?.label}</StatusTag></div><p className="my-3 break-all font-mono text-xs text-accent">{item.code}</p><p className="text-xs leading-relaxed text-text-muted">{benefitLabel(item)}</p><p className="mt-2 text-xs text-text-secondary">{item.usedBy?.nickname || item.usedBy?.phone || item.usedByUserId || '尚未兑换'} · {item.expiresAt ? `${dayjs(item.expiresAt).format('YYYY-MM-DD')} 截止` : '兑换不限时'}</p><Button className="mt-3" size="small" icon={<CopyOutlined />} onClick={() => void copyCodes([item.code])}>复制卡密</Button></div>)}
          {!loading && items.length === 0 && <p className="py-8 text-center text-sm text-text-secondary">没有匹配的卡密，换个筛选试试。</p>}
          <Pagination simple current={page} total={total} pageSize={pageSize} onChange={setPage} />
        </div>
      </Card>
      <Drawer title="生成卡密" width="min(520px, 100vw)" open={generatorOpen} onClose={() => { if (!generating) setGeneratorOpen(false) }} footer={<div className="flex justify-end gap-2"><Button disabled={generating} onClick={() => setGeneratorOpen(false)}>取消</Button><Button type="primary" loading={generating} onClick={() => form.submit()}>生成 {values?.count ?? 10} 张卡密</Button></div>}>
        <Form form={form} layout="vertical" initialValues={{ type: 'POINTS_PACKAGE', count: 10, durationDays: 30 }} onFinish={generate}>
          <Form.Item name="type" label="卡密类型" rules={[{ required: true }]}><Select size="large" options={typeOptions} /></Form.Item>
          {cardType === 'SUBSCRIPTION' && <Form.Item name="durationDays" label="订阅有效期（天）" rules={[{ required: true }]}><InputNumber className="!w-full" min={1} max={3650} precision={0} /></Form.Item>}
          {cardType !== 'BEANS_PACKAGE' && <Form.Item name="pointsValue" label={cardType === 'SUBSCRIPTION' ? '赠送积分' : '每张卡的积分'} preserve={false} rules={[{ required: cardType === 'POINTS_PACKAGE', message: '请输入积分面值' }]}><InputNumber className="!w-full" min={cardType === 'POINTS_PACKAGE' ? 1 : 0} max={100000} precision={2} placeholder="填写积分数量" /></Form.Item>}
          {cardType !== 'POINTS_PACKAGE' && <Form.Item name="beansValue" label={cardType === 'SUBSCRIPTION' ? '赠送视频豆' : '每张卡的视频豆'} preserve={false} rules={[{ required: cardType === 'BEANS_PACKAGE', message: '请输入视频豆面值' }]}><InputNumber className="!w-full" min={cardType === 'BEANS_PACKAGE' ? 1 : 0} max={100000} precision={2} placeholder="填写视频豆数量" /></Form.Item>}
          {cardType === 'SUBSCRIPTION' && <Form.Item name="freeImageDays" label="赠送生图时长（天）" preserve={false} extra="仅指定免费模型适用，与订阅有效期分开计算。"><InputNumber className="!w-full" min={0} max={3650} precision={0} placeholder="例如 3、5、10 天" /></Form.Item>}
          <div className="grid gap-x-4 sm:grid-cols-2"><Form.Item name="count" label="生成数量" rules={[{ required: true }]}><InputNumber min={1} max={1000} precision={0} className="!w-full" /></Form.Item><Form.Item name="expiresAt" label="兑换截止时间" extra="留空表示不限兑换时间。"><DatePicker showTime className="w-full" /></Form.Item></div>
          <div className="rounded-2xl bg-accent-light p-4 text-xs leading-relaxed text-text-muted"><strong className="text-accent">发放前核对一下</strong><p className="mt-2">{typeOptions.find((option) => option.value === cardType)?.label} · {values?.count ?? 10} 张</p><p>每张{cardType === 'SUBSCRIPTION' ? `含 ${values?.durationDays ?? 30} 天订阅，` : '含 '}{cardType !== 'BEANS_PACKAGE' ? `${formatPoints(values?.pointsValue)} 积分` : ''}{cardType !== 'POINTS_PACKAGE' ? ` ${formatPoints(values?.beansValue)} 视频豆` : ''}{cardType === 'SUBSCRIPTION' && values?.freeImageDays ? `，另送 ${values.freeImageDays} 天生图时长` : ''}。</p></div>
        </Form>
      </Drawer>
      <Modal title={`已生成 ${generated.length} 张卡密`} open={resultOpen} onCancel={() => setResultOpen(false)} width={600} footer={<div className="flex flex-wrap justify-end gap-2"><Button icon={<CopyOutlined />} onClick={() => void copyCodes(generated)}>全部复制</Button><Button icon={<DownloadOutlined />} onClick={() => exportCodes(generated)}>导出 CSV</Button><Button type="primary" onClick={() => setResultOpen(false)}>完成</Button></div>}>
        <p className="mb-3 text-sm text-text-muted">复制或导出后再发给用户，卡密可在个人中心兑换。</p><Input.TextArea aria-label="本批生成的卡密" readOnly value={generated.join('\n')} autoSize={{ minRows: 6, maxRows: 14 }} className="font-mono" />
      </Modal>
    </div>
  )
}
