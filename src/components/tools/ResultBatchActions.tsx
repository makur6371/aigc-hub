'use client'

// 成果区「批量操作」：一个下拉菜单，把对一批成果图的所有批量动作收在一处。
//
// 六个动作（用户指定）：
//   1) 批量高清放大   —— 图生图，提示词要求「保内容不变、提升清晰度」
//   2) 批量抠图       —— 图生图，去背景；可选透明底或纯色底
//   3) 批量去水印     —— 图生图，去除水印/文字浮层，周围背景自然填充
//   4) 批量翻译       —— 图生图，把图上文字翻译成目标语言并重绘
//   5) 批量删除       —— 红色突出（破坏性操作）
//   6) 批量下载       —— 主色突出（最常用）
//
// 前四个走同一套「排队式派发」：立刻在成果区置顶 N 个排队位，
// 谁先返回谁先落位，用户可以继续派发别的任务（见 store 的 startImageBatch）。
//
// 九宫格切割不在这里 —— 它是「对当前正在编辑的图」的操作，放在工作台工具栏
// （那里有 9 格预览 + 手动微调），比在成果区盲切准确得多。

import { useState } from 'react'
import { App, Dropdown, Modal, Select, Tooltip } from 'antd'
import {
  DownOutlined, ExpandOutlined, ScissorOutlined, ClearOutlined,
  TranslationOutlined, DeleteOutlined, DownloadOutlined, LoadingOutlined,
} from '@ant-design/icons'
import { useToolRunStore, type ResultItem, type ImageBatchOp } from '@/stores/useToolRunStore'
import { ASPECT_RATIOS, decodeSize, findImageSize, getImageCapabilities } from '@/lib/image-sizes'

/**
 * 只声明本组件真正用到的字段（结构化类型）。
 * 不直接 import page 里的 ModelOption：那是 client component 文件，
 * 跨文件引类型既容易造成循环依赖，也会让两处定义各自漂移。
 */
/** 批量操作面板需要的模型选项（只用到 id / name / type 三个字段） */
export type BatchModelOption = {
  id: string
  name: string
  type: string
  /** 模型元数据（含 sizes 声明的可用「比例@档位」清单） */
  metadata?: Record<string, unknown> | null
}

interface Props {
  /** 当前选中的成果（已完成的） */
  selected: ResultItem[]
  models: BatchModelOption[]
  /** 批量下载（由 page 提供：含进度提示与打包逻辑） */
  onDownload: () => void
  /** 批量删除（由 page 提供：含确认弹窗） */
  onDelete: () => void
  downloading?: boolean
}

/** 前四个「图生图」批处理动作的配置 */
const EDIT_OPS: Array<{
  op: ImageBatchOp
  label: string
  desc: string
  icon: React.ReactNode
}> = [
  { op: 'upscale', label: '批量高清放大', desc: '保持内容不变，提升清晰度与细节', icon: <ExpandOutlined /> },
  { op: 'cutout', label: '批量抠图', desc: '去掉背景，只保留主体', icon: <ScissorOutlined /> },
  { op: 'dewatermark', label: '批量去水印', desc: '去除水印/文字浮层，周围背景自然填充', icon: <ClearOutlined /> },
  { op: 'translate', label: '批量翻译', desc: '把图上文字翻译成目标语言并重绘', icon: <TranslationOutlined /> },
]

const LANGUAGES = ['English', '中文', '日本語', '한국어', 'Русский', 'Français', 'Deutsch', 'Español', 'Português', 'Italiano', 'العربية', 'ไทย', 'Tiếng Việt']

