/**
 * 节点卡身与浮动参数层（拆分后的统一出口，Q-303）。
 *
 * 调用方 import 路径**零改动**：仍是 `@/components/canvas/node-bodies`。
 * 拆分前 2142 行的单文件按职责分成 6 个模块，本文件只做转发。
 *
 * ===== 节点卡身 + 浮动参数层设计（对齐用户最新规格）=====
 *  - 节点卡片本体 = 结果重放区（90%+ 面积放返回文本/图片/视频），左上角浮动节点标注
 *  - 上参数条 = 点击节点后在卡片上方弹出的横向长条（模型名完整显示 + 参数 + 预估积分 + 运行）
 *  - 下填写面板 = 点击节点后在卡片下方弹出的横向面板（宽 > 高），放提示词 / 系统提示词输入
 * 三者以卡片为容器（绝对定位子元素），自动跟随节点平移缩放。
 */
export type { NodeBodyCtx } from './node-bodies/types'
export { ResultLabel, ModelSelect, CostChip, RunButton, TextResult, MediaActions, AudioWave, WavePlayer } from './node-bodies/shared'
export { LLMChatBody, ImageGenerateBody, ImageUploadBody, ImagePreviewBody, VideoPreviewBody, VideoGenerateBody, AudioPreviewBody, VoiceIsolateBody, SfxGenerateBody, AudioGenerateBody, AudioUploadBody, PerceptionBody, TextPreviewBody, NumberInputBody, TextInputBody, JsonParserBody, PromptBatchBody, ConditionCheckBody, ImageCropBody, FaceDoodleBody, NumberCalcBody, TextConcatBody, FieldExtractorBody } from './node-bodies/bodies'
export { AudioUploadParamBar, Grid9GifParamBar, LLMParamBar, ImageGenParamBar, VideoGenParamBar, AudioGenParamBar, MusicGenParamBar, TtsGenParamBar, SfxGenParamBar, VoiceIsolateParamBar, PerceptionParamBar, FaceDoodleParamBar, JsonParserParamBar, FieldExtractorParamBar, BatchPromptParamBar, ConditionCheckParamBar, NumberCalcParamBar, TextConcatParamBar } from './node-bodies/param-bars'
export { AudioUploadPanel, AudioGenPromptPanel, MusicGenPromptPanel, TtsGenPromptPanel, SfxGenPromptPanel, VoiceIsolatePanel, LLMPromptPanel, ImageGenPromptPanel, NineGridLoopPanel, Grid9GifPanel, VideoGenPromptPanel, FaceDoodlePanel, FieldExtractorPanel, JsonParserPromptPanel, BatchPromptPanel, ConditionCheckPanel, TextConcatPanel, NumberCalcPanel } from './node-bodies/prompt-panels'
export { dispatchNodeBody, dispatchParamBar, dispatchPromptPanel, hasResultCard } from './node-bodies/dispatch'
