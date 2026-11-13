/**
 * 九宫格循环帧提示词构造（纯函数）。
 *
 * 为什么单独抽出来：
 *   「九宫格连续帧」的效果几乎完全由提示词的**约束密度**决定 —— 3×3 布局、
 *   每格机位一致、角色锁形、九帧顺序、第 9 帧回到第 1 帧、无多余文字。
 *   这些约束如果散落在节点执行器里，后续任何一处调整（比如增加「第 9 帧必须
 *   与第 1 帧完全一致」）都得改执行器，而且工具快照里的旧提示词不会跟着变。
 *
 * 所以把它做成**唯一入口**：画布节点、工具页、面板预览都调同一个函数。
 * 节点执行器只负责把结构化输入传进来，不再自己拼中文提示词。
 */

/** 默认画风：偏 Q 版平涂，适合角色循环帧；用户可覆盖。 */
export const NINE_GRID_LOOP_DEFAULT_STYLE =
  'Q版二次元平涂风格，绒毛质感蓬松柔软，线条圆润干净，色彩清新柔和，角色边缘清晰'

/**
 * 默认负向提示词。
 *
 * 注意**不能**写通用的「文字」：这类分镜经常要求屏幕/标牌上出现指定文案
 * （例如「深度思考中」），一刀切否定「文字」会把用户要的内容也压掉。
 * 这里只否定「标题、序号、水印、格间说明」这类装饰性文字。
 */
export const NINE_GRID_LOOP_DEFAULT_NEGATIVE_PROMPT =
  '水印, 参考图上的文字, 标题, 序号标注, 格间说明文字, 多余肢体, 角色变形, 比例不一致, 画面裁切'

export interface NineGridLoopPromptInput {
  /** 角色外观锁定描述 */
  character?: string
  /** 场景、机位、必须始终可见的元素 */
  scene?: string
  /** 动作脚本：每行一帧，可带 1. / 1、/ 1) 等序号 */
  actions?: string
  /** 画风；留空使用默认值 */
  style?: string
  /** 3 = 3×3 九帧；4 = 4×4 十六帧；默认 3 */
  grid?: unknown
  /** 自由描述模式：没有结构化小节时，直接按这段创作描述生成 */
  brief?: string
  /** grid = 宫格图；native-gif = 模型直接生成 GIF（不排宫格） */
  outputMode?: unknown
}

export type GridOutputMode = 'grid' | 'native-gif'

export function normalizeOutputMode(raw: unknown): GridOutputMode {
  const text = String(raw ?? '').trim().toLowerCase()
  if (/原生|native|直接生成|animated\s*gif/.test(text)) return 'native-gif'
  if (/\bgif\b/.test(text) && !/宫格|grid|3\s*[x×*]\s*3|4\s*[x×*]\s*4/.test(text)) return 'native-gif'
  return 'grid'
}

export type GridSize = 3 | 4

/**
 * 宫格规格归一化。
 * 接受 3 / 4 / '3×3' / '4×4' / '9帧' / '16帧' / '4x4（16帧）' 等写法。
 * 无法识别时回落 3×3，保持老节点/老工具的行为不变。
 */
export function normalizeGrid(raw: unknown): GridSize {
  const text = String(raw ?? '').trim().toLowerCase()
  if (!text) return 3
  if (/4\s*[x×*]\s*4/.test(text) || /十六|16\s*帧/.test(text) || /^16$/.test(text)) return 4
  if (/3\s*[x×*]\s*3/.test(text) || /九宫|9\s*帧/.test(text) || /^9$/.test(text)) return 3
  if (/^4$/.test(text) || /\b4\b/.test(text)) return 4
  return 3
}

export function gridFrameCount(grid: GridSize): number {
  return grid * grid
}

export function gridDisplayName(grid: GridSize): string {
  return grid === 4 ? '十六宫格' : '九宫格'
}

export interface NineGridScriptSections {
  character: string
  scene: string
  actions: string
  style: string
}

/**
 * 分镜脚本的四个小节头。
 *
 * 顺序有讲究：更长的词放前面，避免「角色外观」被「角色」截胡。
 */
const SCRIPT_SECTION_KINDS: Array<{ kind: keyof NineGridScriptSections; re: RegExp }> = [
  { kind: 'character', re: /^\s*[【\[]\s*(角色外观|角色|人物|主体)\s*[】\]]\s*/ },
  { kind: 'scene', re: /^\s*[【\[]\s*(场景与镜头|场景|镜头|画面)\s*[】\]]\s*/ },
  { kind: 'actions', re: /^\s*[【\[]\s*(九帧动作|动作|分镜)\s*[】\]]\s*/ },
  { kind: 'style', re: /^\s*[【\[]\s*(画风|风格)\s*[】\]]\s*/ },
  { kind: 'character', re: /^\s*(角色外观|角色|人物|主体)\s*[:：]\s*/ },
  { kind: 'scene', re: /^\s*(场景与镜头|场景|镜头|画面)\s*[:：]\s*/ },
  { kind: 'actions', re: /^\s*(九帧动作|动作|分镜)\s*[:：]\s*/ },
  { kind: 'style', re: /^\s*(画风|风格)\s*[:：]\s*/ },
]

