// Canvas Node TypeScript Definition System
// All node types are defined with standard TypeScript interfaces for admin-side code management

import {
  NINE_GRID_LOOP_DEFAULT_NEGATIVE_PROMPT,
} from './nine-grid-loop'

export interface NodePort {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'image' | 'video' | 'audio' | 'stream'
  required?: boolean
  label: string
  description?: string
  defaultValue?: unknown
}

export interface NodeDefinition {
  /** Unique node type identifier, e.g. 'llm-chat', 'image-generate', 'condition-check' */
  type: string
  /** Display label */
  label: string
  /** Category for grouping in the node palette */
  category: 'llm' | 'image' | 'video' | 'audio' | 'logic' | 'data' | 'io'
  /** Description of what this node does */
  description: string
  /** Input port definitions */
  inputs: Record<string, NodePort>
  /** Output port definitions */
  outputs: Record<string, NodePort>
  /** TS code schema string for the node's runtime behavior */
  codeSchema: string
}

// Built-in node definitions
export const BUILTIN_NODES: NodeDefinition[] = [
  {
    type: 'llm-chat',
    label: 'LLM 对话',
    category: 'llm',
    description: '调用大语言模型进行文本对话处理',
    inputs: {
      prompt: { type: 'string', required: true, label: '提示词', description: '发送给 LLM 的提示词' },
      image: { type: 'image', required: false, label: '参考图片', description: '可选，传入图片供视觉模型读图（多图连线即引用，自动收集）' },
      systemPrompt: { type: 'string', required: false, label: '系统提示词', description: '角色设定提示词' },
      model: { type: 'string', required: false, label: '模型选择', description: '指定使用的 LLM 模型' },
      temperature: { type: 'number', required: false, label: '温度', defaultValue: 0.7, description: '控制输出随机性' },
    },
    outputs: {
      text: { type: 'string', label: '生成文本', description: 'LLM 生成的响应文本' },
      tokens: { type: 'number', label: 'Token 消耗', description: '本次调用消耗的 Token 数' },
    },
    codeSchema: `async function run(inputs) {
  const response = await callLLM({
    prompt: inputs.prompt,
    systemPrompt: inputs.systemPrompt,
    model: inputs.model,
    temperature: inputs.temperature ?? 0.7,
  })
  return { text: response.content, tokens: response.usage.totalTokens }
}`,
  },
  {
    type: 'image-generate',
    label: '图像生成',
    category: 'image',
    description: '调用生图模型生成图片',
    inputs: {
      prompt: { type: 'string', required: true, label: '图片描述', description: '图片生成提示词' },
      // 共享提示词后缀：把「产品信息/卖点/文案语言」等公共要求拼到每个生图节点的提示词后面。
      // 工具作者用一个文本节点接到所有生图节点的这个口，即可让 N 个方向共用同一段补充要求。
      promptSuffix: { type: 'string', required: false, label: '补充要求', description: '追加到提示词末尾的公共要求（如产品信息、卖点、文案语言）' },
      model: { type: 'string', required: false, label: '模型选择', description: '指定使用的生图模型' },
      referenceImage: { type: 'image', required: false, label: '参考图片', description: '传入参考图供生图模型参考（支持多图，提示词中用「第一张图/第二张图」等自然语言指代）' },
      negativePrompt: { type: 'string', required: false, label: '负向提示词', description: '不希望出现的元素' },
      width: { type: 'number', required: false, label: '宽度', defaultValue: 1024, description: '图片宽度（像素）' },
      height: { type: 'number', required: false, label: '高度', defaultValue: 1024, description: '图片高度（像素）' },
    },
    outputs: {
      imageUrl: { type: 'image', label: '图片地址', description: '生成的图片 URL' },
    },
    codeSchema: `async function run(inputs) {
  const result = await generateImage({
    prompt: inputs.prompt,
    negativePrompt: inputs.negativePrompt,
    width: inputs.width ?? 1024,
    height: inputs.height ?? 1024,
  })
  return { imageUrl: result.imageUrl }
}`,
  },
  {
    type: 'nine-grid-loop',
    label: '宫格循环帧',
    category: 'image',
    description: '用参考图锁定角色，一次生成 3×3 九帧或 4×4 十六帧连续动作大图，用于合成无缝循环动图',
    inputs: {
      referenceImage: {
        type: 'image',
        required: true,
        label: '角色参考图',
        description: '角色标准外形参考图（第一张图）；图中的文字、水印不会进入画面',
      },
      script: {
        type: 'string',
        required: true,
        label: '分镜脚本',
        description: '一个文本框写完：【角色】外观 / 【场景】镜头 / 【动作】9或16行 / 【画风】（可省略）；也可只写一段创作描述',
        defaultValue: '',
      },
      grid: {
        type: 'string',
        required: false,
        label: '宫格规格',
        description: '3×3（9帧）或 4×4（16帧）',
        defaultValue: '3×3（9帧）',
      },
      outputMode: {
        type: 'string',
        required: false,
        label: '输出模式',
        description: 'grid=宫格大图；native-gif=模型直接生成 GIF（不排宫格）',
        defaultValue: 'grid',
      },
      negativePrompt: {
        type: 'string',
        required: false,
        label: '负向提示词',
        description: '不希望出现的元素',
        defaultValue: NINE_GRID_LOOP_DEFAULT_NEGATIVE_PROMPT,
      },
      model: { type: 'string', required: false, label: '模型选择', description: '指定使用的生图模型' },
      width: { type: 'number', required: false, label: '宽度', defaultValue: 1024, description: '九宫格大图宽度（像素），建议 1:1' },
      height: { type: 'number', required: false, label: '高度', defaultValue: 1024, description: '九宫格大图高度（像素），建议 1:1' },
    },
    outputs: {
      imageUrl: { type: 'image', label: '九宫格大图', description: '3×3 连续帧图片地址，可再切分或合成动图' },
    },
    codeSchema: `async function run(inputs) {
  // 单文本框分镜脚本（【角色】【场景】【动作】【画风】）由 lib/nine-grid-loop.ts 解析并构造
  const parsed = parseNineGridScript(inputs.script)
  const prompt = normalizeOutputMode(inputs.outputMode) === 'native-gif'
    ? buildNativeGifPrompt({ ...parsed, grid: inputs.grid })
    : buildNineGridLoopPrompt({ ...parsed, grid: inputs.grid })
  const result = await generateImage({
    prompt,
    negativePrompt: inputs.negativePrompt,
    referenceImages: [].concat(inputs.referenceImage || []),
    width: inputs.width ?? 1024,
    height: inputs.height ?? 1024,
  })
  return { imageUrl: result.imageUrl }
}`,
  },
  {
    type: 'grid9-to-gif',
    label: '宫格转GIF',
    category: 'image',
    description: '把 3×3 / 4×4 宫格大图切成 9/16 帧并合成循环 GIF；支持选帧、帧间隔、正序/乒乓、裁格线',
    inputs: {
      imageUrl: {
        type: 'image',
        required: true,
        label: '宫格大图',
        description: '接宫格循环帧节点的输出，或上传一张 3×3 / 4×4 排版图',
      },
      grid: {
        type: 'string',
        required: false,
        label: '宫格规格',
        description: '3×3（9帧）或 4×4（16帧）',
        defaultValue: '3×3（9帧）',
      },
      delayMs: {
        type: 'number',
        required: false,
        label: '帧间隔(毫秒)',
        description: '每帧停留时间，建议 80-300ms；默认 150ms',
        defaultValue: 150,
      },
      mode: {
        type: 'string',
        required: false,
        label: '播放模式',
        description: 'normal=正序循环；pingpong=往返乒乓（1→9→1）',
        defaultValue: 'normal',
      },
      frames: {
        type: 'string',
        required: false,
        label: '帧选择',
        description: '留空=全部帧（随宫格 9/16）；也可填 1-9、1,3,5、1-4,9，填写顺序即播放顺序',
        defaultValue: '',
      },
      trimPercent: {
        type: 'number',
        required: false,
        label: '裁格线(%)',
        description: '每格四边裁掉的百分比，用来去掉九宫格之间的分隔线；默认 1%',
        defaultValue: 1,
      },
      maxSize: {
        type: 'number',
        required: false,
        label: '单帧最长边',
        description: 'GIF 每帧最长边（像素），默认 512；越大越清晰、文件越大',
        defaultValue: 512,
      },
      background: {
        type: 'string',
        required: false,
        label: '背景色',
        description: 'GIF 背景色，默认白色；填 transparent 保留透明',
        defaultValue: '#ffffff',
      },
    },
    outputs: {
      gifUrl: { type: 'image', label: '循环 GIF', description: '可直接预览/下载的循环动图' },
      frameUrls: { type: 'array', label: '九帧图片', description: '按选择顺序切出的帧图片地址' },
      frameCount: { type: 'number', label: '帧数', description: '最终 GIF 的帧数（乒乓含回程帧）' },
    },
    codeSchema: `async function run(inputs) {
  // 服务端用 sharp 切帧 + cgif 编码；不依赖浏览器端 gifshot
  const result = await createGridGif(inputs.imageUrl, {
    grid: inputs.grid ?? '3×3（9帧）',
    delayMs: inputs.delayMs ?? 150,
    mode: inputs.mode ?? 'normal',
    frames: inputs.frames ?? '1-9',
    trimPercent: inputs.trimPercent ?? 1,
    maxSize: inputs.maxSize ?? 512,
    background: inputs.background ?? '#ffffff',
  })
  return {
    gifUrl: result.gifUrl,
    frameUrls: result.frameUrls,
    frameCount: result.frameCount,
  }
}`,
  },
  {
    type: 'condition-check',
    label: '条件判断',
    category: 'logic',
    description: '根据条件对数据进行分支判断',
    inputs: {
      value: { type: 'string', required: true, label: '输入值', description: '待判断的值' },
      operator: { type: 'string', required: true, label: '运算符', description: '比较运算符: equals, contains, greaterThan, lessThan' },
      compareTo: { type: 'string', required: true, label: '比较值', description: '与输入值比较的目标值' },
    },
    outputs: {
      result: { type: 'boolean', label: '判断结果', description: 'true 或 false，供下游判断' },
    },
    codeSchema: `async function run(inputs) {
  let result = false
  switch (inputs.operator) {
    case 'equals': result = inputs.value === inputs.compareTo; break
    case 'contains': result = inputs.value.includes(inputs.compareTo); break
    case 'greaterThan': result = Number(inputs.value) > Number(inputs.compareTo); break
    case 'lessThan': result = Number(inputs.value) < Number(inputs.compareTo); break
  }
  return { result }
}`,
  },
  {
    type: 'text-concat',
    label: '文本拼接',
    category: 'data',
    description: '将多段文本按分隔符拼接成一段',
    inputs: {
      textA: { type: 'string', required: true, label: '文本 A', description: '第一段文本' },
      textB: { type: 'string', required: true, label: '文本 B', description: '第二段文本' },
      separator: { type: 'string', required: false, label: '分隔符', defaultValue: '\n', description: '拼接分隔符，默认换行' },
    },
    outputs: {
      result: { type: 'string', label: '拼接结果', description: '拼接后的完整文本' },
    },
    codeSchema: `async function run(inputs) {
  const sep = inputs.separator ?? '\\n'
  return { result: [inputs.textA, inputs.textB].filter(Boolean).join(sep) }
}`,
  },
  {
    type: 'number-calc',
    label: '数值计算',
    category: 'data',
    description: '对两个数值进行加减乘除运算',
    inputs: {
      a: { type: 'number', required: true, label: '数值 A', defaultValue: 0, description: '第一个操作数' },
      b: { type: 'number', required: true, label: '数值 B', defaultValue: 0, description: '第二个操作数' },
      operator: { type: 'string', required: true, label: '运算符', description: 'add/subtract/multiply/divide' },
    },
    outputs: {
      result: { type: 'number', label: '计算结果', description: '运算结果' },
    },
    codeSchema: `async function run(inputs) {
  const a = Number(inputs.a) || 0
  const b = Number(inputs.b) || 0
  let result = 0
  switch (inputs.operator) {
    case 'add': result = a + b; break
    case 'subtract': result = a - b; break
    case 'multiply': result = a * b; break
    case 'divide': result = b === 0 ? 0 : a / b; break
  }
  return { result }
}`,
  },
  {
    type: 'text-input',
    label: '文本输入',
    category: 'io',
    description: '输入一段文本（支持多行），作为工作流的文本源',
    inputs: {
      content: { type: 'string', required: true, label: '文本内容', defaultValue: '', description: '多行文本' },
    },
    outputs: {
      text: { type: 'string', label: '文本', description: '输入的文本内容' },
    },
    codeSchema: `async function run(inputs) {
  return { text: String(inputs.content ?? '') }
}`,
  },
  {
    type: 'json-parser',
    label: 'JSON 解析',
    category: 'data',
    description: '解析 JSON 数组字符串,输出数组和长度,供 array-expand 扇出逐项处理',
    inputs: {
      jsonInput: { type: 'string', required: true, label: 'JSON 字符串', description: 'JSON 数组字符串,如 [{...},{...}]' },
    },
    outputs: {
      items: { type: 'array', label: '数组', description: '解析后的数组' },
      itemCount: { type: 'number', label: '数组长度', description: '数组元素个数' },
    },
    codeSchema: `async function run(inputs) {
  const raw = String(inputs.jsonInput ?? '').trim()
  if (!raw) return { items: [], itemCount: 0 }
  let parsed = []
  try {
    const data = JSON.parse(raw)
    if (Array.isArray(data)) {
      parsed = data
    } else if (data && typeof data === 'object') {
      // 万能解析:找对象中最长的数组属性(不管叫 items/data/results/images...)
      let bestKey = null
      let bestLen = 0
      for (const k of Object.keys(data)) {
        if (Array.isArray(data[k]) && data[k].length > bestLen) {
          bestKey = k
          bestLen = data[k].length
        }
      }
      parsed = bestKey ? data[bestKey] : [data]
    } else {
      parsed = [data]
    }
  } catch {
    // JSON 解析失败时按换行拆分
    parsed = raw.split('\\n').filter((l) => l.trim())
  }
  return { items: parsed, itemCount: parsed.length }
}`,
  },
  {
    type: 'number-input',
    label: '数值输入',
    category: 'io',
    description: '输入一个数值，作为工作流的数值源',
    inputs: {
      value: { type: 'number', required: true, label: '数值', defaultValue: 0, description: '数值' },
    },
    outputs: {
      value: { type: 'number', label: '数值', description: '输入的数值' },
    },
    codeSchema: `async function run(inputs) {
  return { value: Number(inputs.value) || 0 }
}`,
  },
  {
    type: 'field-extractor',
    label: '字段提取',
    category: 'data',
    description: '从对象数组中提取指定字段,输出纯值数组(如提取所有 prompt)',
    inputs: {
      items: { type: 'array', required: true, label: '对象数组', description: '要提取的数组' },
      field: { type: 'string', required: true, label: '字段名', defaultValue: 'prompt', description: '要提取的字段 key' },
    },
    outputs: {
      values: { type: 'array', label: '值数组', description: '提取出的字段值数组' },
      count: { type: 'number', label: '数量', description: '提取出的值个数' },
    },
    codeSchema: `async function run(inputs) {
  const items = Array.isArray(inputs.items) ? inputs.items : []
  const field = String(inputs.field ?? 'prompt')
  const values = items.map((item) => {
    if (item && typeof item === 'object' && field in item) return item[field]
    return item
  })
  return { values, count: values.length }
}`,
  },
  {
    type: 'json-prompt-batch',
    label: '批量提示词',
    category: 'data',
    description: '解析 JSON 中 N 套 prompt 语块;连接一个下游节点后自动展开成 N 份逐个处理',
    inputs: {
      json: { type: 'string', required: true, label: 'JSON 文本', description: '含多套语块的 JSON,如 [{prompt},{prompt}] 或 {items:[{prompt}]}' },
      field: { type: 'string', required: false, label: '提取字段', defaultValue: 'prompt', description: '从每个语块提取的字段名' },
      outputMode: {
        type: 'string',
        required: false,
        label: '扇出方式',
        defaultValue: 'expand',
        description: "'expand'=自动克隆下游节点 N 份（默认）；'index'=下游已静态排布好 N 个节点，各按连线序号取第 i 套语块，不再克隆",
      },
    },
    outputs: {
      prompts: { type: 'array', label: '提示词数组', description: '每套语块提取出的字段值数组' },
      count: { type: 'number', label: '语块数量', description: '语块个数 N' },
    },
    codeSchema: `async function run(inputs) {
  const raw = String(inputs.json ?? '').trim()
  const field = String(inputs.field ?? 'prompt')
  if (!raw) return { prompts: [], count: 0 }
  let parsed = []
  try {
    const data = JSON.parse(raw)
    if (Array.isArray(data)) {
      parsed = data
    } else if (data && typeof data === 'object') {
      // 万能解析:找对象中最长的数组属性(不管叫 items/data/results/images...)
      let bestKey = null
      let bestLen = 0
      for (const k of Object.keys(data)) {
        if (Array.isArray(data[k]) && data[k].length > bestLen) {
          bestKey = k
          bestLen = data[k].length
        }
      }
      parsed = bestKey ? data[bestKey] : [data]
    } else {
      parsed = [data]
    }
  } catch {
    // JSON 解析失败时按换行拆分
    parsed = raw.split('\\n').filter((l) => l.trim())
  }
  const prompts = parsed.map((item) => {
    if (item && typeof item === 'object' && field in item) return item[field]
    return item
  })
  return { prompts, count: prompts.length }
}`,
  },
  {
    type: 'text-preview',
    label: '文本预览',
    category: 'io',
    description: '预览上游传入的文本内容',
    inputs: {
      text: { type: 'string', required: true, label: '文本', description: '要预览的文本' },
    },
    outputs: {
      text: { type: 'string', label: '文本', description: '原样输出的文本' },
    },
    codeSchema: `async function run(inputs) {
  return { text: String(inputs.text ?? '') }
}`,
  },
  {
    type: 'image-upload',
    label: '图片上传',
    category: 'image',
    description: '上传一张图片作为工作流的图片源(支持点击/拖拽/粘贴)',
    inputs: {
      image: { type: 'image', required: true, label: '图片', description: '上传的图片' },
    },
    outputs: {
      imageUrl: { type: 'image', label: '图片', description: '图片地址' },
    },
    codeSchema: `async function run(inputs) {
  return { imageUrl: String(inputs.image ?? '') }
}`,
  },
  {
    type: 'image-upload-batch',
    label: '图片批量上传',
    category: 'image',
    description: '上传多张图片(如 2~3 张产品原图),输出图片数组供视觉模型分析或按序扇出',
    inputs: {
      images: { type: 'array', required: false, label: '图片列表', description: '多张上传的图片(点击/拖拽/粘贴,张数不限)' },
    },
    outputs: {
      images: { type: 'array', label: '图片数组', description: '上传的全部图片地址数组' },
      count: { type: 'number', label: '图片数量', description: '上传的图片张数' },
    },
    codeSchema: `async function run(inputs) {
  const images = Array.isArray(inputs.images) ? inputs.images : []
  return { images, count: images.length }
}`,
  },
  {
    type: 'image-preview',
    label: '图片预览',
    category: 'image',
    description: '预览上游传入的图片,支持点击查看大图',
    inputs: {
      imageUrl: { type: 'image', required: true, label: '图片', description: '要预览的图片地址' },
    },
    outputs: {
      imageUrl: { type: 'image', label: '图片', description: '原样输出的图片地址' },
    },
    codeSchema: `async function run(inputs) {
  return { imageUrl: String(inputs.imageUrl ?? '') }
}`,
  },
  {
    type: 'image-crop',
    label: '图片裁切',
    category: 'image',
    description: '点击打开工作台，支持一宫格拖拽选区、四宫格/九宫格点选，实际裁切图片输出多张',
    inputs: {
      imageUrl: { type: 'image', required: true, label: '图片', description: '原图地址' },
      mode: { type: 'string', required: false, label: '裁切模式', defaultValue: 'single', description: 'single 一宫格 / grid4 四宫格 / grid9 九宫格' },
      cropRegions: { type: 'object', required: false, label: '裁切区域', description: '工作台写回的区域数组 [{x,y,width,height}]' },
    },
    outputs: {
      images: { type: 'array', label: '裁切结果', description: '裁切后的图片 URL 数组（1-9 张）' },
    },
    codeSchema: `async function run(inputs) {
  // 实际裁切由执行器调用 sharp 完成（服务端图像处理），节点代码仅透传配置
  // cropRegions 由工作台写回，mode 决定宫格模式
  return { cropRegions: inputs.cropRegions, mode: inputs.mode }
}`,
  },
  {
    type: 'face-doodle',
    label: '人脸智能涂鸦',
    category: 'image',
    description: '漫剧过脸合规：检测人脸并生成细长乱划涂鸦（遮挡但透气），支持四视图切片扫描与手动框选补漏。打开涂鸦工作台完成检测、编辑与出图',
    inputs: {
      imageUrl: { type: 'image', required: true, label: '图片', description: '待涂鸦的原图（工作台出图后写回，也可直接接上游图片）' },
      density: { type: 'string', required: false, label: '线条密度', defaultValue: '42', description: '涂鸦笔数：15/30/42/60/90' },
      strokeWidth: { type: 'string', required: false, label: '笔画粗细', defaultValue: '2.2', description: '基准笔画粗细(px)：1.0/1.5/2.2/3.5/5.0' },
      spike: { type: 'string', required: false, label: '上下飞白', defaultValue: '1.25', description: '飞白溢出系数：1.0 收束 / 1.25 自然 / 1.45 强' },
      coverage: { type: 'string', required: false, label: '遮挡缩放', defaultValue: '1.1', description: '涂鸦框相对检测框的缩放：0.9 贴合 / 1.1 微扩 / 1.3 放宽' },
      multiView: { type: 'boolean', required: false, label: '四视图切片', defaultValue: true, description: '按图片形态切片扫描（横条四视图/竖条分镜更灵敏）' },
      threshold: { type: 'string', required: false, label: '灵敏度', defaultValue: '0.18', description: '检测阈值：0.08 高灵敏 / 0.18 均衡 / 0.3 保守' },
      autoFallback: { type: 'boolean', required: false, label: '背影补框', defaultValue: true, description: '横长图缺列时按列推算兜底框（宁可多涂不可漏涂）' },
      faces: { type: 'object', required: false, label: '涂鸦框', description: '工作台写回的框数组 [{x,y,w,h}]（原始像素坐标）' },
    },
    outputs: {
      imageUrl: { type: 'image', label: '涂鸦结果', description: '涂鸦后的图片 URL' },
    },
    codeSchema: `async function run(inputs) {
  // 检测与绘制在工作台的浏览器端完成（MediaPipe + Canvas），确认时上传结果图
  // 并写回 inputs.imageUrl；执行器只负责规范化为持久输出。
  return { imageUrl: inputs.imageUrl }
}`,
  },
  {
    type: 'video-generate',
    label: '视频生成',
    category: 'video',
    description: '调用视频模型生成视频（扣豆：视频专用额度）',
    inputs: {
      prompt: { type: 'string', required: true, label: '视频描述', description: '视频生成提示词' },
      model: { type: 'string', required: false, label: '模型选择', description: '指定使用的视频模型' },
      negativePrompt: { type: 'string', required: false, label: '负向提示词', description: '不希望出现的元素' },
      width: { type: 'number', required: false, label: '宽度', defaultValue: 1280, description: '视频宽度（像素）' },
      height: { type: 'number', required: false, label: '高度', defaultValue: 720, description: '视频高度（像素）' },
      duration: { type: 'number', required: false, label: '时长(秒)', description: '视频时长' },
      aspectRatio: { type: 'string', required: false, label: '画幅比例', description: '如 16:9 / 9:16 / 1:1' },
      resolution: { type: 'string', required: false, label: '清晰度', description: '分辨率档（如 480P / 768P / 1080P / 2K）；上游按枚举档计费/生成时用' },
      referenceImage: { type: 'image', required: false, label: '参考图片', description: '多图参考生视频，提示词中用「第一张图/第二张图」等自然语言指代' },
      referenceVideo: { type: 'video', required: false, label: '参考视频', description: '视频参考素材；提示词中用「参考视频」指代' },
      referenceAudio: { type: 'audio', required: false, label: '参考音频', description: '音频参考素材' },
      firstFrame: { type: 'image', required: false, label: '首帧图', description: '以该图作为视频首帧' },
      lastFrame: { type: 'image', required: false, label: '尾帧图', description: '以该图作为视频尾帧' },
    },
    outputs: {
      videoUrl: { type: 'video', label: '视频地址', description: '生成的视频 URL' },
      recordId: { type: 'string', label: '任务ID', description: '视频生成记录 ID（异步任务用）' },
    },
    codeSchema: `async function run(inputs) {
  const result = await generateVideo({
    prompt: inputs.prompt,
    negativePrompt: inputs.negativePrompt,
    width: inputs.width ?? 1280,
    height: inputs.height ?? 720,
    duration: inputs.duration,
    aspectRatio: inputs.aspectRatio,
    resolution: inputs.resolution,
    firstFrame: inputs.firstFrame,
    lastFrame: inputs.lastFrame,
  })
  return { videoUrl: result.videoUrl || '', recordId: result.recordId || '' }
}`,
  },
  {
    type: 'video-preview',
    label: '视频预览',
    category: 'video',
    description: '预览上游传入的视频',
    inputs: {
      videoUrl: { type: 'video', required: true, label: '视频', description: '要预览的视频地址' },
    },
    outputs: {
      videoUrl: { type: 'video', label: '视频', description: '原样输出的视频地址' },
    },
    codeSchema: `async function run(inputs) {
  return { videoUrl: String(inputs.videoUrl ?? '') }
}`,
  },
  {
    type: 'audio-generate',
    label: '音频生成',
    category: 'audio',
    description: '调用音频模型生成音乐/配音（扣积分）',
    inputs: {
      prompt: { type: 'string', required: true, label: '音频描述', description: '要合成的文本/音频内容描述' },
      model: { type: 'string', required: false, label: '模型选择', description: '指定使用的音频模型' },
      lyrics: { type: 'string', required: false, label: '歌词', description: '音乐歌词（音乐模型用，带结构标签）' },
      voiceId: { type: 'string', required: false, label: '音色', description: '配音音色 ID（配音模型用）' },
    },
    outputs: {
      audioUrl: { type: 'audio', label: '音频地址', description: '生成的音频 URL' },
      recordId: { type: 'string', label: '任务ID', description: '音频生成记录 ID（异步任务用）' },
    },
    codeSchema: `async function run(inputs) {
  const result = await generateAudio({
    prompt: inputs.prompt,
    lyrics: inputs.lyrics,
    voiceId: inputs.voiceId,
  })
  return { audioUrl: result.audioUrl || '', recordId: result.recordId || '' }
}`,
  },
  {
    type: 'audio-preview',
    label: '音频预览',
    category: 'audio',
    description: '预览上游传入的音频',
    inputs: {
      audioUrl: { type: 'audio', required: true, label: '音频', description: '要预览的音频地址' },
    },
    outputs: {
      audioUrl: { type: 'audio', label: '音频', description: '原样输出的音频地址' },
    },
    codeSchema: `async function run(inputs) {
  return { audioUrl: String(inputs.audioUrl ?? '') }
}`,
  },
  {
    type: 'sfx-generate',
    label: '音效生成',
    category: 'audio',
    description: '根据文本描述生成短音效素材（如雨声/脚步声/金属碰撞），一次出多个变体（扣积分）',
    inputs: {
      prompt: { type: 'string', required: true, label: '音效描述', description: '描述想要的音效，如「大雨落在金属屋顶」' },
      model: { type: 'string', required: false, label: '音效模型', description: '指定使用的音效生成模型' },
      duration: { type: 'number', required: false, label: '时长(秒)', description: '固定时长 1-10 秒，留空由模型自动决定' },
    },
    outputs: {
      audioUrl: { type: 'audio', label: '音效地址', description: '生成的音效 URL（取第一个成功变体）' },
      audioUrls: { type: 'array', label: '全部变体', description: '本次生成的全部音效变体地址' },
    },
    codeSchema: `async function run(inputs) {
  const result = await generateSfx({ prompt: inputs.prompt, duration: inputs.duration })
  return { audioUrl: result.audioUrl || '', audioUrls: result.audioUrls || [] }
}`,
  },
  {
    type: 'voice-isolate',
    label: '人声分离',
    category: 'audio',
    description: '从音频中提取人声轨道（卡拉OK/再配音场景），按秒扣积分',
    inputs: {
      media: { type: 'audio', required: true, label: '音频', description: '待分离的音频（节点内上传或接上游音频）' },
      model: { type: 'string', required: false, label: '分离模型', description: '指定使用的人声分离模型' },
    },
    outputs: {
      audioUrl: { type: 'audio', label: '人声音轨', description: '分离出的人声音频 URL' },
    },
    codeSchema: `async function run(inputs) {
  const url = await isolateVoice({ media: inputs.media, model: inputs.model })
  return { audioUrl: url || '' }
}`,
  },
  {
    type: 'music-generate',
    label: '音乐生成',
    category: 'audio',
    description: '调用音乐模型根据歌词/风格生成歌曲（扣积分）',
    inputs: {
      prompt: { type: 'string', required: true, label: '风格描述', description: '音乐风格/情绪/场景描述' },
      model: { type: 'string', required: false, label: '音乐模型', description: '指定使用的音乐生成模型' },
      lyrics: { type: 'string', required: false, label: '歌词', description: '歌词，支持 [Verse]/[Chorus] 结构标签' },
    },
    outputs: {
      audioUrl: { type: 'audio', label: '音频地址', description: '生成的音频 URL' },
      recordId: { type: 'string', label: '任务ID', description: '音频生成记录 ID（异步任务用）' },
    },
    codeSchema: `async function run(inputs) {
  const result = await generateAudio({ prompt: inputs.prompt, lyrics: inputs.lyrics })
  return { audioUrl: result.audioUrl || '', recordId: result.recordId || '' }
}`,
  },
  {
    type: 'tts-generate',
    label: '配音生成',
    category: 'audio',
    description: '调用语音合成(TTS)模型将文本转语音（扣积分）',
    inputs: {
      prompt: { type: 'string', required: true, label: '配音文本', description: '要合成语音的文本' },
      model: { type: 'string', required: false, label: '配音模型', description: '指定使用的语音合成模型' },
      voiceId: { type: 'string', required: false, label: '音色', description: '配音音色 ID' },
    },
    outputs: {
      audioUrl: { type: 'audio', label: '音频地址', description: '生成的音频 URL' },
      recordId: { type: 'string', label: '任务ID', description: '音频生成记录 ID（异步任务用）' },
    },
    codeSchema: `async function run(inputs) {
  const result = await generateAudio({ prompt: inputs.prompt, voiceId: inputs.voiceId })
  return { audioUrl: result.audioUrl || '', recordId: result.recordId || '' }
}`,
  },
  {
    type: 'transcribe',
    label: '语音识别',
    category: 'audio',
    description: '将音频转成文字(ASR)，按次扣积分',
    inputs: {
      media: { type: 'audio', required: true, label: '音频', description: '待识别的音频文件（节点内上传或接素材库音频）' },
      model: { type: 'string', required: false, label: '识别模型', description: '指定使用的 ASR 模型' },
    },
    outputs: {
      text: { type: 'string', label: '识别文本', description: '音频转录出的文字' },
    },
    codeSchema: `async function run(inputs) {
  const text = await runPerception({ media: inputs.media, model: inputs.model || '' })
  return { text }
}`,
  },
  {
    type: 'ocr',
    label: '文字识别',
    category: 'io',
    description: '识别图片/文档中的文字(OCR)，按次扣积分',
    inputs: {
      media: { type: 'image', required: true, label: '图片', description: '待识别的图片（节点内上传或接素材库图片）' },
      model: { type: 'string', required: false, label: '识别模型', description: '指定使用的 OCR 模型' },
    },
    outputs: {
      text: { type: 'string', label: '识别文本', description: '从图片识别出的文字' },
    },
    codeSchema: `async function run(inputs) {
  const text = await runPerception({ media: inputs.media, model: inputs.model || '' })
  return { text }
}`,
  },
  {
    type: 'audio-upload',
    label: '语音上传',
    category: 'audio',
    description: '本地上传音频或实时录音，供语音识别(ASR)、人声分离等下游节点使用',
    inputs: {
      audio: { type: 'audio', required: true, label: '音频', description: '上传的音频（本地上传或实时录音），透传给下游' },
    },
    outputs: {
      audio: { type: 'audio', label: '音频', description: '原样输出的音频地址（供下游 ASR/人声分离/预览节点接线）' },
    },
    codeSchema: `async function run(inputs) {
  return { audio: String(inputs.audio ?? '') }
}`,
  },
  {
    type: 'video-upload',
    label: '视频上传',
    category: 'video',
    description: '本地上传视频，供「参考视频」等下游节点使用（部分视频模型支持视频参考）',
    inputs: {
      video: { type: 'video', required: true, label: '视频', description: '上传的视频文件，透传给下游' },
    },
    outputs: {
      video: { type: 'video', label: '视频', description: '原样输出的视频地址（供下游视频生成/预览节点接线）' },
    },
    codeSchema: `async function run(inputs) {
  return { video: String(inputs.video ?? '') }
}`,
  },
] as const

export type BuiltInNodeType = (typeof BUILTIN_NODES)[number]['type']

export function getNodeDefinition(type: string): NodeDefinition | undefined {
  return BUILTIN_NODES.find((n) => n.type === type)
}

export function getNodesByCategory(): Record<string, NodeDefinition[]> {
  return BUILTIN_NODES.reduce(
    (acc, node) => {
      if (!acc[node.category]) acc[node.category] = []
      acc[node.category].push(node)
      return acc
    },
    {} as Record<string, NodeDefinition[]>
  )
}
