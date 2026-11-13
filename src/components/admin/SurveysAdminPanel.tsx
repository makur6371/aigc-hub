'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Card, Table, Button, Tag, Typography, App, Modal, Input, Select, Switch,
  Form, Space, Statistic, Row, Col, Descriptions, Popconfirm, Empty, Tooltip, InputNumber,
} from 'antd'
import {
  PlusOutlined, DownloadOutlined, EditOutlined, DeleteOutlined,
  FileTextOutlined, UserOutlined, TeamOutlined, GlobalOutlined, SendOutlined, GiftOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { apiFetch } from '@/lib/api-client'
import { PageState } from '@/components/ui/PageState'

const { Title, Text, Paragraph } = Typography

type SurveyQuestion = {
  id: string; section: string; title: string
  type: 'single' | 'multi' | 'text'
  options?: string[]; max?: number; required?: boolean
  showIf?: Record<string, string | string[]>
  placeholder?: string
}

type SurveyItem = {
  id: string; title: string; description: string | null
  audience: string; targetTeamId: string | null; isActive: boolean
  questionCount: number; responseCount: number
  rewardPoints: number; rewardGrantedAt: string | null
  createdAt: string; updatedAt: string
}

type TeamOption = { id: string; name: string; ownerName: string }

/**
 * 后台：AI 使用调研管理。
 *
 * 三个动作：
 *   1. 新建问卷 —— 默认问题树一键填充，可改标题/描述/发放范围（全站 or 指定企业）
 *   2. 上下线 —— isActive 控制用户端可见性
 *   3. 采集 —— 表格看回收量，CSV 一键导出（UTF-8 BOM，Excel 直接打开不乱码）
 */
export function SurveysAdminPanel() {
  const { message } = App.useApp()
  const [items, setItems] = useState<SurveyItem[]>([])
  const [summary, setSummary] = useState<{ userTotal: number; responseTotal: number } | null>(null)
  const [defaultQuestions, setDefaultQuestions] = useState<SurveyQuestion[]>([])
  const [teams, setTeams] = useState<TeamOption[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<SurveyItem | null>(null)
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)

  const pageSize = 10

  const fetchAll = useCallback(async (p: number) => {
    setLoading(true)
    try {
      const [res, teamsRes] = await Promise.all([
        apiFetch<{ items: SurveyItem[]; total: number; summary: { userTotal: number; responseTotal: number }; defaultQuestions: SurveyQuestion[] }>('/api/admin/surveys', { params: { page: String(p), pageSize: String(pageSize) } }),
        apiFetch<{ items: Array<{ id: string; name: string; owner: { name: string } }> }>('/api/admin/teams', { params: { page: '1', pageSize: '100', status: 'APPROVED' } }),
      ])
      if (res.success && res.data) {
        setItems(res.data.items); setTotal(res.data.total); setSummary(res.data.summary)
        setDefaultQuestions(res.data.defaultQuestions)
      }
      if (teamsRes.success && teamsRes.data) {
        setTeams(teamsRes.data.items.map((t) => ({ id: t.id, name: t.name, ownerName: t.owner?.name ?? '' })))
      }
    } catch { message.error('加载失败') } finally { setLoading(false) }
  }, [message])

  useEffect(() => { void fetchAll(page) }, [fetchAll, page])

  const openCreate = () => {
    setEditing(null)
    form.setFieldsValue({
      title: '企业人员 AI 使用情况调研',
      description: '约 5 分钟 · 按提示逐题往下走 · 数据仅用于内部改进',
      audience: 'ALL',
      questions: '',
    })
    setModalOpen(true)
  }

  const openEdit = async (item: SurveyItem) => {
    const res = await apiFetch<{ questions: SurveyQuestion[]; title: string; description: string | null; audience: string; targetTeamId: string | null }>(`/api/admin/surveys/${item.id}`)
    if (!res.success || !res.data) { message.error(res.message || '加载失败'); return }
    setEditing(item)
    form.setFieldsValue({ title: res.data.title, description: res.data.description, audience: res.data.audience, targetTeamId: res.data.targetTeamId, questions: res.data.questions })
    setModalOpen(true)
  }

  const handleSave = async () => {
    try {
      const values = await form.validateFields()
      setSaving(true)
      const payload = {
        title: values.title,
        description: values.description || null,
        audience: values.audience,
        targetTeamId: values.audience === 'TEAM' ? values.targetTeamId : null,
        // TextArea 留空 → 不传，让后端自动用默认模板；粘贴了 JSON → 原样传给后端解析
        questions: typeof values.questions === 'string' && values.questions.trim() === '' ? undefined : values.questions,
        rewardPoints: typeof values.rewardPoints === 'number' && values.rewardPoints > 0 ? values.rewardPoints : 0,
      }
      const res = editing
        ? await apiFetch(`/api/admin/surveys/${editing.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
        : await apiFetch('/api/admin/surveys', { method: 'POST', body: JSON.stringify(payload) })
      if (res.success) {
        message.success(editing ? '已更新' : '问卷已创建')
        setModalOpen(false); form.resetFields()
        void fetchAll(1)
      } else { message.error(res.message || '保存失败') }
    } catch { /* validation error */ } finally { setSaving(false) }
  }

  const toggleActive = async (item: SurveyItem) => {
    const res = await apiFetch(`/api/admin/surveys/${item.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !item.isActive }) })
    if (res.success) { message.success(item.isActive ? '已下线' : '已上线'); void fetchAll(page) }
    else message.error(res.message || '操作失败')
  }

  const remove = async (item: SurveyItem) => {
    const res = await apiFetch(`/api/admin/surveys/${item.id}`, { method: 'DELETE' })
    if (res.success) { message.success('已删除'); void fetchAll(page) }
    else message.error(res.message || '删除失败')
  }

  const exportCsv = (item: SurveyItem) => {
    window.open(`/api/admin/surveys/${item.id}?format=csv`, '_blank')
  }

  const grantReward = async (item: SurveyItem) => {
    try {
      const res = await apiFetch<{ granted: number; failed: number; pointsPerUser: number; total: number }>(`/api/admin/surveys/${item.id}/reward`, { method: 'POST' })
      if (res.success && res.data) {
        message.success(`已发放 ${res.data.granted} 人 × ${res.data.pointsPerUser} 积分 = 共 ${res.data.total} 积分${res.data.failed ? `（失败 ${res.data.failed} 人）` : ''}`)
        void fetchAll(page)
      } else { message.error(res.message || '发放失败') }
    } catch { message.error('网络异常') }
  }

  const columns: ColumnsType<SurveyItem> = [
    {
      title: '标题', dataIndex: 'title', ellipsis: true, width: 240,
      render: (t: string, r) => (
        <div>
          <Paragraph strong className="mb-0">{t}</Paragraph>
          <Text type="secondary" className="text-xs">{r.questionCount} 题</Text>
        </div>
      ),
    },
    {
      title: '发放范围', dataIndex: 'audience', width: 130,
      render: (a: string, r) => a === 'TEAM'
        ? <Tag icon={<TeamOutlined />} color="purple">指定企业</Tag>
        : <Tag icon={<GlobalOutlined />} color="blue">全站用户</Tag>,
    },
    {
      title: '回收', dataIndex: 'responseCount', width: 90, align: 'center',
      render: (n: number, r) => (
        <Statistic value={n} suffix={`/ ${r.audience === 'ALL' ? summary?.userTotal ?? '—' : '—'}`} valueStyle={{ fontSize: 14 }} />
      ),
    },
    {
      title: '状态', dataIndex: 'isActive', width: 130,
      render: (on: boolean, r) => (
        <div className="space-y-0.5">
          <div>{on ? <Tag color="green">进行中</Tag> : <Tag>已下线</Tag>}</div>
          {r.rewardPoints > 0 && (
            r.rewardGrantedAt
              ? <Tag icon={<GiftOutlined />} color="default">已发奖</Tag>
              : <Tag icon={<GiftOutlined />} color="gold">{r.rewardPoints} 分</Tag>
          )}
        </div>
      ),
    },
    { title: '创建时间', dataIndex: 'createdAt', width: 150, render: (d: string) => new Date(d).toLocaleString('zh-CN') },
    {
      title: '操作', width: 220,
      render: (_, r) => (
        <Space size={4}>
          <Tooltip title="预览题目"><Button size="small" icon={<FileTextOutlined />} onClick={() => setPreview(r.id)} /></Tooltip>
          <Tooltip title="编辑"><Button size="small" icon={<EditOutlined />} onClick={() => void openEdit(r)} /></Tooltip>
          <Button size="small" onClick={() => void toggleActive(r)}>{r.isActive ? '下线' : '上线'}</Button>
          <Tooltip title="导出 CSV"><Button size="small" icon={<DownloadOutlined />} onClick={() => exportCsv(r)} /></Tooltip>
          {r.rewardPoints > 0 && !r.rewardGrantedAt && (
            <Popconfirm title={`给 ${r.responseCount} 位已提交用户每人发 ${r.rewardPoints} 积分，确认？`} onConfirm={() => void grantReward(r)}>
              <Button size="small" type="primary" ghost icon={<GiftOutlined />}>发奖</Button>
            </Popconfirm>
          )}
          <Popconfirm title="删除后所有回答也会一起删除，确认？" onConfirm={() => void remove(r)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <Row gutter={16}>
        <Col span={8}><Card variant="outlined" size="small"><Statistic title="全站用户数" value={summary?.userTotal ?? 0} prefix={<UserOutlined />} /></Card></Col>
        <Col span={8}><Card variant="outlined" size="small"><Statistic title="累计问卷回收" value={summary?.responseTotal ?? 0} prefix={<SendOutlined />} /></Card></Col>
        <Col span={8}>
          <Card variant="outlined" size="small" className="flex items-center justify-center">
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建调研问卷</Button>
          </Card>
        </Col>
      </Row>

      <Card variant="outlined" title="问卷列表">
        <Table
          dataSource={items}
          columns={columns}
          rowKey="id"
          loading={loading}
          pagination={{ current: page, pageSize, total, onChange: (p) => setPage(p) }}
          size="middle"
          locale={{ emptyText: <Empty description="还没有问卷，点上方按钮创建" /> }}
        />
      </Card>

      {/* 新建/编辑弹窗 */}
      <Modal
        title={editing ? '编辑问卷' : '新建调研问卷'}
        open={modalOpen}
        onCancel={() => { setModalOpen(false); form.resetFields() }}
        onOk={handleSave}
        confirmLoading={saving}
        width={720}
        okText={editing ? '保存' : '创建'}
      >
        <Form form={form} layout="vertical" className="mt-2">
          <Form.Item name="title" label="标题" rules={[{ required: true }]}>
            <Input placeholder="问卷标题" />
          </Form.Item>
          <Form.Item name="description" label="说明（用户在列表看到的一句话）">
            <Input placeholder="如：约 5 分钟 · 匿名填写 · 帮助公司了解 AI 使用情况" />
          </Form.Item>
          <div className="grid grid-cols-2 gap-4">
            <Form.Item name="audience" label="发放范围" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'ALL', label: '全站用户' },
                  { value: 'TEAM', label: '指定企业团队' },
                ]}
              />
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(a, b) => a.audience !== b.audience}>
              {({ getFieldValue }) => getFieldValue('audience') === 'TEAM' ? (
                <Form.Item name="targetTeamId" label="目标企业" rules={[{ required: true, message: '请选择企业' }]}>
                  <Select
                    placeholder="选择已通过审核的企业"
                    options={teams.map((t) => ({ value: t.id, label: `${t.name}（${t.ownerName}）` }))}
                  />
                </Form.Item>
              ) : null}
            </Form.Item>
          </div>
          <Form.Item
            name="rewardPoints"
            label="答完奖励（积分/人，0 或留空 = 不发）"
            extra="创建后可随时点「发放奖励」给所有已提交的用户一次性发放。每人固定积分，流水类型为「奖励」。"
          >
            <InputNumber min={0} max={100000} style={{ width: 200 }} placeholder="如 100" />
          </Form.Item>
          <Form.Item
            name="questions"
            label="题目列表（JSON，留空 = 自动使用默认 43 题模板）"
            extra={'留空直接创建即可。要自定义时粘贴 JSON 数组，每项形如 {"id":"q1","title":"问题","type":"single","options":["选项A","选项B"]}；type 可选 single/multi/text，showIf 可做条件分支。'}
          >
            <Input.TextArea
              rows={10}
              placeholder="留空 = 使用默认模板"
              className="font-mono text-xs"
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 预览 */}
      <Modal
        title="题目预览"
        open={preview !== null}
        onCancel={() => setPreview(null)}
        footer={null}
        width={640}
      >
        {preview === null ? null : (
          <SurveyPreview surveyId={preview} />
        )}
      </Modal>
    </div>
  )
}

