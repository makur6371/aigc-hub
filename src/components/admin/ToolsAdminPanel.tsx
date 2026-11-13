'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, Table, Button, Typography, App, Space, Segmented, Popconfirm, Input, InputNumber, Modal, Form, Switch, Select, Upload } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { CheckOutlined, CloseOutlined, CrownFilled, DeleteOutlined, EditOutlined, EyeOutlined, ThunderboltFilled, UploadOutlined, PictureOutlined, LoadingOutlined, CopyOutlined } from '@ant-design/icons'
import { StatusTag, type StatusTone } from '@/components/ui/StatusTag'
import { BrandTag } from '@/components/ui/BrandTag'
import { ALL_TOOL_CATEGORIES } from '@/lib/constants/categories'
import dayjs from 'dayjs'
import { apiFetch } from '@/lib/api-client'
import { toProxyUrl } from '@/lib/media-url'

const { Text } = Typography

/** 封面地址：站内直连，外链走 /api/cover 中转（服务端拉取 + 落盘缓存） */
// 收敛到 media-url：站内地址原样、外链走同源代理、防双重代理（唯一实现）
const coverSrc = toProxyUrl

type ToolItem = {
  id: string
  slug: string
  name: string
  description: string | null
  coverUrl: string | null
  category: string | null
  isOfficial: boolean
  status: string
  useCount: number
  likeCount: number
  createdAt: string
  author: { nickname: string | null; phone: string | null } | null
}

const statusMeta: Record<string, { text: string; tone: StatusTone }> = {
  PENDING: { text: '待审核', tone: 'warning' },
  APPROVED: { text: '已上架', tone: 'success' },
  REJECTED: { text: '已驳回', tone: 'danger' },
}

const PAGE_SIZE = 10

