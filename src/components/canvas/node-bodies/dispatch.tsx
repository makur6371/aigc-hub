'use client'

import { useState, useEffect } from 'react'
import { NodeBodyCtx } from './types'
import { LLMChatBody, ImageGenerateBody, ImageUploadBody, ImagePreviewBody, VideoPreviewBody, VideoGenerateBody, AudioPreviewBody, VoiceIsolateBody, SfxGenerateBody, AudioGenerateBody, AudioUploadBody, PerceptionBody, TextPreviewBody, NumberInputBody, TextInputBody, JsonParserBody, PromptBatchBody, ConditionCheckBody, ImageCropBody, FaceDoodleBody, NumberCalcBody, TextConcatBody, FieldExtractorBody } from './bodies'
import { AudioUploadParamBar, Grid9GifParamBar, LLMParamBar, ImageGenParamBar, VideoGenParamBar, AudioGenParamBar, MusicGenParamBar, TtsGenParamBar, SfxGenParamBar, VoiceIsolateParamBar, PerceptionParamBar, FaceDoodleParamBar, JsonParserParamBar, FieldExtractorParamBar, BatchPromptParamBar, ConditionCheckParamBar, NumberCalcParamBar, TextConcatParamBar } from './param-bars'
import { AudioUploadPanel, AudioGenPromptPanel, MusicGenPromptPanel, TtsGenPromptPanel, SfxGenPromptPanel, VoiceIsolatePanel, LLMPromptPanel, ImageGenPromptPanel, NineGridLoopPanel, Grid9GifPanel, VideoGenPromptPanel, FaceDoodlePanel, FieldExtractorPanel, JsonParserPromptPanel, BatchPromptPanel, ConditionCheckPanel, TextConcatPanel, NumberCalcPanel } from './prompt-panels'

// 卡身（结果重放区）分派：返回 null 表示无专属卡身（走通用渲染）
export function dispatchNodeBody(
  type: string,
  ctx: NodeBodyCtx,
  extra: { onUploadFiles: (files: FileList | File[]) => void; onOpenWorkbench?: (nodeId: string) => void }
): React.ReactNode {
  switch (type) {
    // 卡身也统一为子组件渲染：页面层可继续按节点类型条件复用这些函数，
    // 但 Hook 必须隶属于各自子组件，不能混进 CanvasNodeCard 的父级 Hook 序列。
    case 'llm-chat': return <LLMChatBody {...ctx} />
    case 'image-generate': return <ImageGenerateBody {...ctx} />
    case 'nine-grid-loop': return <ImageGenerateBody {...ctx} />
    case 'grid9-to-gif': return <ImageGenerateBody {...ctx} />
    case 'image-upload': case 'image-upload-batch': return <ImageUploadBody {...ctx} onUploadFiles={extra.onUploadFiles} />
    case 'image-preview': return <ImagePreviewBody {...ctx} />
    // 裁切/涂鸦卡身的「打开工作台」按钮走 extra.onOpenWorkbench（页面层注入），
    // 必须并进 ctx —— 漏了就是按钮点了没反应且无任何报错（静默失效）。
    case 'image-crop': return <ImageCropBody {...ctx} onOpenWorkbench={extra.onOpenWorkbench} />
    case 'face-doodle': return <FaceDoodleBody {...ctx} onOpenWorkbench={extra.onOpenWorkbench} />
    case 'video-generate': return <VideoGenerateBody {...ctx} />
    case 'video-preview': return <VideoPreviewBody {...ctx} />
    case 'audio-generate': return <AudioGenerateBody {...ctx} />
    case 'audio-preview': return <AudioPreviewBody {...ctx} />
    case 'music-generate': return <AudioGenerateBody {...ctx} />
    case 'tts-generate': return <AudioGenerateBody {...ctx} />
    case 'sfx-generate': return <SfxGenerateBody {...ctx} />
    case 'voice-isolate': return <VoiceIsolateBody {...ctx} />
    case 'audio-upload': return <AudioUploadBody {...ctx} />
    case 'transcribe': return <PerceptionBody {...ctx} />
    case 'ocr': return <PerceptionBody {...ctx} />
    case 'text-preview': return <TextPreviewBody {...ctx} />
    case 'text-input': return <TextInputBody {...ctx} />
    case 'number-input': return <NumberInputBody {...ctx} />
    case 'json-parser': return <JsonParserBody {...ctx} />
    case 'json-prompt-batch': return <PromptBatchBody {...ctx} />
    case 'condition-check': return <ConditionCheckBody {...ctx} />
    case 'number-calc': return <NumberCalcBody {...ctx} />
    case 'text-concat': return <TextConcatBody {...ctx} />
    case 'field-extractor': return <FieldExtractorBody {...ctx} />
    default: return null
  }
}

