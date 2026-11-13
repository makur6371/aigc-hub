// 画布配色/文案映射（Q-803 拆出）：与节点渲染相关的展示常量，集中一处便于换肤与统一口径。



// 「结果卡身」节点类型（无标题条、卡身=结果重放区）；node-bodies 的 hasResultCard 与此保持一致
export const RESULT_CARD_TYPES = [
  'llm-chat', 'image-generate', 'nine-grid-loop', 'grid9-to-gif', 'image-upload', 'image-upload-batch', 'image-preview',
  'image-crop',
  'face-doodle',  'video-generate', 'video-preview', 'audio-generate', 'audio-preview', 'music-generate', 'tts-generate', 'sfx-generate', 'voice-isolate', 'audio-upload', 'transcribe', 'ocr', 'text-preview', 'text-input', 'number-input', 'json-parser',
  'json-prompt-batch', 'condition-check', 'number-calc', 'text-concat', 'field-extractor',
]

export const categoryLabels: Record<string, string> = {
  llm: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
  logic: '逻辑',
  data: '数据',
  io: '输入 / 输出',
  custom: '自定义',
}


// 连线/节点状态色
export const statusColors: Record<string, string> = {
  success: 'var(--success)',
  error: 'var(--danger)',
  running: 'var(--primary)',
  idle: 'var(--text-disabled)',
}

export const typeColors: Record<string, string> = {
  string: 'var(--primary)',
  number: 'var(--success)',
  boolean: 'var(--warning)',
  object: 'var(--accent)',
  array: 'var(--info)',
  image: 'var(--accent)',
  video: 'var(--warning-deep)',
  stream: 'var(--primary)',
}

export const categoryColors: Record<string, string> = {
  llm: 'var(--primary)',
  image: 'var(--accent)',
  video: 'var(--warning-deep)',
  logic: 'var(--accent)',
  data: 'var(--info)',
  io: 'var(--success)',
  custom: 'var(--text-secondary)',
}