export function ToolsAdminPanel() {
  const { message, modal } = App.useApp()
  const [items, setItems] = useState<ToolItem[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState('all')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<ToolItem | null>(null)
  const [previewing, setPreviewing] = useState<ToolItem | null>(null)
  /** 编辑弹窗里的封面：本地预览 + 上传后的站内 URL（null = 无封面） */
  const [coverUrl, setCoverUrl] = useState<string | null>(null)
  const [coverUploading, setCoverUploading] = useState(false)
  /** 封面提示词弹窗：按工具自动推导的变量 + 完整提示词 */
  const [promptFor, setPromptFor] = useState<ToolItem | null>(null)
  const [promptLoading, setPromptLoading] = useState(false)
  const [promptText, setPromptText] = useState('')
  const [promptVars, setPromptVars] = useState<{
    input: string; workflow: string; output: string; coreValue: string; styleLabel: string
  } | null>(null)
  const [form] = Form.useForm()

  const fetchTools = useCallback(async (p: number, s: string, kw: string) => {
    setLoading(true)
    try {
      const res = await apiFetch<{ items: ToolItem[]; total: number }>('/api/admin/tools', {
        params: { page: String(p), pageSize: String(PAGE_SIZE), status: s !== 'all' ? s : undefined, q: kw || undefined },
      })
      if (res.success && res.data) { setItems(res.data.items); setTotal(res.data.total) }
      else message.error(res.message || '加载失败')
    } catch { message.error('网络错误') }
    finally { setLoading(false) }
  }, [message])

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchTools(1, status, q), 0)
    return () => window.clearTimeout(timer)
  }, [fetchTools, status, q])

  const review = (r: ToolItem, action: 'approve' | 'reject' | 'official') => {
    if (action === 'reject') {
      modal.confirm({
        title: `驳回「${r.name}」？`,
        content: '驳回后工具下架，作者可修改后重新提交。',
        okButtonProps: { danger: true },
        onOk: async () => {
          setBusy(r.id)
          try {
            const res = await apiFetch(`/api/admin/tools/${r.id}/review`, { method: 'POST', body: JSON.stringify({ action, points: 0 }) })
            if (res.success) { message.success(res.message); fetchTools(page, status, q) }
            else message.error(res.message || '操作失败')
          } finally { setBusy(null) }
        },
      })
      return
    }
    // 通过 / 封官方：弹窗手输奖励积分
    const max = action === 'official' ? 10000 : 1000
    let points = action === 'official' ? 100 : 20
    modal.confirm({
      title: action === 'official' ? `封为官方工具「${r.name}」` : `通过审核「${r.name}」`,
      content: (
        <div className="pt-2">
          <div className="mb-1.5 text-[13px] text-black/60">
            {action === 'official' ? '官方工具会出现在官方库并加官方标识，奖励作者积分（0~10000）：' : '审核通过并上架，奖励作者积分（0~1000）：'}
          </div>
          <InputNumber min={0} max={max} defaultValue={points} onChange={(v) => { points = Number(v || 0) }} className="!w-40" addonAfter="积分" />
        </div>
      ),
      okText: action === 'official' ? '封为官方' : '通过并发放',
      onOk: async () => {
        setBusy(r.id)
        try {
          const res = await apiFetch(`/api/admin/tools/${r.id}/review`, { method: 'POST', body: JSON.stringify({ action, points }) })
          if (res.success) { message.success(res.message); fetchTools(page, status, q) }
          else message.error(res.message || '操作失败')
        } finally { setBusy(null) }
      },
    })
  }

  const saveEdit = async () => {
    const v = await form.validateFields()
    if (!editing) return
    setBusy(editing.id)
    try {
      const res = await apiFetch(`/api/admin/tools/${editing.id}/review`, {
        method: 'PATCH',
        body: JSON.stringify({ ...v, coverUrl: coverUrl ?? '' }),
      })
      if (res.success) { message.success(res.message); setEditing(null); fetchTools(page, status, q) }
      else message.error(res.message || '保存失败')
    } finally { setBusy(null) }
  }

  // 上传工具封面（4:3 预览图）。先传到 /api/admin/tools/cover 换成站内 URL，
  // 再随「保存」一起写入工具记录 —— 这样取消编辑不会留下半截改动。
  const uploadCover = async (file: File) => {
    if (!file.type.startsWith('image/')) { message.error('请选择图片文件'); return }
    if (file.size > 2 * 1024 * 1024) { message.error('封面不能超过 2MB'); return }
    setCoverUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      // apiFetch 已支持 FormData（Q-810）
      const r = await apiFetch<{ url: string }>('/api/admin/tools/cover', { method: 'POST', body: fd })
      if (r.success && r.data?.url) {
        setCoverUrl(r.data.url)
        message.success('封面已上传，点「保存」生效')
      } else {
        message.error(r.message || '上传失败')
      }
    } catch {
      message.error('网络错误')
    } finally {
      setCoverUploading(false)
    }
  }

  const handleDelete = async (id: string) => {
    setBusy(id)
    try {
      const res = await apiFetch(`/api/admin/tools/${id}`, { method: 'DELETE' })
      if (res.success) {
        message.success(res.message)
        fetchTools(page, status, q)
      } else {
        message.error(res.message || '删除失败')
      }
    } catch {
      message.error('网络错误')
    } finally {
      setBusy(null)
    }
  }

  // 打开「封面提示词」弹窗：变量由后端按工具快照推导（INPUT / WORKFLOW / RESULT 自动填）
  const openCoverPrompt = async (r: ToolItem) => {
    setPromptFor(r)
    setPromptLoading(true)
    setPromptText('')
    setPromptVars(null)
    try {
      const res = await apiFetch<{
        prompt: string
        styleLabel: string
        vars: { input: string; workflow: string; output: string; coreValue: string }
      }>(`/api/admin/tools/${r.id}/cover-prompt`)
      if (res.success && res.data) {
        setPromptText(res.data.prompt)
        setPromptVars({ ...res.data.vars, styleLabel: res.data.styleLabel })
      } else {
        message.error(res.message || '生成失败')
      }
    } catch {
      message.error('网络错误')
    } finally {
      setPromptLoading(false)
    }
  }

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(promptText)
      message.success('提示词已复制，可直接粘贴到生图工具')
    } catch {
      message.error('复制失败，请手动全选复制')
    }
  }

  const columns: ColumnsType<ToolItem> = [
    {
      title: '工具', ellipsis: true,
      render: (_: unknown, r: ToolItem) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {r.isOfficial && <CrownFilled className="shrink-0 text-amber-400" />}
            <button type="button" className="cursor-pointer text-left text-sm font-medium text-accent hover:underline" onClick={() => setPreviewing(r)}>
              {r.name}
            </button>
          </div>
          <Text className="text-xs text-text-disabled" ellipsis>{r.description || r.slug}</Text>
        </div>
      ),
    },
    { title: '分类', dataIndex: 'category', width: 100, render: (c: string | null) => (c ? <BrandTag>{c}</BrandTag> : <Text type="secondary">—</Text>) },
    { title: '作者', width: 130, render: (_: unknown, r: ToolItem) => r.author?.nickname || r.author?.phone || '—' },
    {
      title: '状态', dataIndex: 'status', width: 90,
      render: (s: string) => { const m = statusMeta[s] || { text: s, tone: 'primary' as StatusTone }; return <StatusTag tone={m.tone}>{m.text}</StatusTag> },
    },
    { title: '使用', dataIndex: 'useCount', width: 70, align: 'right' },
    { title: '点赞', dataIndex: 'likeCount', width: 70, align: 'right' },
    { title: '创建时间', dataIndex: 'createdAt', width: 150, render: (d: string) => dayjs(d).format('YYYY-MM-DD HH:mm') },
    {
      title: '操作', width: 430,
      render: (_: unknown, r: ToolItem) => (
        <Space size={0}>
          {r.status === 'PENDING' && (
            <>
              <Button type="link" size="small" icon={<CheckOutlined />} loading={busy === r.id} onClick={() => review(r, 'approve')}>通过</Button>
              <Button type="link" size="small" danger icon={<CloseOutlined />} loading={busy === r.id} onClick={() => review(r, 'reject')}>驳回</Button>
            </>
          )}
          {r.status === 'APPROVED' && !r.isOfficial && (
            <Button type="link" size="small" icon={<CrownFilled />} loading={busy === r.id} onClick={() => review(r, 'official')}>封为官方</Button>
          )}
            <Button
              type="link" size="small" icon={<EditOutlined />}
              onClick={() => {
                setEditing(r)
                setCoverUrl(r.coverUrl)
                form.setFieldsValue({ name: r.name, description: r.description ?? '', category: r.category ?? '', status: r.status, isOfficial: r.isOfficial })
              }}
            >
            编辑
          </Button>
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => setPreviewing(r)}>预览</Button>
          <Button type="link" size="small" icon={<PictureOutlined />} onClick={() => void openCoverPrompt(r)}>封面提示词</Button>
          <Popconfirm
            title={r.status === 'APPROVED' ? '下架该工具？' : '上架该工具？'}
            onConfirm={async () => {
              setBusy(r.id)
              try {
                const res = await apiFetch(`/api/admin/tools/${r.id}/review`, { method: 'PATCH', body: JSON.stringify({ status: r.status === 'APPROVED' ? 'REJECTED' : 'APPROVED' }) })
                if (res.success) { message.success(res.message); fetchTools(page, status, q) }
                else message.error(res.message || '操作失败')
              } finally { setBusy(null) }
            }}
          >
            <Button type="link" size="small">{r.status === 'APPROVED' ? '下架' : '上架'}</Button>
          </Popconfirm>
          <Popconfirm
            title="确认删除该工具？"
            description="删除后工具和执行快照将不可恢复。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => handleDelete(r.id)}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />} loading={busy === r.id}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Card variant="outlined">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <Text strong>工具管理</Text>
        <Space>
          <Input.Search
            placeholder="搜工具名 / slug" allowClear className="!w-52"
            onSearch={(v) => { setQ(v); fetchTools(1, status, v) }}
          />
          <Segmented
            value={status}
            onChange={(v) => setStatus(String(v))}
            options={[
              { label: '全部', value: 'all' },
              { label: '待审核', value: 'PENDING' },
              { label: '已上架', value: 'APPROVED' },
              { label: '已驳回', value: 'REJECTED' },
            ]}
          />
        </Space>
      </div>
      <Table
        dataSource={items} columns={columns} rowKey="id" loading={loading} size="middle"
        scroll={{ x: 'max-content' }}
        pagination={{ current: page, pageSize: PAGE_SIZE, total, showSizeChanger: false, onChange: (p) => { setPage(p); fetchTools(p, status, q) } }}
      />
      <Modal
        title={previewing?.name}
        open={!!previewing}
        onCancel={() => setPreviewing(null)}
        footer={null}
        width={680}
        centered
        destroyOnHidden
      >
        {previewing && (
          <div className="space-y-4 pt-1">
            {/* 封面统一按 4:3 展示（与工具箱列表一致，避免同一张图两处比例不同） */}
            <div className="aspect-[4/3] w-full overflow-hidden rounded-xl bg-gradient-to-br from-accent/20 via-accent/10 to-accent-soft">
              {previewing.coverUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={coverSrc(previewing.coverUrl)} alt={previewing.name} className="size-full object-cover" />
              ) : (
                <div className="grid size-full place-items-center text-4xl font-medium text-accent/45">{previewing.name.slice(0, 2)}</div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><Text type="secondary" className="block text-xs">分类</Text>{previewing.category || '未分类'}</div>
              <div><Text type="secondary" className="block text-xs">状态</Text>{statusMeta[previewing.status]?.text || previewing.status}</div>
              <div><Text type="secondary" className="block text-xs">作者</Text>{previewing.author?.nickname || previewing.author?.phone || '未知'}</div>
              <div><Text type="secondary" className="block text-xs">数据</Text>使用 {previewing.useCount} · 点赞 {previewing.likeCount}</div>
            </div>
            <div>
              <Text type="secondary" className="block text-xs">描述</Text>
              <div className="mt-1 max-h-40 overflow-auto rounded-lg bg-surface p-3 text-sm leading-relaxed aigc-hub-scrollbar">
                {previewing.description || '暂无描述'}
              </div>
            </div>
          </div>
        )}
      </Modal>
      <Modal
        title={`编辑工具：${editing?.name ?? ''}`} open={!!editing} onOk={saveEdit} onCancel={() => { setEditing(null); setCoverUrl(null) }}
        confirmLoading={busy === editing?.id} okText="保存" cancelText="取消" destroyOnHidden
      >
        <Form form={form} layout="vertical" className="pt-2">
          {/* 工具封面：工具箱列表的预览图，4:3。上传后随「保存」写入。 */}
          <Form.Item label="工具封面（4:3 预览图）">
            <div className="flex items-start gap-3">
              <div className="relative aspect-[4/3] w-40 shrink-0 overflow-hidden rounded-xl border border-black/8 bg-black/[0.03]">
                {coverUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={coverSrc(coverUrl)} alt="封面预览" className="size-full object-cover" />
                ) : (
                  <div className="grid size-full place-items-center text-black/25">
                    <PictureOutlined className="text-2xl" />
                  </div>
                )}
                {coverUploading && (
                  <div className="absolute inset-0 grid place-items-center bg-white/70">
                    <LoadingOutlined className="text-accent" />
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <Upload
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  showUploadList={false}
                  beforeUpload={(file) => { void uploadCover(file as unknown as File); return false }}
                >
                  <Button size="small" icon={<UploadOutlined />} loading={coverUploading}>
                    {coverUrl ? '更换封面' : '上传封面'}
                  </Button>
                </Upload>
                {coverUrl && (
                  <Button size="small" type="text" danger onClick={() => setCoverUrl(null)}>移除封面</Button>
                )}
                <span className="text-[11px] leading-relaxed text-black/40">
                  建议 4:3、不超过 2MB。<br />工具箱列表会用它作为预览图。
                  <br />没有现成封面？用列表里的「封面提示词」自动生成一段。
                </span>
              </div>
            </div>
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '名称不能为空' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="category" label="分类">
            <Select
              allowClear placeholder="选择分类"
              // 用站内分类枚举，避免这里手写的列表和实际分类体系漂移
              // （旧列表里的「智能修图 / 其他」并不在枚举中，选了会存成无效分类）
              options={ALL_TOOL_CATEGORIES.map((c) => ({ value: c, label: c }))}
            />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select options={[{ value: 'PENDING', label: '待审核' }, { value: 'APPROVED', label: '已上架' }, { value: 'REJECTED', label: '已驳回' }]} />
          </Form.Item>
          <Form.Item name="isOfficial" label="官方标识" valuePropName="checked">
            <Switch checkedChildren={<ThunderboltFilled />} unCheckedChildren="否" />
          </Form.Item>
        </Form>
      </Modal>

      {/* ===== 封面提示词：变量按工具快照自动推导，复制即可丢给生图模型 ===== */}
      <Modal
        title={`封面提示词：${promptFor?.name ?? ''}`}
        open={!!promptFor}
        onCancel={() => { setPromptFor(null); setPromptText(''); setPromptVars(null) }}
        footer={null}
        width={760}
        centered
        destroyOnHidden
      >
        {promptLoading ? (
          <div className="grid place-items-center py-16 text-black/40">
            <LoadingOutlined className="mb-2 text-xl" />
            正在按工具结构推导…
          </div>
        ) : (
          <div className="space-y-3 pt-1">
            {promptVars && (
              <div className="grid grid-cols-1 gap-2 rounded-xl bg-surface p-3 text-[12px] sm:grid-cols-2">
                <div><Text type="secondary" className="block text-[11px]">视觉语言</Text>{promptVars.styleLabel}</div>
                <div><Text type="secondary" className="block text-[11px]">核心卖点</Text>{promptVars.coreValue}</div>
                <div className="sm:col-span-2"><Text type="secondary" className="block text-[11px]">输入</Text>{promptVars.input}</div>
                <div className="sm:col-span-2"><Text type="secondary" className="block text-[11px]">工作流</Text>{promptVars.workflow}</div>
                <div className="sm:col-span-2"><Text type="secondary" className="block text-[11px]">成果</Text>{promptVars.output}</div>
              </div>
            )}
            <Text type="secondary" className="block !text-[12px]">
              下面是完整提示词（已按工具自动填好变量）。复制后丢给生图模型，出图比例选 4:3。
              想微调措辞可直接在框里改，再复制。
            </Text>
            <Input.TextArea
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              autoSize={{ minRows: 12, maxRows: 20 }}
              className="!text-[12px]"
            />
            <div className="flex justify-end gap-2">
              <Button onClick={() => { setPromptFor(null); setPromptText(''); setPromptVars(null) }}>关闭</Button>
              <Button type="primary" icon={<CopyOutlined />} onClick={() => void copyPrompt()}>复制提示词</Button>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  )
}
