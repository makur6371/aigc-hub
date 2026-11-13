// 画布预设库与工具模板（纯数据 + 纯函数，无组件状态依赖）
//
// 从 canvas/page.tsx 抽出：原文件 3800+ 行，这块常量占约 90 行且与组件逻辑零耦合，
// 独立成模块后页面文件更聚焦「交互逻辑」，模板增删也不必在巨型文件里翻找。

import type { WorkflowTool } from './tool-types'
import { buildNineGridScript } from '@/lib/nine-grid-loop'
import nineGridLoopDemo from '@/lib/nine-grid-loop-preset.json'

export interface PresetNodeDef { type: string; label?: string; inputs?: Record<string, unknown>; systemPrompt?: string }
export interface PresetConnDef { source: number; sourcePort: string; target: number; targetPort: string }
export interface PresetTemplate { id: string; name: string; description: string; category: 'node' | 'workflow' | 'prompt'; nodes?: PresetNodeDef[]; connections?: PresetConnDef[]; prompts?: string[] }

export const PRESET_TEMPLATES: PresetTemplate[] = [
  {
    id: 'preset-nine-grid-loop',
    name: '九宫格循环帧',
    description: '上传角色参考图，按角色 / 场景 / 九帧动作生成 3×3 连续帧大图，第 9 帧回到第 1 帧，可直接用于合成无缝循环动图。',
    category: 'workflow',
    nodes: [
      { type: 'image-upload', label: '角色参考图' },
      {
        type: 'nine-grid-loop',
        label: '九宫格循环帧',
        inputs: {
          script: buildNineGridScript({
            character: nineGridLoopDemo.character,
            scene: nineGridLoopDemo.scene,
            actions: nineGridLoopDemo.actions,
            style: nineGridLoopDemo.style,
          }),
          negativePrompt: nineGridLoopDemo.negativePrompt,
          grid: '3×3（9帧）',
          width: 1024,
          height: 1024,
        },
      },
      {
        type: 'grid9-to-gif',
        label: '九宫格转GIF',
        inputs: {
          delayMs: 150,
          mode: 'normal',
          grid: '3×3（9帧）',
          frames: '',
          trimPercent: 1,
          maxSize: 512,
          background: '#ffffff',
        },
      },
      { type: 'image-preview', label: '循环动图' },
    ],
    connections: [
      { source: 0, sourcePort: 'imageUrl', target: 1, targetPort: 'referenceImage' },
      { source: 1, sourcePort: 'imageUrl', target: 2, targetPort: 'imageUrl' },
      { source: 2, sourcePort: 'gifUrl', target: 3, targetPort: 'imageUrl' },
    ],
  },
  {
    id: 'preset-image-prompt-master',
    name: '图片提示词大师（逆推）',
    description: '一个 LLM 节点，带预设系统提示词：根据图片/描述逆向推理光影、主体、背景、光线等，输出现成的图片提示词。',
    category: 'node',
    nodes: [{ type: 'llm-chat', systemPrompt: '你是一位顶尖的图片提示词书写大师。请你观察/读取提供的图片内容或描述，分别从光影、主体、背景、光线、构图、风格、色彩、景深等角度出发，进行细致逆推，最终输出一段结构清晰、可直接用于文生图模型的图片提示词。不要输出多余解释。' }],
  },
  {
    id: 'preset-copy-polish',
    name: '文案润色专家',
    description: '一个 LLM 节点，带预设系统提示词：对输入文案进行润色、扩写或精简，输出更专业流畅的版本。',
    category: 'node',
    nodes: [{ type: 'llm-chat', systemPrompt: '你是一位资深文案润色专家。对用户输入的文字进行润色、改写，使其更专业、流畅、有感染力。根据用户要求选择扩写、精简或保持长度。' }],
  },
  {
    id: 'preset-prompt-to-image',
    name: '优化提示词 → 生图',
    description: 'LLM 先把需求优化成图片提示词，再送入图像生成节点出图（常见两步预设）。',
    category: 'workflow',
    nodes: [
      { type: 'llm-chat', systemPrompt: '你是图片提示词优化大师。把用户的一句话需求扩写成详细、高质量的英文图片提示词，输出可直接用于文生图。' },
      { type: 'image-generate' },
    ],
    connections: [{ source: 0, sourcePort: 'text', target: 1, targetPort: 'prompt' }],
  },
  {
    id: 'preset-ecommerce-style',
    name: '电商风格提示词集',
    description: '一组可直接下拉选用的电商/产品图风格提示词模板，供工具面板或生图节点引用。',
    category: 'prompt',
    prompts: [
      '极简白底电商主图，柔和棚拍光影，产品居中，4K 高清，质感细腻',
      '生活方式场景：自然光、木桌、居家氛围，产品融入日常',
      '高端黑金质感：暗背景、聚光、高级感，品牌调性',
      '色彩冲击：高饱和背景、醒目构图、吸引眼球',
    ],
  },
]

