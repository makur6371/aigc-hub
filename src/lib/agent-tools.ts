// Agent 动作层：工具定义（function calling）
//
// ===== 为什么需要这一层 =====
// 旧架构是「单次规划」：一次 LLM 调用必须吐出一个完整大 JSON（intent/reply/
// decisions/foundation/deliverables[]）。实测（2026-09-29 训练循环）暴露 4 类静默失败，
// 全都是这个「一次吐大 JSON」形状导致的：
//   1) 空响应 → 静默降级成对话，任务假成功、零交付物
//   2) 输出被 max_tokens 截断 → 同上
//   3) 模型嘴上说「已规划 N 张」却给空 deliverables → 用户白等
//   4) model 字段填显示名而非 id → 全部子任务报「无可用模型」
//
// 改成「小步动作」后：每轮只输出一个 tool_call（JSON 很小，不会截断），
// 「提问」「查模型」「出图」变成**真实动作**而非文本约定，
// 且天然支持「生成完看一眼 → 不满意再生成一次」的循环。
//
// ===== 设计边界（刻意不做） =====
// 我们业务只需要：出图（含图生图）、缺参就问、多轮接着改。
// 所以工具就 5 个，全是业务动作，执行体全部复用现有 charge-run + 排队 + mock。

import type { AdapterToolSpec } from '@/types'

/** 工具名常量（避免各处硬编码字符串拼错） */
export const TOOL = {
  askUser: 'ask_user',
  listModels: 'list_models',
  generateImage: 'generate_image',
  generateVideo: 'generate_video',
  finish: 'finish',
} as const

/**
 * 下发给模型的工具清单。
 *
 * 注意：schema 描述要**具体**（什么时候该调用它），因为模型完全靠这段文字决定行为。
 * 写成空泛的「生成图片」会导致模型乱调；写清「参数不全时先 ask_user」才会稳定。
 */
export const AGENT_TOOL_SPECS: AdapterToolSpec[] = [
  {
    type: 'function',
    function: {
      name: TOOL.listModels,
      description:
        '查询平台当前可用的生成模型及其能力（支持的比例、档位、是否免费、是否支持参考图）。' +
        '在决定用哪个模型、或需要确认某比例/档位是否被支持时调用。不要凭记忆编造模型 id。',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['image', 'video', 'audio', 'text'],
            description: '要查询的模型类型；省略则返回全部类型',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL.askUser,
      description:
        '当关键参数缺失、无法继续时才调用：把要问的问题一次性列出来，然后结束本轮等用户回答。' +
        '参数（模型/比例/档位/张数/语言/产品信息等）若能从用户全局偏好或本轮需求推断，就不要问。' +
        '闲聊、答谢、一般性咨询不要调用本工具，直接用文字回复即可。',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: '要问的问题列表，按重要性排序，一次问完（最多 4 个）',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: '问题本身，简洁明确' },
                options: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '可选项（如 ["A. 白底主图","B. 场景图"]）；有明确选项时给出，便于用户一键回复',
                },
              },
              required: ['question'],
            },
          },
          reason: { type: 'string', description: '为什么必须问这些（一句话，用于内部记录）' },
        },
        required: ['questions'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL.generateImage,
      description:
        '发起图片生成，任务进入成果区排队（与工具箱操作面板同一套排队/计费）。' +
        '参数齐全时直接调用；一次只描述一个画面方向，需要多张不同方向就多次调用本工具。' +
        '用户上传了产品图且要基于它生成时，必须把图片编号填进 assetIds（走图生图），' +
        '并且**不要在 prompt 里复述图上的颜色/材质/外观**（模型能看图，复述反而会与实物不一致）。' +
        '【硬性约束】assetIds 只能填编号（如 图片1 / 素材2），由系统解析成公网 URL 交给上游；' +
        '绝不自己拼 URL，更绝不把图片转成 Base64 / data:image 塞进任何参数 —— 上游只接受公网 URL，' +
        '传 Base64 会直接失败或把请求撑爆。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '画面描述：只写构图、场景、风格、光线、要展示的卖点' },
          title: { type: 'string', description: '这一张的短标题（用于成果区展示，如「细节特写」）' },
          model: { type: 'string', description: '模型 id（必须来自 list_models 返回的 id 字段）' },
          ratio: { type: 'string', description: '画面比例，如 1:1 / 3:4 / 16:9' },
          tier: { type: 'string', description: '清晰度档位：1K / 2K / 4K' },
          count: { type: 'integer', description: '生成张数（同一提示词），默认 1，最大 8' },
          assetIds: {
            type: 'array',
            items: { type: 'string' },
            description:
              '参考图编号：["图片1"] 引用本会话上传图，["素材2"] 引用本会话已生成的图（二次编辑/继续改时用）；无参考图则省略。' +
              '只能填编号，不要填 URL，更不要填 Base64/data:image —— 系统会自动把编号解析成公网 URL。' +
              '引用「素材N」（本会话已生成的图）做修改时，prompt 要写成对原图的原位编辑（保留背景/构图/文字），只改用户指出的部分。',
          },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL.generateVideo,
      description:
        '发起视频生成，任务进入成果区排队。用户给了参考图且要基于它生成时，把图片编号填进 assetIds' +
        '（会作为首帧图传给上游，实现图生视频）。' +
        '【硬性约束】assetIds 只能填编号，由系统解析成公网 URL；不要填 URL，更不要填 Base64/data:image。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '视频画面描述：运镜、场景、氛围' },
          title: { type: 'string', description: '短标题' },
          model: { type: 'string', description: '模型 id（必须来自 list_models 返回的 id 字段）' },
          ratio: { type: 'string', description: '画面比例' },
          resolution: { type: 'string', description: '清晰度档：480P / 720P / 768P / 1080P / 2K（须来自 list_models 该模型支持的档位）' },
          seconds: { type: 'integer', description: '时长（秒）' },
          assetIds: {
            type: 'array',
            items: { type: 'string' },
            description: '参考图编号，如 ["图片1"]。只能填编号，不要填 URL / Base64 —— 系统会解析成公网 URL。',
          },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL.finish,
      description:
        '所有生成任务都派发完毕、或本轮只需文字回复时调用，结束本次交互。' +
        'summary 是给用户看的最终回复（说清做了什么、用了什么参数、结果在哪）。必须调用它来收尾。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '给用户的最终回复' },
          decisions: {
            type: 'array',
            description: '关键决策记录（模型/比例/档位等），用于前端展示',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                value: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['label', 'value', 'reason'],
            },
          },
        },
        required: ['summary'],
      },
    },
  },
]
// Agent 动作层（第 2 期）：系统提示词 + 工具参数容错
//
// 与旧 buildAgentPlannerSystemPrompt 的区别：旧提示词要求模型「一次输出完整计划 JSON」，
// 长且脆（大 JSON 截断 = 静默失败）。这里改成「按轮行动」：每轮一个 tool_call，
// 提示词也相应变短、变行为导向。原则（用户要求）：文字精简，保证运行速度，少文字高质量。

