import { BUILTIN_NODES } from './canvas-nodes'

/**
 * 画布节点完整文档
 * 用途: 1) 一键复制供用户询问 AI ; 2) Copilot 工具调用参考
 */

export interface NodeDocItem {
  type: string
  label: string
  category: string
  categoryLabel: string
  description: string
  inputs: { key: string; type: string; required: boolean; label: string; desc: string }[]
  outputs: { key: string; type: string; label: string; desc: string }[]
  usage: string          // 典型用法说明
  example: string        // 连线示例
}

const categoryLabels: Record<string, string> = {
  llm: 'LLM', image: '图像', logic: '逻辑', data: '数据', io: '输入输出',
}

function buildDoc(): NodeDocItem[] {
  return BUILTIN_NODES.map((n) => {
    const docs: Record<string, { usage: string; example: string }> = {
      'llm-chat': {
        usage: '调用大语言模型进行文本对话。选择支持读图的模型后可传入参考图；支持多张图片——模型按连线顺序编号，提示词里可用「第一张图」「第二张图」等自然语言区分引用（例：请对比第一张图和第二张图的构图）。',
        example: '文本输入(prompt) → LLM对话 → 文本预览',
      },
      'image-generate': {
        usage: '调用生图模型生成图片。模型有预设尺寸时宽高自动变为下拉选择,避免尺寸非法报错。模型支持参考图时可传入图片；提示词里用「第一张图/第二张图」等自然语言指代参考图。',
        example: '文本输入(prompt) → 图像生成 → 图片预览',
      },
      'nine-grid-loop': {
        usage: '生成循环动画：outputMode=native-gif 时让模型直接输出 animated GIF（不排宫格，适合 原生 GIF 模型）；outputMode=grid 时生成 3×3 九帧或 4×4 十六帧连续动作大图。用参考图锁定角色外形，在「分镜脚本」里按【角色】【场景】【动作】【画风】填写，或只写一段创作描述。',
        example: '图片上传(角色参考图) → 九宫格循环帧 → 图片预览',
      },
      'grid9-to-gif': {
        usage: '输入已经是 .gif 时直接透传，不再切格；输入是 3×3 / 4×4 宫格大图时切成 9/16 帧并合成循环 GIF。服务端用 sharp/cgif，不调用模型、不扣积分。支持选帧、帧间隔、正序/乒乓、裁格线、单帧最长边。',
        example: '九宫格循环帧(imageUrl) → 九宫格转GIF(gifUrl) → 图片预览',
      },
      'condition-check': {
        usage: '对输入值做比较运算,输出布尔结果供下游判断。运算符: equals/contains/greaterThan/lessThan。',
        example: '文本输入 → 条件判断 → [result=true 时走分支 A] / [result=false 时走分支 B]',
      },
      'text-concat': {
        usage: '把两段文本按分隔符拼接成一段。默认换行分隔。',
        example: '文本输入A + 文本输入B → 文本拼接 → 文本预览',
      },
      'number-calc': {
        usage: '两数加减乘除。除零返回 0。运算符: add/subtract/multiply/divide。',
        example: '数值输入A + 数值输入B → 数值计算 → 下游',
      },
      'text-input': {
        usage: '手动输入多行文本,作为工作流文本源。',
        example: '文本输入(prompt) → LLM对话',
      },
      'number-input': {
        usage: '手动输入数值,作为工作流数值源。',
        example: '数值输入 → 数值计算',
      },
      'json-parser': {
        usage: '万能 JSON 解析。支持顶层数组、{items:[]}、{data:[]}、{results:[]} 等任意结构,自动找到数组并输出 items + itemCount。JSON 非法时按换行降级拆分。',
        example: 'LLM对话(text) → JSON解析(items) → 字段提取(field=prompt) → 文本预览',
      },
      'field-extractor': {
        usage: '从对象数组中提取指定字段,输出纯值数组。常用:从 json-parser 的 items 提取 prompt/url 等字段。',
        example: 'JSON解析(items) → 字段提取(field=prompt) → 文本预览',
      },
      'text-preview': {
        usage: '预览上游传入的文本内容。纯文本正常显示;对象会显示 [object Object]，需用字段提取后再预览。',
        example: 'LLM对话(text) 或 字段提取(values) → 文本预览',
      },
      'image-upload': {
        usage: '上传图片(点击/拖拽/粘贴 Ctrl+V),作为工作流图片源。',
        example: '图片上传 → 图像生成 或 图片裁切',
      },
      'image-preview': {
        usage: '预览上游图片,点击可放大查看大图。',
        example: '图像生成(imageUrl) → 图片预览',
      },
      'video-generate': {
        usage: '调用视频模型生成视频(扣豆,视频专用额度)。支持首帧/尾帧参考、时长、画幅比例。异步任务会自动轮询等待完成。',
        example: '文本输入(prompt) → 视频生成(videoUrl) → 视频预览',
      },
      'video-preview': {
        usage: '预览上游传入的视频,内置播放器可播放/暂停。',
        example: '视频生成(videoUrl) → 视频预览',
      },
      'image-crop': {
        usage: '实际裁切图片。点击节点「打开工作台」→ 选模式(一宫格拖拽/四九宫格点选)→ 框选 → 确认。输出裁切后的图片数组(1-9 张)。',
        example: '图片上传 → 图片裁切(images) → 字段提取(field=prompt) + array-expand → 多个生图节点(设 index)',
      },
    }
    const d = docs[n.type] || { usage: n.description, example: '' }
    return {
      type: n.type,
      label: n.label,
      category: n.category,
      categoryLabel: categoryLabels[n.category] || n.category,
      description: n.description,
      inputs: Object.entries(n.inputs).map(([k, v]) => ({
        key: k, type: v.type, required: !!v.required, label: v.label, desc: v.description || '',
      })),
      outputs: Object.entries(n.outputs).map(([k, v]) => ({
        key: k, type: v.type, label: v.label, desc: v.description || '',
      })),
      usage: d.usage,
      example: d.example,
    }
  })
}

const NODE_DOCS = buildDoc()

/** 获取所有节点文档(Markdown 格式,可一键复制) */
export function getAllNodeDocsMarkdown(): string {
  const lines: string[] = ['# 画布节点使用指南\n']
  const byCategory: Record<string, NodeDocItem[]> = {}
  for (const d of NODE_DOCS) {
    if (!byCategory[d.category]) byCategory[d.category] = []
    byCategory[d.category].push(d)
  }
  for (const [cat, items] of Object.entries(byCategory)) {
    lines.push(`\n## ${items[0].categoryLabel} (${cat})\n`)
    for (const d of items) {
      lines.push(`### ${d.label} (\`${d.type}\`)\n`)
      lines.push(`${d.description}\n`)
      lines.push(`**输入端口:**`)
      for (const i of d.inputs) {
        lines.push(`- \`${i.key}\` (${i.type}${i.required ? ', 必填' : ''}): ${i.label} — ${i.desc}`)
      }
      lines.push(`\n**输出端口:**`)
      for (const o of d.outputs) {
        lines.push(`- \`${o.key}\` (${o.type}): ${o.label} — ${o.desc}`)
      }
      lines.push(`\n**典型用法:** ${d.usage}`)
      if (d.example) lines.push(`**连线示例:** \`${d.example}\``)
      lines.push('')
    }
  }
  return lines.join('\n')
}