// 上参数条分派：返回 null 表示该类型无参数条
export function dispatchParamBar(type: string, ctx: NodeBodyCtx): React.ReactNode {
  switch (type) {
    // 参数条由 CanvasNodeCard 条件渲染。必须作为 React 子组件返回 JSX，
    // 不能写成 Foo(ctx)：带 useEffect/useState 的参数条若被普通函数直接调用，
    // 会把 Hook 挂到父组件且随 cardOpen 条件执行，触发 Hook 顺序错乱。
    case 'llm-chat': return <LLMParamBar {...ctx} />
    case 'image-generate': return <ImageGenParamBar {...ctx} />
    case 'nine-grid-loop': return <ImageGenParamBar {...ctx} />
    case 'grid9-to-gif': return <Grid9GifParamBar {...ctx} />
    case 'video-generate': return <VideoGenParamBar {...ctx} />
    case 'audio-generate': return <AudioGenParamBar {...ctx} />
    case 'music-generate': return <MusicGenParamBar {...ctx} />
    case 'tts-generate': return <TtsGenParamBar {...ctx} />
    case 'sfx-generate': return <SfxGenParamBar {...ctx} />
    case 'voice-isolate': return <VoiceIsolateParamBar {...ctx} />
    case 'audio-upload': return <AudioUploadParamBar {...ctx} />
    case 'transcribe': return <PerceptionParamBar {...ctx} />
    case 'ocr': return <PerceptionParamBar {...ctx} />
    case 'json-parser': return <JsonParserParamBar {...ctx} />
    case 'field-extractor': return <FieldExtractorParamBar {...ctx} />
    case 'json-prompt-batch': return <BatchPromptParamBar {...ctx} />
    case 'condition-check': return <ConditionCheckParamBar {...ctx} />
    case 'number-calc': return <NumberCalcParamBar {...ctx} />
    case 'text-concat': return <TextConcatParamBar {...ctx} />
    case 'face-doodle': return <FaceDoodleParamBar {...ctx} />
    default: return null
  }
}

// 下填写面板分派：返回 null 表示该类型无填写面板
export function dispatchPromptPanel(type: string, ctx: NodeBodyCtx): React.ReactNode {
  switch (type) {
    // 与参数条同理：填写面板也可能随 cardOpen 条件出现，必须作为独立组件渲染，
    // 避免未来加入 Hook 后再次踩到条件调用 Hook 的父组件顺序问题。
    case 'llm-chat': return <LLMPromptPanel {...ctx} />
    case 'image-generate': return <ImageGenPromptPanel {...ctx} />
    case 'nine-grid-loop': return <NineGridLoopPanel {...ctx} />
    case 'grid9-to-gif': return <Grid9GifPanel {...ctx} />
    case 'video-generate': return <VideoGenPromptPanel {...ctx} />
    case 'audio-generate': return <AudioGenPromptPanel {...ctx} />
    case 'music-generate': return <MusicGenPromptPanel {...ctx} />
    case 'tts-generate': return <TtsGenPromptPanel {...ctx} />
    case 'sfx-generate': return <SfxGenPromptPanel {...ctx} />
    case 'voice-isolate': return <VoiceIsolatePanel {...ctx} />
    case 'audio-upload': return <AudioUploadPanel {...ctx} />
    case 'json-parser': return <JsonParserPromptPanel {...ctx} />
    case 'json-prompt-batch': return <BatchPromptPanel {...ctx} />
    case 'condition-check': return <ConditionCheckPanel {...ctx} />
    case 'field-extractor': return <FieldExtractorPanel {...ctx} />
    case 'text-concat': return <TextConcatPanel {...ctx} />
    case 'number-calc': return <NumberCalcPanel {...ctx} />
    case 'face-doodle': return <FaceDoodlePanel {...ctx} />
    default: return null
  }
}

// 该类型是否采用「结果卡身 + 浮动参数层」设计（有专属卡身就算）
export function hasResultCard(type: string): boolean {
  return [
    'llm-chat', 'image-generate', 'nine-grid-loop', 'grid9-to-gif', 'image-upload', 'image-upload-batch', 'image-preview',
    'image-crop', 'face-doodle',
    'video-generate', 'video-preview', 'audio-generate', 'audio-preview', 'music-generate', 'tts-generate', 'sfx-generate', 'voice-isolate', 'audio-upload', 'transcribe', 'ocr', 'text-preview', 'text-input', 'number-input', 'json-parser',
    'json-prompt-batch', 'condition-check', 'number-calc', 'text-concat', 'field-extractor',
  ].includes(type)
}