import type { AdapterToolCall } from '@/types'
import { ORG } from '@/lib/site-content'
import { AGENT_MAX_PLANNER_TURNS, AGENT_MAX_TOOL_ACTIONS } from '@/lib/agent-budget'

/**
 * 动作层系统提示词。
 *
 * 5W 覆盖：它是谁 / 能干什么 / 怎么做 / 在哪调用 / 什么时候才执行。
 * 刻意保持精简——每轮都要重发，文字越多 token 越贵、首字越慢。
 */
export function buildAgentToolSystemPrompt(): string {
  return `你是${ORG.name}创作 Agent，负责把用户需求变成生成任务并派发。

【能力】可调用图片/视频/文本模型。模型清单用 list_models 查，不要凭记忆编造 id。
生图底层与工具箱操作面板完全一致：同模型、同比例档位映射、同排队与计费。

用户没指定编号时由你挑选最契合的一个并说明理由，不要停下来问编号。

【何时执行】参数齐全才调用 generate_image / generate_video。
优先级：本轮用户明确指定 > 用户的全局偏好 > 缺失就问。
参数（模型、比例、档位、张数、语言、产品信息等）**能从偏好或本轮需求合理推断时不要问**，
确实无法推断才调用 ask_user 一次性问清，不要反复追问。

【预算与返工纪律】
- 单次 run 最多 ${AGENT_MAX_PLANNER_TURNS} 轮规划、${AGENT_MAX_TOOL_ACTIONS} 个执行动作。
  能一轮并发的多个镜头/多张图，就在同一轮发多个工具调用；不要拆成很多空转轮次。
- 同一动作因上游波动失败，最多换一次参数或模型；不要用相同参数连续重试，也不要换业务编号绕开失败。
- 长视频按镜头分别生成，每镜必须符合 list_models 返回的时长/清晰度/比例；
  总时长只是各镜秒数之和，不能把一个 5 秒模型写成“生成 30 秒单镜”。

【会话素材（跨轮指代靠它）】
context.sessionAssets 列出的编号就是本会话已有的图，可以直接引用：
- 图片N = 用户在本会话上传的第 N 张
- 素材N = 本会话已生成的第 N 张
用户说「第 3 张重做」「基于刚才那张改」「沿用上次的参考图」时，从这里的编号定位，不要反问用户。

⚠️【只能引用清单里真实存在的编号】这是硬约束：
- context.sessionAssets 里**没有**的编号，一律不许引用、不许推测、不许自己编号。
- 用户说了编号但清单里没有（例如说「用素材1」而清单是空的）→ 说明该图不在本会话
  （常见原因：这是新建的会话，之前的图留在上一个会话里）。此时**必须用 ask_user 说明
  并请用户重新上传**，绝不要编一个编号去调用生成 —— 编出来的编号解析不到，
  上游只会回「请上传参考图」，用户完全看不出是编号错了。
- 清单为空时同理：明确告诉用户「本会话没有可引用的图，请先上传」。

注意：这些图是上游临时链接，隔几小时到几天可能失效（**失效了就是真用不了了**，
无法恢复，也不要去尝试修复）；用户若要长期保留，提示其尽快下载。

【怎么执行】
- 一张图 = 一次 generate_image。需要多个方向/多张不同画面就多次调用，不要在 prompt 里塞「同时展示 4 个角度」。
- 用户上传了产品图且要基于它生成：必须把编号填进 assetIds（走图生图）。
- 有参考图时**不要复述图上的颜色/材质/外观**，只写构图/场景/风格/光线/卖点（模型能看图，复述反而与实物不一致）。
- 【硬性约束】参考图一律用编号（assetIds: ["图片1"] / ["素材2"]）引用，**绝不传 URL、更绝不用 Base64 / data:image**。
  上游只接受公网 URL；Base64 会导致请求失败或体积撑爆。编号→公网 URL 由系统自动转换，你不需要也不允许插手。
- 【引用「素材N」做修改时】素材N 是本会话**已生成**的图。用户的意图通常是「在这张图上改」，
  所以提示词必须写成**在改动**，而不是重新描述整张画面：
  明确要求「保留原图的背景、构图、取景、光线、色调与既有文字排版不变」，**只改用户指出的那一部分**。
  反例（实测翻车）：用户要「把尺寸数字改成 20×9」，提示词却写「XX 图，白色简洁背景…」——
  等于让模型重画一张，结果背景和已有文字全被丢掉。
  正例：先声明「这是对参考图的原位编辑，保持场景/背景/风格/文字排版完全一致」，
  再写「仅将尺寸标注改为 20 和 9」。
  另外：若用户只是「某处不对」，改完不要顺手改动他没提的部分。
- 【视频生成（generate_video）执行与提示词撰写规范】
  * 【首帧铁律】用户上传了商品图/人像图或要求「基于某张图做视频」「让这张图动起来」时，必须把图片编号填进 assetIds 作为首帧参考图（走图生视频）。纯文生视频容易导致商品严重形变与漂移，只有纯抽象意境、无具体实物或用户明确要求从零想象时才省略 assetIds。
  * 【图生视频禁复述外观】一旦填了 assetIds，提示词严禁复述图上已有的外观、颜色、材质与花纹，模型能看懂图，复述反而会触发重新绘制导致商品失真；只写「机位运镜（Camera）、光影流转（Lighting）、以及发生的物理动态与交互」。
  * 【写物理变化，忌堆静态大词】不要写「超高清、8K、电影感、绝美画面」等静态大词（模型通常会直接忽略）；必须写明真实发生的物理变化过程，即「主体做了什么动作 + 摄像机如何运动」。
  * 【单镜头与参数决策】：一次 generate_video 只生成一个单镜头（默认 5 秒，不超过 10 秒）。如果用户需要完整的长视频（如 15 秒展示片），应当在同一轮或分步规划成 3~4 个独立分镜并分别调用 generate_video。比例与清晰度根据目标场景与 list_models 可用能力推导（默认 16:9、9:16 或 1:1，清晰度 720P/768P/1080P），不要无故追问。
- 不要主动生成色情暴力违禁内容；画面若出现知名品牌 logo 可能侵权导致生成失败，请避开。

【收尾】每轮必须以一个动作结束。全部派发完或只需文字回复时，调用 finish 给出 summary。
闲聊/答谢/咨询直接用 finish 的 summary 回复，不要调用生成工具。

【一批做完就提醒换新会话】这条要主动说，不要等用户问：
- 一次批量生成（如「生成 5 套电商图」「这一组风格」）**完成收尾时**，
  在 summary 末尾加一句简短提醒：这一批已经做完，继续做**新的一批**建议**新建会话**——
  会话开太久，上下文会变长、参考图也可能过期，新会话更稳。
- 措辞要短、要像人话，不要每次都长篇大论。例：
  「这一批 5 张已完成 ✅ 下一批建议新建会话再开始，上下文更干净、素材也更稳。」
- 但**同一次工作内的后续微调不要赶用户走**（用户说「第 3 张再改一下」是同一批的延续，
  正常接着做）。只在「明显开始另一件事」时才提醒。

【回复格式：不要输出图片/视频链接】
summary 是**给人看的自然语言**，不要粘贴任何 URL 或链接：
- 图片/视频由左侧成果区自动展示，用户直接能看能下载，回复里再贴一遍链接是噪音；
- 上游链接又长又是临时的（几小时到几天失效），用户点开可能已经坏了，贴出来反而误导；
- 需要指代某张图时，用「素材N」「第 N 张」这类编号（见 context.sessionAssets），不要用链接。
- 正确示例：「5 张手套抠图已完成，背景统一替换为纯白，都在成果区第 1~5 张。」
  错误示例：「图1：https://assets.example.invalid/reference.png …」`
}

