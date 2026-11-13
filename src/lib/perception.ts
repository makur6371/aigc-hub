// 感知能力（ASR 语音识别 / OCR 文字识别）：接收一个媒体文件(URL 或 dataURL)，下载为二进制后
// 以 multipart/form-data 上传给上游对应端点，返回识别的纯文本。
// 供画布 transcribe / ocr 节点调用。鉴权统一 Bearer。

import { toUpstreamError } from './network-error'
import { invokeChat } from './provider-invoker'

export interface PerceptionInput {
  baseUrl: string
  apiKey: string
  modelName: string
  fileUrl: string // 待识别的音频/图片（URL 或 data:image/…;base64, 或 data:audio/…;base64）
  kind: 'asr' | 'ocr'
  /** 覆盖 ASR 接口路径。缺省 /audio/transcriptions（OpenAI 兼容），可按接口协议覆盖 */
  asrPath?: string
  /** provider 的 adapter id（OCR 走 invokeChat 时需要，保证厂商鉴权/解析一致） */
  adapterId?: string | null
  /** 调用方 userId：透传给并发闸门做用户级在途限制（Q-D51） */
  userId?: string
}

async function downloadBinary(url: string): Promise<{ buffer: BlobPart[]; mime: string; ext: string }> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',')
    const meta = url.slice(5, comma) // image/png;base64 / audio/wav;base64
    const mime = meta.split(';')[0] || 'application/octet-stream'
    const b64 = url.slice(comma + 1)
    const buf = Buffer.from(b64, 'base64')
    const ext = mime.includes('png') ? 'png' : mime.includes('jpeg') ? 'jpg' : mime.includes('wav') ? 'wav' : mime.includes('mpeg') ? 'mp3' : 'bin'
    return { buffer: [buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)], mime, ext }
  }
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(60000) })
  } catch (err) {
    // 识别前置下载：网络失败时 undici 只给 "fetch failed"，这里补全原因
    const e = toUpstreamError(err)
    throw new Error(`媒体下载失败：${e.message}`)
  }
  if (!res.ok) throw new Error(`媒体下载失败 (${res.status})`)
  const ab = await res.arrayBuffer()
  const mime = res.headers.get('content-type')?.split(';')[0] || 'application/octet-stream'
  const ext = mime.includes('png') ? 'png' : mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('wav') ? 'wav' : mime.includes('mpeg') || mime.includes('mp3') ? 'mp3' : 'bin'
  return { buffer: [ab], mime, ext }
}

// 上传媒体并取回识别文本
export async function runPerception(input: PerceptionInput): Promise<string> {
  if (input.kind === 'ocr') return runOcrChat(input)
  return runAsrMultipart(input)
}

// OCR：走 OpenAI 兼容 chat/completions 多模态视觉，返回识别文字。
//
// 为什么改用 invokeChat 而不是自己 fetch：这条链路就是标准 chat/completions，
// invokeChat 已覆盖「非流式 + adapter 解析 + 超时 + 网络错误翻译」，
// 自己再写一遍等于多一份需要同步维护的实现（历史上正是这类重复导致行为漂移）。
// ASR / 人声分离是 multipart 协议，adapter 里暂无对应钩子，暂留本地实现（见下方注释）。
async function runOcrChat(input: PerceptionInput): Promise<string> {
  const result = await invokeChat(
    { baseUrl: input.baseUrl, apiKey: input.apiKey, adapterId: input.adapterId ?? null, configJson: null },
    input.modelName,
    {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: input.fileUrl } },
            { type: 'text', text: '请识别图片中的全部文字，按其原始顺序和断行原样输出，不要额外解释。' },
          ],
        },
      ],
      maxTokens: 4096,
      stream: false,
    },
    undefined,
    undefined,
    120000,
    undefined,
    input.userId,
  )
  const text = result.content
  if (!text || !text.trim()) throw new Error('OCR 未返回文本')
  return text
}

async function runAsrMultipart(input: PerceptionInput): Promise<string> {
  const path = input.asrPath || '/audio/transcriptions'
  const endpoint = `${input.baseUrl.replace(/\/+$/, '')}${path}`

  const { buffer, mime, ext } = await downloadBinary(input.fileUrl)
  const form = new FormData()
  form.append('file', new Blob(buffer, { type: mime } as BlobPropertyBag), `input.${ext}`)
  form.append('model', input.modelName)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 120000)
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.apiKey}` }, // FormData 自带 boundary
      body: form,
      signal: controller.signal,
    })
    const bodyText = await res.text()
    if (!res.ok) {
      let msg = `识别接口错误 (${res.status})`
      try {
        const j = JSON.parse(bodyText)
        if (j.message) msg += `: ${j.message}`
        if (j.error?.message) msg += `: ${j.error.message}`
      } catch { /* ignore */ }
      throw new Error(msg)
    }
    let body: { text?: unknown } = {}
    try { body = JSON.parse(bodyText) } catch { /* ignore */ }
    const text = typeof body?.text === 'string' && body.text ? body.text : ''
    if (!text) throw new Error('识别接口未返回文本')
    return text
  } finally {
    clearTimeout(timeoutId)
  }
}

export interface VoiceIsolationInput {
  baseUrl: string
  apiKey: string
  modelName: string
  fileUrl: string
  path?: string
}

export async function isolateVoice(input: VoiceIsolationInput): Promise<string> {
  if (!input.path || !/^\/(?!\/)[a-zA-Z0-9/_.-]+$/.test(input.path) || input.path.split('/').includes('..')) {
    throw new Error('请在供应商配置中设置 isolationPath')
  }
  const endpoint = input.baseUrl.replace(/\/+$/, '') + input.path
  const { buffer, mime, ext } = await downloadBinary(input.fileUrl)
  const form = new FormData()
  form.append('file', new Blob(buffer, { type: mime } as BlobPropertyBag), `input.${ext}`)
  form.append('model', input.modelName)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 300000) // 分离整段音频可能较慢
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.apiKey}` },
      body: form,
      signal: controller.signal,
    })
    const bodyText = await res.text()
    if (!res.ok) {
      let msg = `人声分离接口错误 (${res.status})`
      try {
        const j = JSON.parse(bodyText)
        if (j.message) msg += `: ${j.message}`
        if (j.error_message) msg += `: ${j.error_message}`
      } catch { /* ignore */ }
      throw new Error(msg)
    }
    let body: { result_url?: unknown } = {}
    try { body = JSON.parse(bodyText) } catch { /* ignore */ }
    const url = typeof body?.result_url === 'string' && body.result_url ? body.result_url : ''
    if (!url) throw new Error('人声分离未返回结果音频')
    return url
  } finally {
    clearTimeout(timeoutId)
  }
}
