'use client'

/**
 * 助手/正文类文本的统一 Markdown 渲染。
 *
 * ===== 为什么要有这个共享组件 =====
 * 之前 Canvas Copilot 与Agent 面板各写一份渲染，样式已经开始漂移：
 *   - Agent 面板（ToolAgentPanel）**根本没渲染 markdown**，reply 里的表格/加粗
 *     被 `whitespace-pre-wrap` 原样打出来（用户实测截图：整段 `| 图片 | 方向 | ...` 裸奔）
 *   - 两处都漏了 `remark-gfm` → GFM 扩展语法（**表格**、删除线、任务列表）全部失效，
 *     而 Agent 的回复里表格是高频内容
 * 收敛到一处，避免第三次再写一份。
 *
 * ===== 安全性 =====
 * react-markdown **默认安全**：不用 dangerouslySetInnerHTML、不解析原始 HTML
 * （官方 readme: "safe by default (no dangerouslySetInnerHTML or XSS attacks)"）。
 * 因此这里**刻意不引入 rehype-raw** —— 一旦引入，模型输出里的 HTML 会被当真实
 * 标签执行，构成 XSS 面。若将来确有内联 HTML 需求，必须同时挂 rehype-sanitize。
 *
 * ===== 关于 remark-gfm =====
 * 只加 remark 插件、不加 rehype 插件，仍然是"输出 React 元素"的安全路径，
 * 不会打开 HTML 通道 —— 它只是让 markdown 解析器认得表格语法。
 */

import { useCallback, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ZoomInOutlined } from '@ant-design/icons'
import { ImageLightbox } from './ImageLightbox'

export interface MarkdownProps {
  children: string
  /** 字号基调；面板类窄容器用 'sm'，正文用 'base' */
  size?: 'sm' | 'base'
  className?: string
}

/** 元素级样式（Tailwind 任意变体），与项目既有的克制风格一致 */
const BASE_CLASS = [
  // 段落 / 列表
  '[&_p]:mb-1.5 [&_p:last-child]:mb-0',
  '[&_ul]:list-disc [&_ul]:pl-4 [&_ul]:mb-1.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:mb-1.5',
  '[&_li]:mb-0.5',
  // 标题
  '[&_h1]:text-[15px] [&_h1]:font-semibold [&_h1]:mb-1.5',
  '[&_h2]:text-[14px] [&_h2]:font-semibold [&_h2]:mb-1.5',
  '[&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:mb-1',
  // 代码
  '[&_code]:rounded [&_code]:bg-black/[0.06] [&_code]:px-1 [&_code]:py-px [&_code]:text-[11px] [&_code]:font-mono',
  '[&_pre]:mb-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-[#1e1b2e] [&_pre]:p-2.5',
  '[&_pre]:text-[11px] [&_pre]:text-white [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  // 链接 / 引用
  '[&_a]:text-accent [&_a]:underline',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-accent/30 [&_blockquote]:pl-2 [&_blockquote]:text-text-secondary',
  // 分隔线
  '[&_hr]:my-2 [&_hr]:border-border',
  // 表格（GFM）：Agent 回复里高频（方案对照、参数清单）
  '[&_table]:my-1.5 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[12px]',
  '[&_th]:border [&_th]:border-border [&_th]:bg-black/[0.03] [&_th]:px-1.5 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium',
  '[&_td]:border [&_td]:border-border [&_td]:px-1.5 [&_td]:py-1 [&_td]:align-top',
  // 表格在窄面板里可能很宽 → 允许横向滚动而不是撑破布局
  '[&_table]:block [&_table]:overflow-x-auto md:[&_table]:table',
  // 图片（含「裸链接自动转图」出来的）：限高、圆角、不撑破窄面板
  '[&_img]:my-1.5 [&_img]:max-h-64 [&_img]:w-auto [&_img]:max-w-full [&_img]:rounded-lg [&_img]:border [&_img]:border-border',
].join(' ')