// ---------------------------------------------------------------
// 工具库：比预设更成熟的「工作流工具」= 工作流快照 + 端口绑定(内嵌 meta) + 工具面板。
// 面板渲染「一键输入(文本/模型/比例)」，一键运行写回画布，运行结束输出「一键下载/复制」。
// ---------------------------------------------------------------
export const TOOL_TEMPLATES: WorkflowTool[] = [
  {
    id: 'tool-ecom-image',
    name: '电商主图生成',
    description: '输入一句话产品描述/风格，可选生图模型与画幅比例，一键输出可直接下载的电商主图。',
    category: '电商',
    nodes: [{ type: 'image-generate' }],
    connections: [],
    inputs: [
      { key: 'prompt', nodeIndex: 0, port: 'prompt', label: '产品描述 / 风格', control: 'textarea', placeholder: '例：极简白底产品主图，产品居中，柔和棚拍光影，4K 高清' },
      { key: 'model', nodeIndex: 0, port: 'model', label: '生图模型', control: 'model' },
      { key: 'ratio', nodeIndex: 0, port: 'ratio', label: '画幅比例', control: 'ratio' },
    ],
    outputs: [{ key: 'img', nodeIndex: 0, port: 'images', label: '生成结果', kind: 'image' }],
  },
  {
    id: 'tool-prompt-to-image',
    name: '提示词优化 → 生图',
    description: '一句话需求先进 LLM 扩写成高质量提示词，再送入生图节点出图（两步工具）。',
    category: '图像',
    nodes: [
      { type: 'llm-chat', systemPrompt: '你是图片提示词优化大师。把用户的一句话需求扩写成详细、高清、可直接用于文生图模型的英文提示词，只输出提示词本身。' },
      { type: 'image-generate' },
    ],
    connections: [{ source: 0, sourcePort: 'text', target: 1, targetPort: 'prompt' }],
    inputs: [
      { key: 'demand', nodeIndex: 0, port: 'prompt', label: '一句话需求', control: 'textarea', placeholder: '例：一只在画室里被银发画家描绘的慵懒橘猫，暖色侧光' },
      { key: 'model', nodeIndex: 1, port: 'model', label: '生图模型', control: 'model' },
      { key: 'ratio', nodeIndex: 1, port: 'ratio', label: '画幅比例', control: 'ratio' },
    ],
    outputs: [{ key: 'img', nodeIndex: 1, port: 'images', label: '生成结果', kind: 'image' }],
  },
]

// 节点库多级分类：父分类下的二级分组标签（hover 弹出子列表）
export function catalogCatsFor(mode: 'nodes' | 'presets' | 'tools' | 'workflows', nodeCats: string[] = []): string[] {
  if (mode === 'presets') return ['node', 'workflow', 'prompt']
  if (mode === 'tools') {
    const set = new Set<string>()
    TOOL_TEMPLATES.forEach((t) => set.add(t.category || '其他'))
    return [...set]
  }
  if (mode === 'nodes') return nodeCats
  return []
}