/**
 * 工具参数容错解析。
 *
 * 模型给的 arguments 是字符串，常见畸形：
 *   - 空串（无参工具）/ 前后带解释文字 / 尾随逗号 / 中文引号 / 裸换行
 *   - 有些厂商直接给对象而不是字符串
 * 解析失败**不能让整轮崩掉**——返回空对象并保留原始文本，交由调用方按缺参处理。
 */
export function parseToolArguments(raw: string | undefined | null): Record<string, unknown> {
  if (raw === undefined || raw === null) return {}
  const text = String(raw).trim()
  if (!text) return {}

  const attempts: string[] = [text]
  // 去掉尾随逗号
  attempts.push(text.replace(/,\s*([}\]])/g, '$1'))
  // 中文引号 → 英文引号
  attempts.push(text.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'"))
  // 字符串内裸换行转义
  attempts.push(text.replace(/"(?:[^"\\]|\\.)*"/g, (m) => m.replace(/\n/g, '\\n').replace(/\r/g, '\\r')))
  // 组合
  attempts.push(
    text
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/"(?:[^"\\]|\\.)*"/g, (m) => m.replace(/\n/g, '\\n')),
  )
  // 从混杂文本里截取第一个配平对象（模型有时把解释写在 JSON 外面）
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) attempts.push(text.slice(first, last + 1))

  for (const a of attempts) {
    try {
      const v = JSON.parse(a)
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    } catch { /* next */ }
  }
  return {}
}

