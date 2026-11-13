/**
 * 企业 AI 使用情况调研 —— 默认问题树。
 *
 * 结构约定（与前端逐题渲染引擎共用同一份 schema）：
 *   - type: single（单选）/ multi（多选）/ text（长文本）
 *   - showIf: { 父题id: 选项值 } —— 父题选了该选项才显示本题
 *     多值匹配用数组：showIf: { q4: ["a","b"] } 表示父题答了 a 或 b 都显示
 *   - max: 多选最多可选几项
 *
 * 管理员可在后台新建模板时自定义题目（存 SurveyTemplate.questions），
 * 这里只作为「新建时一键填充」的默认模板，不是硬编码逻辑。
 */
export interface SurveyQuestion {
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

export const DEFAULT_SURVEY_QUESTIONS: SurveyQuestion[] = [
  // ---------- 第 0 部分 基本情况 ----------
  { id: 'role', section: '基本情况', title: '你的岗位属于哪类？', type: 'single', required: true,
    options: ['研发/技术', '产品', '设计', '市场/品牌', '运营', '销售', '人力/行政/财务等职能', '管理层', '其他'] },
  { id: 'team', section: '基本情况', title: '你所在团队的规模？', type: 'single', required: true,
    options: ['1-5 人', '6-20 人', '21-50 人', '50 人以上'] },
  { id: 'policy', section: '基本情况', title: '公司目前有明确的 AI 使用政策或推荐工具清单吗？', type: 'single', required: true,
    options: ['有，鼓励大家用', '有，但只允许白名单工具', '有，限制/禁止使用', '没有明确规定'] },

  // ---------- 主干 1 对话式 AI ----------
  { id: 'q1', section: '对话式 AI 助手', title: '过去 3 个月，你用过对话式 AI 助手吗？（如 ChatGPT、Claude、豆包、Kimi、通义、DeepSeek、元宝等）', type: 'single', required: true,
    options: ['用过', '没用过'] },
  { id: 'q1_no_reason', section: '对话式 AI 助手', title: '没用的主要原因是什么？', type: 'multi', showIf: { q1: '没用过' },
    options: ['不知道能用来干嘛', '担心数据/信息泄露', '没有使用权限', '工作没有需求', '工具不好用/效果差'] },
  { id: 'q1_which', section: '对话式 AI 助手', title: '你主要用哪几个？', type: 'multi', showIf: { q1: '用过' },
    options: ['ChatGPT', 'Claude', 'DeepSeek', '豆包', 'Kimi', '通义千问', '元宝', '文心一言', '其他'] },
  { id: 'q1_freq', section: '对话式 AI 助手', title: '使用频率大概是？', type: 'single', showIf: { q1: '用过' },
    options: ['每天多次', '每天至少一次', '每周几次', '偶尔用'] },
  { id: 'q1_scene', section: '对话式 AI 助手', title: '主要用在哪些场景？', type: 'multi', showIf: { q1: '用过' },
    options: ['写文案/改稿', '写代码', '翻译', '整理文档/总结会议', '做表格/数据处理', '头脑风暴/想点子', '学习新知识', '其他'] },
  { id: 'q1_pay', section: '对话式 AI 助手', title: '用的是免费版还是付费版？', type: 'single', showIf: { q1: '用过' },
    options: ['免费版', '自己付费的公司账号', '公司统一采购', '不清楚'] },
  { id: 'q1_data', section: '对话式 AI 助手', title: '有没有往 AI 里贴过公司内部资料？（文档、数据、代码等）', type: 'single', showIf: { q1: '用过' },
    options: ['贴过，没多想', '贴过，但会脱敏/删敏感信息', '不敢贴，担心泄密', '公司规定不让贴'] },

  // ---------- 主干 2 桌面智能体 ----------
  { id: 'q2', section: '桌面智能体 / Agent', title: '用过桌面智能体或 AI 编程/工作 Agent 吗？（如 WorkBuddy、Codex、Claude Code、Cursor、Manus、Coze 智能体等）', type: 'single', required: true,
    options: ['用过', '没用过'] },
  { id: 'q2_no', section: '桌面智能体 / Agent', title: '这类工具听说过吗？没用过的主要原因？', type: 'text', showIf: { q2: '没用过' }, placeholder: '如：听说过但不知道怎么用 / 觉得学习成本高 / 工作用不上…' },
  { id: 'q2_which', section: '桌面智能体 / Agent', title: '用的是什么？装在哪？', type: 'single', showIf: { q2: '用过' },
    options: ['个人电脑上装的工具', '工作电脑上装的工具', '公司部署的平台', '网页版为主'] },
  { id: 'q2_what', section: '桌面智能体 / Agent', title: '主要用它干什么？', type: 'multi', showIf: { q2: '用过' },
    options: ['写代码/改代码', '自动化办公流程', '批量处理文档', '资料调研/信息汇总', '数据分析', '其他'] },
  { id: 'q2_depth', section: '桌面智能体 / Agent', title: '用到什么深度？', type: 'single', showIf: { q2: '用过' },
    options: ['只是单次提问，拿答案', '让它连续执行多步任务', '敢让它自主改文件/操作系统', '没试过更深的用法'] },
  { id: 'q2_quality', section: '桌面智能体 / Agent', title: '实际效果怎么样？', type: 'single', showIf: { q2: '用过' },
    options: ['很惊喜，超出预期', '整体不错，偶尔出错', '一半一半', '经常出问题，不太敢用'] },
  { id: 'q2_badc', section: '桌面智能体 / Agent', title: '能举个让你不放心/出问题的例子吗？', type: 'text', showIf: { q2_quality: '经常出问题，不太敢用' }, placeholder: '简述即可' },

  // ⭐ API
  { id: 'q2_api', section: '桌面智能体 / Agent', title: '调没调用过 API？（给智能体/工具配置第三方接口，如 OpenAI、DeepSeek 的模型 API，或飞书、Notion 等业务接口）', type: 'single', showIf: { q2: '用过' },
    options: ['调用过', '没有，但知道怎么做', '没有，也不清楚怎么配'] },
  { id: 'q2_api_what', section: '桌面智能体 / Agent', title: '调的主要是哪类 API？', type: 'multi', showIf: { q2_api: '调用过' },
    options: ['模型 API（OpenAI / Anthropic / DeepSeek 等）', '业务系统 API（飞书、钉钉、Notion、数据库）', '自己写的小工具在调', '其他'] },
  { id: 'q2_api_cost', section: '桌面智能体 / Agent', title: 'API 费用谁出？大概每月多少钱？', type: 'single', showIf: { q2_api: '调用过' },
    options: ['公司出，几十元/月', '公司出，几百元以上/月', '自己出，几十元/月', '自己出，几百元以上/月', '很少/免费额度内', '不清楚'] },
  { id: 'q2_api_why', section: '桌面智能体 / Agent', title: '调 API 主要是为了？', type: 'multi', showIf: { q2_api: '调用过' },
    options: ['接数据源/内部系统', '做自动化脚本', '搭内部小工具', '个人折腾学习', '其他'] },

  // ⭐ Skills
  { id: 'q2_skill', section: '桌面智能体 / Agent', title: '用过 Skills / 插件 / 自定义能力吗？（如 Codex Skills、Claude Skill、GPTs、Coze 插件、MCP 工具等）', type: 'single', showIf: { q2: '用过' },
    options: ['用过官方的', '用过别人写的/分享的', '自己写过/创建过', '没有用过'] },
  { id: 'q2_skill_own', section: '桌面智能体 / Agent', title: '你写过哪些 Skill/插件？分享给同事了吗？', type: 'text', showIf: { q2_skill: '自己写过/创建过' }, placeholder: '简述：写的是什么、给谁用过、效果如何' },
  { id: 'q2_skill_val', section: '桌面智能体 / Agent', title: '用了 Skill 之后，相比直接问 AI，提升大吗？', type: 'single', showIf: { q2_skill: '用过官方的' },
    options: ['提升明显，效率翻倍', '有一些提升', '差别不大', '反而更麻烦'] },
  { id: 'q2_skill_no', section: '桌面智能体 / Agent', title: '没用的原因？如果公司有人带你配一次，你愿意学吗？', type: 'text', showIf: { q2_skill: '没有用过' }, placeholder: '简述原因和意愿' },

  { id: 'q2_mcp', section: '桌面智能体 / Agent', title: '有没有把 Agent 连接外部数据源？（如接飞书文档、数据库、网页浏览、邮箱等）', type: 'single', showIf: { q2: '用过' },
    options: ['接过，自己摸索的', '接过，有人/文档指导', '没接过，但感兴趣', '不感兴趣'] },

  // ---------- 主干 3 办公套件 AI ----------
  { id: 'q3', section: '办公软件自带 AI', title: '用过办公软件自带的 AI 功能吗？（如 Office Copilot、WPS AI、钉钉 AI 助理、飞书智能伙伴、Notion AI、通义听悟、剪映 AI 等）', type: 'single', required: true,
    options: ['经常用', '偶尔用', '没用过'] },
  { id: 'q3_what', section: '办公软件自带 AI', title: '最常用哪类？', type: 'multi', showIf: { q3: ['经常用', '偶尔用'] },
    options: ['会议纪要/转写', 'PPT 生成', '文档润色/摘要', '表格公式/数据处理', '图片处理', '其他'] },
  { id: 'q3_meet', section: '办公软件自带 AI', title: '会议纪要类工具：开会时敢开吗？纪要质量满意吗？', type: 'single', showIf: { q3: ['经常用', '偶尔用'] },
    options: ['敢开，质量不错', '敢开，但质量一般', '不太敢开，怕录到敏感内容', '没用过纪要功能'] },
  { id: 'q3_who', section: '办公软件自带 AI', title: '这类工具是公司采购的还是自己开的？大概每周帮你省多少时间？', type: 'single', showIf: { q3: ['经常用', '偶尔用'] },
    options: ['公司采购，省 2 小时以上/周', '公司采购，省 1 小时左右/周', '自己开的，省 2 小时以上/周', '自己开的，省 1 小时左右/周', '几乎没省时间'] },

  // ---------- 主干 4 生成式内容 ----------
  { id: 'q4', section: 'AI 图像/视频/音频', title: '用过 AI 图像、视频或音频生成工具吗？（如 Midjourney、即梦、可灵、海螺、Suno、HeyGen 等）', type: 'single', required: true,
    options: ['用过，正式业务上也用', '用过，只是自己玩', '没用过'] },
  { id: 'q4_biz', section: 'AI 图像/视频/音频', title: 'AI 生成的内容做过正式交付吗？客户/领导接受度如何？', type: 'single', showIf: { q4: '用过，正式业务上也用' },
    options: ['交付过，接受度很高', '交付过，有人有顾虑', '试过但最终没用上', '还没交付过'] },
  { id: 'q4_adv', section: 'AI 图像/视频/音频', title: '用过参考图/垫图/角色一致性这类进阶玩法吗？', type: 'single', showIf: { q4: ['用过，正式业务上也用', '用过，只是自己玩'] },
    options: ['用过，经常', '试过几次', '没用过，不知道怎么做'] },

  // ---------- 主干 5 自建应用 ----------
  { id: 'q5', section: '自建应用与集成', title: '参与过公司内部带 AI 能力的系统/应用的搭建吗？（如内部知识库、RAG 问答机器人、自动化工作流、AI 客服等）', type: 'single', required: true,
    options: ['是搭建者/维护者', '是需求方/重度使用者', '知道有，但没参与', '公司没有这类东西'] },
  { id: 'q5_tech', section: '自建应用与集成', title: '用什么技术路线？', type: 'single', showIf: { q5: '是搭建者/维护者' },
    options: ['低代码/零代码平台', 'Dify / Coze / n8n 等工作流平台', '自写代码调模型 API', 'RAG / 向量知识库', '其他'] },
  { id: 'q5_eval', section: '自建应用与集成', title: '上线后有多少人在用？有没有做质量验证（评测/回归）？', type: 'text', showIf: { q5: '是搭建者/维护者' }, placeholder: '简述：用户数/活跃情况/有没有质量保障机制' },
  { id: 'q5_block', section: '自建应用与集成', title: '推广时最大的阻力是什么？', type: 'multi', showIf: { q5: ['是搭建者/维护者', '是需求方/重度使用者'] },
    options: ['同事不会用', '不信任 AI 结果', '数据权限/安全审批', 'IT 审批流程慢', '预算不足', '没遇到阻力'] },

  // ---------- 主干 6 组织层 ----------
  { id: 'q6_team', section: '组织与期待', title: '公司有没有专门负责 AI 落地/培训的人或团队？', type: 'single', required: true,
    options: ['有专门团队', '有兼职负责人', '完全没有', '不清楚'] },
  { id: 'q6_share', section: '组织与期待', title: '内部有没有 AI 分享会或可搜索的「同事 AI 用法」案例沉淀？', type: 'single', required: true,
    options: ['有，很活跃', '有但没人看', '没有', '不清楚'] },
  { id: 'q6_block', section: '组织与期待', title: '你觉得目前用 AI 最大的障碍是？', type: 'multi', required: true, max: 3,
    options: ['数据安全/合规顾虑', '工具权限/账号受限', '没有预算', '没时间学习', '领导不重视', '效果不稳定，不敢依赖', '其他'] },
  { id: 'q6_want', section: '组织与期待', title: '未来 6 个月，最希望公司提供什么？', type: 'multi', required: true,
    options: ['统一企业版 AI 账号', 'API 预算支持', '系统化培训', '安全合规的数据通道', '内部 Agent/知识库平台', '用不到，无所谓'] },
  { id: 'q6_evangelist', section: '组织与期待', title: '你愿意成为团队里的「AI 布道者」，帮同事答疑、分享用法吗？', type: 'single', required: true,
    options: ['非常愿意', '看情况，可以参与', '暂时没精力'] },
  { id: 'q6_extra', section: '组织与期待', title: '还有什么想补充的吗？（选填）', type: 'text', placeholder: '任何想法、吐槽、建议…' },
]