function scriptSectionOf(line: string): { kind: keyof NineGridScriptSections; rest: string } | null {
  for (const entry of SCRIPT_SECTION_KINDS) {
    const match = entry.re.exec(line)
    if (match) return { kind: entry.kind, rest: line.slice(match[0].length).trim() }
  }
  return null
}

/**
 * 解析「单文本框分镜脚本」。
 *
 * 统一格式（工具页 / 节点面板只有一个输入框）：
 *   【角色】角色外观描述
 *   【场景】机位、构图与必须始终可见的元素
 *   【动作】
 *   1. 第一帧
 *   …
 *   9. 第九帧
 *   【画风】整体画风（可省略，缺省用默认值）
 *
 * 容忍：小节头写成 `角色：xxx`、同一行带内容、动作小节里的编号。
 * 不在这里做校验 —— 缺什么由 buildNineGridLoopPrompt 统一报。
 * 没有小节头的行直接忽略：用户把旧版整段提示词粘进来时，
 * 【角色】之前的说明文字不会误当成角色描述。
 */
export function parseNineGridScript(raw: string): NineGridScriptSections {
  const sections: NineGridScriptSections = { character: '', scene: '', actions: '', style: '' }
  const append = (kind: keyof NineGridScriptSections, text: string) => {
    sections[kind] = sections[kind] ? `${sections[kind]}\n${text}` : text
  }
  let current: keyof NineGridScriptSections | null = null
  for (const line of String(raw || '').split(/\r?\n/)) {
    const section = scriptSectionOf(line)
    if (section) {
      current = section.kind
      if (section.rest) append(section.kind, section.rest)
      continue
    }
    const trimmed = line.trim()
    // LLM 输出常用 ``` 包一层；它不是内容，混进角色/动作会污染提示词。
    if (!trimmed || !current || /^```/.test(trimmed)) continue
    append(current, trimmed)
  }
  return sections
}

/**
 * 结构化字段 → 单文本框脚本。seed 脚本、画布预设、面板占位示例共用，
 * 保证「生成端」和「编辑端」看到同一个格式。
 */
export function buildNineGridScript(input: NineGridLoopPromptInput): string {
  return [
    `【角色】${String(input.character || '').trim()}`,
    `【场景】${String(input.scene || '').trim()}`,
    '【动作】',
    String(input.actions || '').trim(),
    `【画风】${String(input.style || '').trim() || NINE_GRID_LOOP_DEFAULT_STYLE}`,
  ].join('\n')
}

/**
 * 把「九帧动作」文本拆成 9 条。
 *
 * 容忍作者常见的三种写法：
 *   1. 动作描述
 *   1、动作描述
 *   - 动作描述
 * 编号会被剥掉（提示词里会重新按 1..9 编号，避免出现「1. 1. xxx」）。
 * 空行自动忽略；不校验数量 —— 校验放在 build 里，面板可以先实时显示 8/9。
 */
export function splitNineGridActions(raw: string): string[] {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line
        // 「1. 」「1、」「1．」「1)」「1）」「1：」「1:」「第1帧：」等
        .replace(/^\s*(?:第\s*\d+\s*(?:帧|格)?\s*[.、．)）:：]\s*|\d+\s*[.、．)）:：]\s*|[-*•]\s*)/, '')
        .trim(),
    )
    .filter(Boolean)
}

/**
 * 构造九宫格循环帧的完整提示词。
 *
 * 抛错是刻意的：缺角色/场景/动作时，宁可让用户看到明确的中文提示，
 * 也不要让模型自由发挥出一张「九宫格但每格不是同一个角色」的废图。
 */
export function buildNineGridLoopPrompt(input: NineGridLoopPromptInput): string {
  const grid = normalizeGrid(input.grid)
  const frameCount = gridFrameCount(grid)
  const character = String(input.character || '').trim()
  const scene = String(input.scene || '').trim()
  const style = String(input.style || '').trim() || NINE_GRID_LOOP_DEFAULT_STYLE
  const actions = splitNineGridActions(input.actions ?? '')
  const brief = String(input.brief || '').trim()
  const layout = `${grid}×${grid}`
  const gridName = gridDisplayName(grid)

  // 自由描述模式：没有结构化小节（AI 关闭 / 用户只写了一段描述）时，
  // 由模型自己设计帧序列；约束仍然固定，避免退化成普通拼图。
  if (brief && !character && !scene && actions.length === 0) {
    return `生成一张 ${layout} 排列的${gridName}连续帧图，每格机位、构图、角色比例完全一致，用于后期合成无缝循环动图。

【创作描述】严格按以下描述创作，并以第一张参考图锁定角色外形，参考图上的文字、水印、边框不进入画面：
${brief}

【帧数与顺序】共 ${frameCount} 帧，按从左到右、从上到下排列，形成一段连续、连贯的动作。

【首尾衔接】第 ${frameCount} 帧必须回到与第 1 帧完全一致的姿势、表情、四肢与配饰位置，实现首尾无缝衔接。

【画面规范】${gridName}之间只保留极细分隔线，每格尺寸一致，主体位置稳定，主体始终位于画面安全区域。除创作描述中明确要求的屏幕/标牌文字外，画面内不要出现标题、序号、说明文字或水印。

【画风】${style}。线条圆润干净，色彩清新柔和，角色边缘清晰。`
  }

  if (!character) throw new Error('请填写「角色外观」：锁定角色外形，避免每格角色漂移')
  if (!scene) throw new Error('请填写「场景与镜头」：说明机位、构图和必须始终可见的元素')
  if (actions.length !== frameCount) {
    throw new Error(`${layout} 需要正好 ${frameCount} 行动作（当前 ${actions.length} 行），每行描述一帧`)
  }

  const actionBlock = actions.map((action, index) => `${index + 1}. ${action}`).join('\n')

  return `生成一张 ${layout} 排列的${gridName}连续帧图，每格机位、构图、角色比例完全一致，用于后期合成无缝循环动图。

【角色锁定】严格以第一张参考图为角色外形基准，全程保持毛色、五官、身形、四肢与配饰统一：${character}。参考图上的文字、水印、边框不进入画面。

【场景与镜头】${scene}。每格都完整看清角色正脸与场景中的关键道具，主体始终位于画面安全区域。

【${frameCount} 帧动作】${gridName}按从左到右、从上到下的顺序呈现连续动作：
${actionBlock}

【首尾衔接】第 ${frameCount} 帧必须回到与第 1 帧完全一致的姿势、表情、四肢与配饰位置，实现首尾无缝衔接。

【画面规范】${gridName}之间只保留极细分隔线，每格尺寸一致，主体位置稳定，动作连贯流畅。除场景设定中明确要求的屏幕/标牌文字外，画面内不要出现标题、序号、说明文字或水印。

【画风】${style}。线条圆润干净，色彩清新柔和，角色边缘清晰。`
}

/** 是否是 GIF 地址（站内 hash 文件名 / 外链 / 带查询参数都兼容） */
export function isGifImageUrl(url: unknown): boolean {
  return /\.gif(?:$|[?#])/i.test(String(url ?? ''))
}

/**
 * 原生 GIF 提示词：支持动图的模型可直接产出 animated GIF，
 * 不再要求九宫格排版，也不需要前端/服务端二次切帧合成。
 *
 * 这里刻意不写「每格构图」之类的宫格约束 —— 模型输出的是完整动画，
 * 约束重点是主体锁定、镜头稳定、动作连续和首尾循环。
 */
export function buildNativeGifPrompt(input: NineGridLoopPromptInput): string {
  const style = String(input.style || '').trim() || NINE_GRID_LOOP_DEFAULT_STYLE
  const character = String(input.character || '').trim()
  const scene = String(input.scene || '').trim()
  const actions = splitNineGridActions(input.actions ?? '')
  const brief = String(input.brief || '').trim()
  const freeform = !character && !scene && actions.length === 0

  if (freeform && !brief) {
    throw new Error('原生 GIF 需要一段创作描述：说明角色、场景和想看到的动作')
  }
  if (!freeform) {
    if (!character) throw new Error('请填写「角色外观」：锁定主体外形，避免动画中角色漂移')
    if (!scene) throw new Error('请填写「场景与镜头」：说明机位、构图与始终可见的元素')
    if (actions.length < 2) {
      throw new Error('原生 GIF 至少需要 2 段连续动作描述（建议 8-12 段），才能形成完整动画')
    }
  }

  const head = `生成一段无缝循环的 GIF 动画（animated GIF 文件：会动、循环播放；不要输出九宫格/分镜拼图，也不要只输出静态单帧）。

【输出格式】animated GIF，循环播放；不要九宫格排版，不要标题、序号、说明文字或水印（创作描述明确要求的屏幕/标牌文案除外）。`

  if (freeform) {
    return `${head}

【创作描述】严格按以下描述创作，并以第一张参考图锁定主体外形，参考图上的文字、水印、边框不进入画面：
${brief}

【动作与循环】把描述中的动作做成一段连续、平滑的动画；镜头固定，背景与光照保持一致，主体始终位于画面安全区域；结尾自然接回开头，循环播放时不跳变、不停顿。

【画风】${style}。`
  }

  const actionBlock = actions.map((action, index) => `${index + 1}. ${action}`).join('\n')
  return `${head}

【主体锁定】严格以第一张参考图为主体外形基准，全程保持一致：${character}。参考图上的文字、水印、边框不进入画面。

【场景与镜头】${scene}。镜头固定，背景与光照保持一致，主体始终位于画面安全区域。

【动作顺序】把下面的动作做成一段平滑动画（这些是动作关键节点，请补足中间过渡）：
${actionBlock}

【循环】动画结尾自然接回开头，循环播放时不跳变、不停顿。

【画风】${style}。`
}
