import { OPENAI_COMPATIBLE_ADAPTER_SOURCE } from './openai-compatible'
import { OPENAI_IMAGE_EDITS_ADAPTER_SOURCE } from './openai-image-edits'

export const ADAPTER_TEMPLATES = [
  { code: 'openai-compatible', name: '通用兼容接口', description: '由管理员填写服务地址和模型。', source: OPENAI_COMPATIBLE_ADAPTER_SOURCE },
  { code: 'openai-image-edits', name: '通用图像编辑接口', description: '支持以 multipart 上传参考图。', source: OPENAI_IMAGE_EDITS_ADAPTER_SOURCE },
]