/** 宽松取字符串（兼容模型给了数组/数字） */
export function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined
  if (Array.isArray(v) && v.length > 0) return asString(v[0])
  if (typeof v === 'number') return String(v)
  return undefined
}

/** 宽松取字符串数组 */
export function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
  return out.length ? out : undefined
}

/** 宽松取正整数 */
export function asPositiveInt(v: unknown, min: number, max: number): number | undefined {
  const n = Array.isArray(v) ? Number(v[0]) : Number(v)
  if (!Number.isFinite(n)) return undefined
  const i = Math.round(n)
  if (i < min) return min
  return Math.min(i, max)
}

/**
 * 从一轮响应里取出「要执行的那个动作」。
 *
 * 只认第一个 tool_call：一轮多个工具调用会让「先问后做」的顺序语义变模糊，
 * 而且我们的循环是有界的（4 轮），一次一个更好推理、也更好给用户看。
 */
export function pickAction(toolCalls: AdapterToolCall[] | undefined): { name: string; args: Record<string, unknown>; id: string } | null {
  if (!toolCalls || toolCalls.length === 0) return null
  const tc = toolCalls[0]
  if (!tc.name) return null
  return { name: tc.name, args: parseToolArguments(tc.arguments), id: tc.id }
}

/**
 * 取出**本轮全部**工具调用（并行批处理用）。
 *
 * 为什么要一次取全部：一次要出 6 张不同方向的图时，模型本来可以在**同一轮**里
 * 发出 6 个 generate_image。若只取第一个，就退化成"一次一轮"——
 * 每轮都得等生成完才能进下一轮，出图变成一张一张挤。
 * 全部取出后可同时派发，配合上游闸门（派发限速 + 在途上限）自然限流。
 */
export function pickActions(toolCalls: AdapterToolCall[] | undefined): { name: string; args: Record<string, unknown>; id: string }[] {
  if (!toolCalls || toolCalls.length === 0) return []
  return toolCalls
    .filter((tc): tc is AdapterToolCall => !!tc && !!tc.name)
    .map((tc, k) => ({ name: tc.name, args: parseToolArguments(tc.arguments), id: tc.id || `call_${k}` }))
}