/**
 * 把「单独成行的图片直链」转成 markdown 图片。
 *
 * ===== 为什么需要 =====
 * 历史数据里 Agent 的收尾回复粘贴过裸链接（2026-10-01 之前的调用，见 agent-tool-loop
 * 的回填文本）。那些消息**已经落库**，改提示词治不了存量数据 —— 用户回头看历史时
 * 仍然是一屏长链接。这里在渲染层兜住：链接变图，历史记录也跟着恢复可读。
 *
 * ===== 边界（刻意保守，避免误伤） =====
 * - 只认**扩展名是图片**的 http(s) 链接（.png/.jpg/.jpeg/.webp/.gif/.avif/.bmp）
 * - 只处理「该链接独占一行」的情况（行首行尾没有别的文字）——
 *   正文里顺带提到的链接保持原样，不当图片插入
 * - 已经是 markdown 图片语法 ![](url) 的不重复处理
 * - 链接前后的编号/项目符号（如「1. 图1 橙色手套：」）保留，图片插到该行下方
 */
const IMG_EXT_RE = /\.(?:png|jpe?g|webp|gif|avif|bmp)(?:\?[^\s]*)?$/i

function linkifyBareImageUrls(text: string): string {
  if (!text || !text.includes('http')) return text
  const lines = text.split('\n')
  const out: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    // 整行就是一个图片链接（允许前后被 markdown 列表符/编号包着）
    const m = /^(?:[-*+]|\d+[.)])?\s*(?:图\s*\d+[^:：]*[:：]?\s*)?(https?:\/\/\S+)$/.exec(trimmed)
    if (m && IMG_EXT_RE.test(m[1])) {
      // 保留「1. 图1 橙色手套：」这类前缀作为 alt / 说明
      const prefix = trimmed.slice(0, trimmed.indexOf(m[1])).replace(/[:：]\s*$/, '').trim()
      out.push(prefix ? `**${prefix}**\n\n![](${m[1]})` : `![](${m[1]})`)
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

export function Markdown({ children, size = 'sm', className = '' }: MarkdownProps) {
  const sizeClass = size === 'base' ? 'text-sm' : 'text-[13px]'
  // 灯箱状态：点任意一张图 → 打开，并支持在多张之间左右切换
  const [box, setBox] = useState<{ open: boolean; urls: string[]; index: number }>({
    open: false, urls: [], index: 0,
  })
  const closeBox = useCallback(() => setBox((b) => ({ ...b, open: false })), [])

  // 收集本次渲染出来的**全部**图片 URL：
  // 这样点第 3 张时，灯箱里能左右翻到同一条消息的其他图
  const allImages = allBareImageUrls(children)

  return (
    <>
      <div className={`${sizeClass} leading-relaxed text-black/80 ${BASE_CLASS} ${className}`}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            // 图片：套一层容器做 hover 态 + 点击放大。
            // 用户诉求「悬停时出现查看/放大按钮」——用覆盖层实现，不改变图片本身的语义。
            img: ({ src, alt }) => {
              const url = typeof src === 'string' ? src : ''
              if (!url) return null
              return (
                <span className="group/img relative my-1.5 inline-block max-w-full">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url}
                    alt={alt || ''}
                    className="max-h-64 w-auto max-w-full rounded-lg border border-border"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const i = allImages.indexOf(url)
                      setBox({ open: true, urls: allImages.length ? allImages : [url], index: i >= 0 ? i : 0 })
                    }}
                    title="点击放大查看"
                    aria-label="放大查看"
                    className="absolute right-2 bottom-2 flex items-center gap-1 rounded-lg bg-black/55 px-2 py-1 text-[11px] text-white opacity-0 backdrop-blur transition-opacity group-hover/img:opacity-100 focus:opacity-100"
                  >
                    <ZoomInOutlined /> 查看
                  </button>
                </span>
              )
            },
          }}
        >
          {linkifyBareImageUrls(children)}
        </ReactMarkdown>
      </div>
      <ImageLightbox open={box.open} urls={box.urls} startIndex={box.index} onClose={closeBox} />
    </>
  )
}

/** 取文本里所有「独占整行的图片直链」——供灯箱左右切换用 */
function allBareImageUrls(text: string): string[] {
  if (!text || !text.includes('http')) return []
  const out: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    const m = /^(?:[-*+]|\d+[.)])?\s*(?:图\s*\d+[^:：]*[:：]?\s*)?(https?:\/\/\S+)$/.exec(trimmed)
    if (m && IMG_EXT_RE.test(m[1])) out.push(m[1])
  }
  // markdown 图片语法 ![alt](url) 也算
  for (const m of text.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)) out.push(m[1])
  return [...new Set(out)]
}