export function ResultBatchActions({ selected, models, onDownload, onDelete, downloading }: Props) {
  const { message } = App.useApp()
  const startImageBatch = useToolRunStore((s) => s.startImageBatch)

  // 当前打开哪个动作的弹窗（null = 没开）
  const [openOp, setOpenOp] = useState<ImageBatchOp | null>(null)

  // 弹窗内的参数（四个动作共用一份状态，切换动作时按需重置）
  const [modelId, setModelId] = useState<string | undefined>(undefined)
  const [ratio, setRatio] = useState('1:1')
  const [tier, setTier] = useState('2K')
  const [background, setBackground] = useState('transparent')
  const [targetLanguage, setTargetLanguage] = useState('English')

  const imageModels = models.filter((m) => m.type === 'IMAGE')
  // 模型声明的档位（后台「供应商管理 → 模型配置」勾选的 1K/2K/4K）。
  // 没配置 sizes 时兜底只出 1K，防止模型不支持的高档位在用户端冒出来。
  const selectedModel = imageModels.find((m) => m.id === modelId)
  const imageCap = getImageCapabilities(selectedModel)
  const ratioOptions = imageCap.declared ? imageCap.ratios : [...ASPECT_RATIOS].slice(0, 8)
  const tierOptions = imageCap.declared
    ? (imageCap.tiersByRatio[ratio] ?? [])
    : ['1K']

  const count = selected.length
  const allImages = count > 0 && selected.every((s) => s.kind === 'image')

  const chooseBatchModel = (id: string) => {
    setModelId(id)
    const cap = getImageCapabilities(imageModels.find((m) => m.id === id))
    const nextRatio = cap.declared
      ? (cap.ratios.includes(ratio) ? ratio : (cap.ratios[0] ?? ratio))
      : ratio
    const nextTier = cap.declared
      ? (cap.tiersByRatio[nextRatio] ?? [])[0]
      : '1K'
    setRatio(nextRatio)
    if (nextTier) setTier(nextTier)
  }

  /** 打开某个动作的弹窗（默认选中第一个可用模型，避免用户忘选） */
  const openModal = (op: ImageBatchOp) => {
    if (!allImages) { message.warning('该操作仅支持图片'); return }
    if (!modelId && imageModels.length > 0) chooseBatchModel(imageModels[0].id)
    setOpenOp(op)
  }

  /** 派发（四个动作共用：只有 op 与附加参数不同） */
  const dispatch = () => {
    if (!openOp) return
    if (!modelId) { message.warning('请先选择生图模型'); return }
    const size = openOp === 'upscale'
      ? (imageCap.declared ? findImageSize(imageCap, ratio, tier) : decodeSize(`${ratio}@${tier}`))
      : undefined
    startImageBatch({
      items: selected.map((s) => ({ url: s.url, label: s.styleLabel, toolName: s.toolName })),
      modelId,
      op: openOp,
      width: size?.width,
      height: size?.height,
      background: openOp === 'cutout' ? background : undefined,
      targetLanguage: openOp === 'translate' ? targetLanguage : undefined,
    })
    message.success(`已派发 ${count} 张${EDIT_OPS.find((o) => o.op === openOp)?.label.replace('批量', '')}任务，可在成果区看进度`)
    setOpenOp(null)
  }

  const menuItems = [
    ...EDIT_OPS.map((o) => ({
      key: o.op,
      // 图标 + 名称 + 一行说明：让用户一眼知道这个动作做什么
      label: (
        <span className="flex items-center gap-2.5 py-0.5">
          <span className="text-accent">{o.icon}</span>
          <span className="flex flex-col leading-tight">
            <span className="text-[13px]">{o.label}</span>
            <span className="text-[11px] text-black/40">{o.desc}</span>
          </span>
        </span>
      ),
      disabled: !allImages,
    })),
    { type: 'divider' as const },
    {
      key: 'download',
      // 主色突出：批量下载是最常用动作
      label: (
        <span className="flex items-center gap-2.5 py-0.5 font-medium text-accent">
          <DownloadOutlined />
          <span className="text-[13px]">批量下载{count > 0 ? `（${count}）` : ''}</span>
        </span>
      ),
    },
    {
      key: 'delete',
      // 红色突出：破坏性操作，视觉上要有区分
      label: (
        <span className="flex items-center gap-2.5 py-0.5 font-medium text-red-500">
          <DeleteOutlined />
          <span className="text-[13px]">批量删除{count > 0 ? `（${count}）` : ''}</span>
        </span>
      ),
      disabled: count === 0,
    },
  ]

  const currentOp = openOp ? EDIT_OPS.find((o) => o.op === openOp) : null

  return (
    <>
      <Dropdown
        trigger={['click']}
        menu={{
          items: menuItems,
          onClick: ({ key }) => {
            if (key === 'download') { onDownload(); return }
            if (key === 'delete') { onDelete(); return }
            openModal(key as ImageBatchOp)
          },
        }}
      >
        <button
          type="button"
          // max-lg 放大点击区域：触屏没有 hover，小按钮（约 22px 高）很难点准
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-black/55 transition hover:bg-accent-soft hover:text-accent max-lg:min-h-8 max-lg:px-3 max-lg:text-[12.5px]"
        >
          批量操作
          {count > 0 && <span className="rounded-full bg-accent-soft px-1.5 text-accent">{count}</span>}
          <DownOutlined className="text-[9px]" />
        </button>
      </Dropdown>

      <Modal
        title={currentOp ? `${currentOp.label} · ${count} 张` : ''}
        open={openOp !== null}
        onCancel={() => setOpenOp(null)}
        onOk={() => void dispatch()}
        okText={currentOp ? `开始${currentOp.label.replace('批量', '')} ${count} 张` : ''}
        width={520}
        // 移动端：弹窗贴边留白 + 参数区可滚，避免规格/语言选项被挤掉
        styles={{ body: { maxHeight: '60vh', overflowY: 'auto' } }}
      >
        <div className="space-y-4 py-2">
          <div>
            <div className="mb-1 text-[13px] font-medium">生图模型</div>
            <Select
              className="w-full"
              placeholder="请选择模型"
              value={modelId}
              onChange={chooseBatchModel}
              options={imageModels.map((m) => ({ value: m.id, label: m.name }))}
            />
          </div>

          {/* 放大：规格档位 */}
          {openOp === 'upscale' && (
            <div>
              <div className="mb-1 text-[13px] font-medium">放大规格</div>
              <div className="flex flex-wrap gap-1.5">
                {ratioOptions.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => {
                      const first = findImageSize(imageCap, r)
                      setRatio(r)
                      if (first?.tier) setTier(first.tier)
                    }}
                    className={`rounded-lg border px-2.5 py-1 text-[12px] transition ${
                      ratio === r ? 'border-accent bg-accent-soft text-accent' : 'border-black/10 text-black/55 hover:border-accent-ring'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {tierOptions.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTier(t)}
                    className={`rounded-lg border px-2.5 py-1 text-[12px] transition ${
                      tier === t ? 'border-accent bg-accent-soft text-accent' : 'border-black/10 text-black/55 hover:border-accent-ring'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 抠图：背景处理 */}
          {openOp === 'cutout' && (
            <div>
              <div className="mb-1 text-[13px] font-medium">背景处理</div>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { v: 'transparent', t: '透明底（PNG）' },
                  { v: 'white', t: '纯白底' },
                  { v: 'black', t: '纯黑底' },
                  { v: 'light gray', t: '浅灰底' },
                ].map((o) => (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => setBackground(o.v)}
                    className={`rounded-lg border px-2.5 py-1 text-[12px] transition ${
                      background === o.v ? 'border-accent bg-accent-soft text-accent' : 'border-black/10 text-black/55 hover:border-accent-ring'
                    }`}
                  >
                    {o.t}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 翻译：目标语言 */}
          {openOp === 'translate' && (
            <div>
              <div className="mb-1 text-[13px] font-medium">目标语言</div>
              <Select
                className="w-full"
                value={targetLanguage}
                onChange={setTargetLanguage}
                showSearch
                options={LANGUAGES.map((l) => ({ value: l, label: l }))}
              />
            </div>
          )}

          <div className="rounded-lg bg-amber-50/70 px-3 py-2 text-[12px] leading-relaxed text-amber-700">
            每张图各派一次任务，独立计费、独立失败（一张失败不影响其余）。
            {openOp === 'upscale' && '放大是「保持内容不变、提升清晰度」，不会重画。'}
            {openOp === 'cutout' && '抠图由图生图模型完成，复杂边缘（毛发、半透明材质）可能不够干净。'}
            {openOp === 'dewatermark' && '去水印由模型自动识别并填充；水印面积过大或压在主体上时效果有限。'}
            {openOp === 'translate' && '翻译会重绘图上文字，排版风格保持一致，但字体可能与原图有差异。'}
            派发前会先把图片准备成上游可访问的地址，这一步可能需要几秒。
          </div>
        </div>
      </Modal>
    </>
  )
}