function SurveyPreview({ surveyId }: { surveyId: string }) {
  const [questions, setQuestions] = useState<SurveyQuestion[] | null>(null)
  useEffect(() => {
    let alive = true
    apiFetch<{ questions: SurveyQuestion[] }>(`/api/admin/surveys/${surveyId}`).then((res) => {
      if (alive && res.success && res.data) setQuestions(res.data.questions as SurveyQuestion[])
    })
    return () => { alive = false }
  }, [surveyId])

  if (!questions) return <PageState status="loading" description="加载中…" />
  if (questions.length === 0) return <Empty description="没有题目" />
  return (
    <div className="space-y-3 max-h-[60vh] overflow-y-auto">
      {questions.map((q, i) => (
        <div key={q.id} className="border-b border-gray-100 pb-2">
          <Text strong>{i + 1}. {q.title}</Text>
          <div className="mt-1">
            <Tag color={q.type === 'single' ? 'blue' : q.type === 'multi' ? 'purple' : 'orange'}>
              {q.type === 'single' ? '单选' : q.type === 'multi' ? '多选' : '填空'}
            </Tag>
            {q.required && <Tag color="red">必答</Tag>}
            {q.showIf && <Tag color="cyan">条件显示</Tag>}
            {q.options && <Text type="secondary" className="text-xs ml-2">{q.options.length} 个选项</Text>}
          </div>
        </div>
      ))}
    </div>
  )
}
