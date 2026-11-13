'use client'

// 发布工具向导（设计文档 §8）：四步装配清单
// ① 装配清单 → ② 重复动作确认（识别引擎的建议：变体组/多图上传，确认才生效）→ ③ 作者逐项确认/改名 → ④ 起名+领域标签 → 提交
import { useMemo, useState } from 'react'
import { Modal, Steps, Button, Input, Switch, Segmented, App as AntApp, Typography, Alert, Progress } from 'antd'
import {
  ThunderboltFilled, PictureOutlined, FontSizeOutlined, BgColorsOutlined,
  RobotOutlined, ExpandAltOutlined, EyeOutlined, CheckCircleFilled, QuestionCircleOutlined,
  WarningOutlined, CloseCircleOutlined,
} from '@ant-design/icons'
import { analyzeToolSlots, type ToolSlot, type SlotSuggestion } from '@/lib/tool-slots'
import { BASE_TOOL_CATEGORIES, VERTICAL_CATEGORIES } from '@/lib/constants/categories'
import { apiFetch } from '@/lib/api-client'

const { Text } = Typography

export interface PublishToolWizardProps {
  open: boolean
  onCancel: () => void
  onSuccess: (slug: string) => void
  /** 画布快照 */
  nodes: Array<Record<string, unknown>>
  connections: Array<Record<string, unknown>>
  /** 默认封面（最后产出的图） */
  coverUrl?: string
  /** remix 来源工具 id */
  forkedFrom?: string
}

const SLOT_ICON: Record<string, React.ReactNode> = {
  upload: <PictureOutlined />,
  text: <FontSizeOutlined />,
  choice: <BgColorsOutlined />,
  model: <RobotOutlined />,
  ratio: <ExpandAltOutlined />,
  number: <ThunderboltFilled />,
  result: <EyeOutlined />,
}

const SLOT_DESC: Record<string, string> = {
  upload: '使用者要上传素材（图片/音频）',
  text: '使用者要输入一段文字',
  choice: '使用者可选风格，每个风格各出一批结果',
  model: '使用者可换这一步用的模型',
  ratio: '使用者可选画面比例和清晰度',
  number: '使用者可让这一步多跑几次',
  result: '所有产出会集中展示在结果区',
}

