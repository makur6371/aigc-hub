'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Card, Button, Tag, Typography, App, Progress, Checkbox, Radio, Input, Space } from 'antd'
import {
  LeftOutlined, RightOutlined, CheckCircleFilled, FileTextOutlined,
  SendOutlined, ReloadOutlined, CheckSquareOutlined,
} from '@ant-design/icons'
import { apiFetch } from '@/lib/api-client'
import { PageState } from '@/components/ui/PageState'

const { Title, Text, Paragraph } = Typography

type SurveyQuestion = {
  id: string
  section: string
  title: string
  type: 'single' | 'multi' | 'text'
  options?: string[]
  max?: number
  required?: boolean
  showIf?: Record<string, string | string[]>
  placeholder?: string
}

type SurveyItem = {
  id: string
  title: string
  description: string | null
  questionCount: number
  submittedAt: string | null
  answeredCount: number
  questions?: SurveyQuestion[]
}

/**
 * 用户端问卷流程：
 *   1. 列表页 —— 我可见的活跃问卷 + 已提交状态
 *   2. 答题页 —— 逐题往下走（树形 showIf 分支），底部上一题/下一题
 *   3. 完成页 —— 感谢 + 回看入口
 *
 * 「树形」不是 UI 上的树，而是**题目按依赖决定是否出现**：
 * showIf { q1: '用过' } → 只有父题答了「用过」本题才进队列。
 * 这样问卷对不同人长度不同：没用 Agent 的人 8 题答完，重度用户 40+ 题。
 */
export function UserSurveyFlow() {
  const { message } = App.useApp()
  const [items, setItems] = useState<SurveyItem[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [active, setActive] = useState<{ id: string; questions: SurveyQuestion[] } | null>(null)
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({})
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  const fetchList = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch<{ items: SurveyItem[] }>('/api/user/survey')
      if (res.success && res.data) setItems(res.data.items)
      else message.error(res.message || '加载失败')
    } catch { message.error('网络异常') } finally { setLoading(false) }
  }, [message])

  useEffect(() => { void fetchList() }, [fetchList])

  const openSurvey = (item: SurveyItem) => {
    if (!item.questions || item.questions.length === 0) { message.error('问卷题目为空'); return }
    setActive({ id: item.id, questions: item.questions })
    setStep(0)
    setAnswers({})
  }

  /** 当前答题页应该显示的题目序列（过滤掉 showIf 不满足的） */
  const visibleQuestions = useMemo(() => {
    if (!active) return []
    return active.questions.filter((q) => {
      if (!q.showIf) return true
      return Object.entries(q.showIf).every(([pid, expect]) => {
        const a = answers[pid]
        if (a === undefined) return false
        return Array.isArray(expect) ? expect.includes(a as string) : a === expect
      })
    })
  }, [active, answers])

  const current = visibleQuestions[step]
  const totalSteps = visibleQuestions.length

  const submit = async () => {
    if (!active) return
    setSubmitting(true)
    try {
      const res = await apiFetch('/api/user/survey', {
        method: 'POST',
        body: JSON.stringify({ templateId: active.id, answers }),
      })
      if (res.success) { setDone(true); setActive(null) }
      else message.error(res.message || '提交失败')
    } catch { message.error('网络异常') } finally { setSubmitting(false) }
  }

  // ---------- 完成页 ----------
  if (done) {
    return (
      <Card variant="outlined" className="text-center py-12">
        <CheckCircleFilled className="text-5xl text-emerald-500 mb-4" />
        <Title level={4}>提交成功，感谢参与！</Title>
        <Paragraph type="secondary">你的回答将帮助公司更好地了解团队的 AI 使用情况。</Paragraph>
        <Button icon={<ReloadOutlined />} onClick={() => { setDone(false); void fetchList() }}>
          返回问卷列表
        </Button>
      </Card>
    )
  }

  // ---------- 答题页 ----------
  if (active) {
    const q = current
    const isLast = step === totalSteps - 1
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-center gap-3">
          <Text strong>{active.id && ''}</Text>
          <Progress percent={Math.round(((step + 1) / totalSteps) * 100)} size="small" />
        </div>
        {q && (
          <Card variant="outlined" className="shadow-sm">
            <div className="mb-1"><Tag color="purple">{q.section}</Tag></div>
            <Paragraph strong className="text-base mb-1">{q.title}{q.required && <span className="text-red-500"> *</span>}</Paragraph>
            <Text type="secondary" className="text-xs">
              {q.type === 'single' ? '请选择一个选项' : q.type === 'multi' ? `可多选${q.max ? `，最多 ${q.max} 个` : ''}` : '直接输入即可'}
            </Text>
            <div className="mt-4">
              {q.type === 'single' && (
                <Radio.Group
                  value={answers[q.id] as string}
                  onChange={(e) => setAnswers((s) => ({ ...s, [q.id]: e.target.value }))}
                  className="flex flex-col gap-2"
                >
                  {(q.options ?? []).map((o) => (
                    <Radio key={o} value={o} className="whitespace-normal">{o}</Radio>
                  ))}
                </Radio.Group>
              )}
              {q.type === 'multi' && (
                <Checkbox.Group
                  value={(answers[q.id] as string[]) ?? []}
                  onChange={(vals) => {
                    let next = vals as string[]
                    if (q.max && next.length > q.max) next = next.slice(-q.max)
                    setAnswers((s) => ({ ...s, [q.id]: next }))
                  }}
                  className="flex flex-col gap-2"
                >
                  {(q.options ?? []).map((o) => (
                    <Checkbox key={o} value={o} className="whitespace-normal">{o}</Checkbox>
                  ))}
                </Checkbox.Group>
              )}
              {q.type === 'text' && (
                <Input.TextArea
                  rows={4}
                  placeholder={q.placeholder || '请输入…'}
                  value={(answers[q.id] as string) ?? ''}
                  onChange={(e) => setAnswers((s) => ({ ...s, [q.id]: e.target.value }))}
                />
              )}
            </div>
          </Card>
        )}
        <div className="flex justify-between">
          <Button icon={<LeftOutlined />} disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>上一题</Button>
          {isLast ? (
            <Button type="primary" icon={<SendOutlined />} loading={submitting} onClick={submit}>提交问卷</Button>
          ) : (
            <Button type="primary" disabled={!q || answers[q.id] === undefined} icon={<RightOutlined />} iconPosition="end" onClick={() => setStep((s) => Math.min(totalSteps - 1, s + 1))}>下一题</Button>
          )}
        </div>
      </div>
    )
  }

  // ---------- 列表页 ----------
  return (
    <div className="space-y-4">
      <Title level={4} className="mb-0"><FileTextOutlined className="mr-2" />AI 使用调研</Title>
      {loading ? (
        <PageState status="loading" />
      ) : !items || items.length === 0 ? (
        <PageState status="empty" description="暂无进行中的问卷" />
      ) : (
        items.map((s) => (
          <Card
            key={s.id}
            variant="outlined"
            hoverable
            className="cursor-pointer"
            onClick={() => openSurvey(s)}
          >
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <Paragraph strong className="mb-0 truncate">{s.title}</Paragraph>
                {s.description && <Text type="secondary" className="text-xs">{s.description}</Text>}
                <div className="mt-1 flex items-center gap-2 text-xs text-gray-400">
                  <CheckSquareOutlined /> {s.questionCount} 题 · 约 5 分钟
                </div>
              </div>
              <div className="shrink-0">
                {s.submittedAt ? <Tag color="green">已提交</Tag> : <Button size="small" type="primary">去填写</Button>}
              </div>
            </div>
          </Card>
        ))
      )}
    </div>
  )
}