export function PublishToolWizard({ open, onCancel, onSuccess, nodes, connections, coverUrl, forkedFrom }: PublishToolWizardProps) {
  const { message } = AntApp.useApp()
  const [step, setStep] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('电商商拍')
  // 作者微调：label 改名 + hidden（hidden 用局部 state 覆盖）
  const [overrides, setOverrides] = useState<Record<string, { label?: string; hidden?: boolean }>>({})
  // 引擎直接确认的 choice 组：作者在确认步可切单选/多选（undefined=引擎默认）
  const [singleChoices, setSingleChoices] = useState<Record<string, 'single' | 'multi'>>({})
  // 选择组内每个选项的改名（如把节点标题改成「第1格/第2格」，与官方九宫格工具一致）
  const [optionLabels, setOptionLabels] = useState<Record<string, Record<string, string>>>({})
  // 重复动作确认：每个 suggestion 的处置（不处理=丢弃；choice 可选单选/多选）
  const [suggChoices, setSuggChoices] = useState<Record<string, 'reject' | 'single' | 'multi'>>({})
  // 每次打开重新识别
  const analyzed = useMemo(() => {
    if (!open) return { slots: [] as ToolSlot[], variantNodeIds: [] as string[], suggestions: [] as SlotSuggestion[], validationIssues: [], confidence: 0 }
    try {
      return analyzeToolSlots(nodes as never, connections as never)
    } catch {
      return { slots: [], variantNodeIds: [], suggestions: [], validationIssues: [], confidence: 0 }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 建议 slot 经作者确认后并入（单选/多选映射）
  const confirmedSuggestions: ToolSlot[] = useMemo(() => (analyzed.suggestions ?? []).flatMap((sg): ToolSlot[] => {
    const mode = suggChoices[sg.slot.id] ?? 'reject'
    if (mode === 'reject') return []
    return [{ ...sg.slot, status: 'confirmed' as const, single: mode === 'single' }]
  }), [analyzed.suggestions, suggChoices])

  const slots: ToolSlot[] = useMemo(
    () => [...analyzed.slots.filter((s) => s.type !== 'result' || analyzed.slots.length > 0), ...confirmedSuggestions],
    [analyzed.slots, confirmedSuggestions],
  )
  const visibleSlots = slots.filter((s) => !overrides[s.id]?.hidden)

  // 分类两组：基础工具（单能力）+ 垂直领域（业务场景）
  const baseCategories = [...BASE_TOOL_CATEGORIES]
  const vertCategories = [...VERTICAL_CATEGORIES]

  const submit = async () => {
    if (!name.trim()) { message.warning('请给工具起个名字'); return }
    if (visibleSlots.length === 0) { message.warning('画布里没有可复用的控件，先搭一个上传/生成流程'); return }
    setSubmitting(true)
    try {
      // 新协议：回传完整 slots（含确认后建议 slot 的 targets/single），服务端以带 targets 的作者版本为准
      const payload = slots
        .filter((s) => s.type !== 'result')
        .map((s) => ({
          ...s,
          label: overrides[s.id]?.label ?? s.label,
          hidden: overrides[s.id]?.hidden ?? false,
          // 选择组：按作者改名后的选项标签回写（未改名则沿用引擎识别的节点标题）
          ...(s.type === 'choice' && s.options
            ? { options: s.options.map((o) => ({ ...o, label: optionLabels[s.id]?.[o.nodeId] ?? o.label })) }
            : {}),
          // 确认步切了单/多选的选择组：覆盖引擎默认
          ...(s.type === 'choice' && singleChoices[s.id] !== undefined ? { single: singleChoices[s.id] === 'single' } : {}),
          status: 'confirmed' as const,
        }))
      // 走 apiFetch（Q-810）：发布是写操作，会话过期时应当统一跳登录而不是只弹「发布失败」
      const r = await apiFetch<{ slug: string }>('/api/tools', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          description,
          category,
          coverUrl,
          forkedFrom,
          workflow: { nodes, connections },
          slots: payload,
        }),
      })
      if (r.success && r.data?.slug) {
        message.success(r.message || '发布成功')
        onSuccess(r.data.slug)
      } else {
        message.error(r.message || '发布失败')
      }
    } catch {
      message.error('发布失败，请检查网络')
    } finally {
      setSubmitting(false)
    }
  }

  const merged = slots.map((s) => ({ ...s, label: overrides[s.id]?.label ?? s.label }))
  const suggestions = analyzed.suggestions ?? []
  const steps = [{ title: '装配清单' }, ...(suggestions.length > 0 ? [{ title: '重复动作' }] : []), { title: '确认控件' }, { title: '命名上架' }]
  const stepConfirm = suggestions.length > 0 ? 2 : 1
  const stepPublish = suggestions.length > 0 ? 3 : 2

  return (
    <Modal
      open={open}
      onCancel={() => { setStep(0); onCancel() }}
      title={<span><ThunderboltFilled className="mr-1.5 text-accent" />存为工具</span>}
      width={560}
      centered
      footer={null}
      destroyOnHidden
    >
      <Steps
        size="small"
        current={step}
        className="mb-4"
        items={steps}
      />

      {step === 0 && (
        <div className="space-y-3">
          {/* 置信度评分 */}
          {slots.length > 0 && (
            <div className="rounded-lg border border-border bg-surface/50 p-3">
              <div className="flex items-center justify-between mb-2">
                <Text className="!text-xs font-medium">识别质量评分</Text>
                <Text className="!text-xs" type={analyzed.confidence >= 80 ? 'success' : analyzed.confidence >= 60 ? 'warning' : 'danger'}>
                  {analyzed.confidence}/100
                </Text>
              </div>
              <Progress
                percent={analyzed.confidence}
                size="small"
                strokeColor={analyzed.confidence >= 80 ? '#52c41a' : analyzed.confidence >= 60 ? '#faad14' : '#ff4d4f'}
                showInfo={false}
              />
              <Text className="!text-[11px] text-text-secondary">
                {analyzed.confidence >= 80 ? '工作流结构完整，识别准确' :
                 analyzed.confidence >= 60 ? '识别基本准确，建议检查校验提示' :
                 '检测到多个问题，请修复后再发布'}
              </Text>
            </div>
          )}

          {/* 校验问题 */}
          {analyzed.validationIssues && analyzed.validationIssues.length > 0 && (
            <div className="space-y-2">
              {analyzed.validationIssues.filter(i => i.severity === 'error').map((issue, idx) => (
                <Alert
                  key={idx}
                  type="error"
                  message={issue.message}
                  icon={<CloseCircleOutlined />}
                  showIcon
                  className="!text-xs"
                />
              ))}
              {analyzed.validationIssues.filter(i => i.severity === 'warning').map((issue, idx) => (
                <Alert
                  key={idx}
                  type="warning"
                  message={issue.message}
                  icon={<WarningOutlined />}
                  showIcon
                  className="!text-xs"
                />
              ))}
            </div>
          )}

          {slots.length === 0 ? (
            <Text type="secondary">
              画布里还没有能做成工具的内容。先搭一个流程，比如：图片上传 → 风格处理 → 生成图片，再来发布。
            </Text>
          ) : (
            <>
              <Text type="secondary">系统读完你的画布，这份工具会向使用者要这些东西：</Text>
              <div className="space-y-2">
                {merged.map((s) => (
                  <div key={s.id} className="flex items-start gap-2.5 rounded-xl border border-accent-border/60 bg-accent-soft/60 px-3 py-2.5 transition hover:bg-accent-soft">
                    <span className="mt-0.5 text-accent">{SLOT_ICON[s.type]}</span>
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium">{s.label}</div>
                      <div className="text-[12px] text-black/50 dark:text-white/50">
                        {SLOT_DESC[s.type]}
                        {s.type === 'choice' && s.options ? `（识别到 ${s.options.length} 个风格）` : ''}
                      </div>
                    </div>
                    <CheckCircleFilled className="ml-auto mt-0.5 text-accent/60" />
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={() => { setStep(0); onCancel() }}>取消</Button>
            <Button
              type="primary"
              disabled={slots.length === 0 || (analyzed.validationIssues?.filter(i => i.severity === 'error').length ?? 0) > 0}
              onClick={() => setStep(suggestions.length > 0 ? 1 : stepConfirm)}
            >
              下一步
            </Button>
          </div>
        </div>
      )}

      {suggestions.length > 0 && step === 1 && (
        <div className="space-y-3">
          <Text type="secondary">
            <QuestionCircleOutlined className="mr-1 text-accent" />
            画布里检测到疑似重复的动作，确认后才会暴露给使用者（不确认就保持原样）：
          </Text>
          {suggestions.map((sg) => {
            const isChoice = sg.kind === 'variant-group'
            const mode = suggChoices[sg.slot.id] ?? 'reject'
            return (
              <div key={sg.slot.id} className="rounded-xl border border-accent-border/60 bg-accent-soft/40 px-3 py-2.5">
                <div className="text-[13px] font-medium">检测到 {sg.nodeIds.length} 个相似动作</div>
                <div className="mt-0.5 text-[12px] text-black/55">{sg.reason}</div>
                <div className="mt-1.5 space-y-1">
                  {sg.nodeIds.map((nid) => {
                    const n = nodes.find((x) => x.id === nid)
                    const prompt = String((n?.inputs as Record<string, unknown> | undefined)?.prompt ?? '').slice(0, 36)
                    return (
                      <div key={nid} className="flex items-center gap-1.5 text-[11.5px] text-black/60">
                        <span className="rounded bg-black/5 px-1.5 py-0.5 font-mono">{String(n?.label ?? nid)}</span>
                        {prompt && <span className="truncate">{prompt}…</span>}
                      </div>
                    )
                  })}
                </div>
                {isChoice && (
                  <div className="mt-2">
                    <Segmented
                      size="small"
                      value={mode}
                      onChange={(v) => setSuggChoices((p) => ({ ...p, [sg.slot.id]: v as 'reject' | 'single' | 'multi' }))}
                      options={[
                        { value: 'reject', label: '不暴露' },
                        { value: 'single', label: '单选（挑 1 个）' },
                        { value: 'multi', label: '多选（每个出一份）' },
                      ]}
                    />
                  </div>
                )}
              </div>
            )
          })}
          <div className="flex justify-between pt-2">
            <Button onClick={() => setStep(0)}>上一步</Button>
            <Button type="primary" onClick={() => setStep(stepConfirm)}>下一步</Button>
          </div>
        </div>
      )}

      {step === stepConfirm && (
        <div className="space-y-2.5">
          <Text type="secondary">逐项确认：改名、选择组切单选/多选、或隐藏不想让使用者调的项。</Text>
          {merged.map((s) => (
            <div key={s.id} className="rounded-xl border border-black/6 bg-white/60 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="text-accent/70">{SLOT_ICON[s.type]}</span>
                <Input
                  size="small"
                  className="!w-40"
                  value={s.label}
                  onChange={(e) => setOverrides((p) => ({ ...p, [s.id]: { ...p[s.id], label: e.target.value } }))}
                />
                <Text type="secondary" className="!text-[11px]">
                  {SLOT_DESC[s.type]}
                  {s.type === 'choice' && singleChoices[s.id] === undefined ? (s.single ? '（单选）' : '') : ''}
                </Text>
                {/* 选择组：作者可切单选/多选（引擎默认多选） */}
                {s.type === 'choice' && s.options && s.options.length > 0 && (
                  <Segmented
                    size="small"
                    value={singleChoices[s.id] === undefined ? (s.single ? 'single' : 'multi') : singleChoices[s.id]}
                    onChange={(v) => setSingleChoices((p) => ({ ...p, [s.id]: v as 'single' | 'multi' }))}
                    options={[
                      { value: 'single', label: '单选' },
                      { value: 'multi', label: '多选' },
                    ]}
                  />
                )}
                <Switch
                  size="small"
                  checked={!overrides[s.id]?.hidden}
                  checkedChildren="显示"
                  unCheckedChildren="隐藏"
                  className="ml-auto"
                  onChange={(v) => setOverrides((p) => ({ ...p, [s.id]: { ...p[s.id], hidden: !v } }))}
                />
              </div>
              {/* 选择组选项逐项改名：与官方「九宫格（2）」的「第1格/第2格」标注对齐 */}
              {s.type === 'choice' && s.options && s.options.length > 0 && !overrides[s.id]?.hidden && (
                <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
                  {s.options.map((o) => (
                    <Input
                      key={o.nodeId}
                      size="small"
                      className="!w-28"
                      value={optionLabels[s.id]?.[o.nodeId] ?? o.label}
                      placeholder={o.label}
                      onChange={(e) => setOptionLabels((p) => ({
                        ...p,
                        [s.id]: { ...p[s.id], [o.nodeId]: e.target.value },
                      }))}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
          <div className="flex justify-between pt-2">
            <Button onClick={() => setStep(suggestions.length > 0 ? 1 : 0)}>上一步</Button>
            <Button type="primary" disabled={visibleSlots.length === 0} onClick={() => setStep(stepPublish)}>下一步</Button>
          </div>
        </div>
      )}

      {step === stepPublish && (
        <div className="space-y-3">
          <div>
            <Text className="mb-1 block text-xs text-text-secondary">工具名称 *</Text>
            <Input placeholder="如「电商套图生成器」" value={name} maxLength={30} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Text className="mb-1 block text-xs text-text-secondary">工具介绍（可选）</Text>
            <Input.TextArea
              placeholder="一句话说明这个工具能做什么"
              value={description}
              autoSize={{ minRows: 2, maxRows: 4 }}
              maxLength={200}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div>
            <Text className="mb-1 block text-xs text-text-secondary">领域分类</Text>
            <div className="space-y-1.5">
              {[
                { label: '基础工具', cats: baseCategories },
                { label: '垂直领域', cats: vertCategories },
              ].map((g) => (
                <div key={g.label} className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 shrink-0 text-[11px] text-black/35">{g.label}</span>
                  {g.cats.map((c) => (
                    <button key={c} onClick={() => setCategory(c)}
                        className={`cursor-pointer rounded-full px-3 py-1 text-[12.5px] transition ${category === c ? 'bg-gradient-to-r from-accent to-accent-2 text-white shadow-sm' : 'border border-black/8 bg-white/70 text-black/60 hover:border-accent-ring hover:text-accent'}`}>
                      {c}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
          <Text type="secondary" className="!text-[12px]">
            发布后进入审核，审核通过将出现在工具箱，任何人都能像用产品一样使用它。
          </Text>
          <div className="flex justify-between pt-1">
            <Button onClick={() => setStep(stepConfirm)}>上一步</Button>
            <Button type="primary" loading={submitting} onClick={() => void submit()}>发布工具</Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
