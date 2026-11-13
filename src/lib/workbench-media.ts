// 工具箱工作台：浏览器端轻量音视频/图片编辑工具。
// 音频：WebAudio 解码 → 片段裁剪/删除/合并 → 导出 WAV（零依赖，无需 ffmpeg）
// 图片：canvas 裁剪 → blob；产物默认留在浏览器，用作生成输入时才上传。

/** 解码音频文件为 AudioBuffer */
export async function decodeAudioFile(url: string): Promise<AudioBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error('音频加载失败')
  const ab = await res.arrayBuffer()
  const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
  try {
    return await ctx.decodeAudioData(ab)
  } finally {
    void ctx.close()
  }
}

/** AudioBuffer → WAV Blob（16bit PCM） */
export function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numCh = buffer.numberOfChannels
  const sampleRate = buffer.sampleRate
  const len = buffer.length
  const bytesPerSample = 2
  const blockAlign = numCh * bytesPerSample
  const dataSize = len * blockAlign
  const out = new ArrayBuffer(44 + dataSize)
  const view = new DataView(out)
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, numCh, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)
  const chans: Float32Array[] = []
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c))
  let off = 44
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]))
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      off += 2
    }
  }
  return new Blob([out], { type: 'audio/wav' })
}

/** 截取 [startSec, endSec) 片段 */
export function sliceAudio(buffer: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const ctx = new OfflineAudioContext(buffer.numberOfChannels, Math.max(1, Math.floor((endSec - startSec) * buffer.sampleRate)), buffer.sampleRate)
  const out = ctx.createBuffer(buffer.numberOfChannels, Math.max(1, Math.floor((endSec - startSec) * buffer.sampleRate)), buffer.sampleRate)
  const s0 = Math.max(0, Math.floor(startSec * buffer.sampleRate))
  const s1 = Math.min(buffer.length, Math.floor(endSec * buffer.sampleRate))
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.getChannelData(c).set(buffer.getChannelData(c).slice(s0, s1))
  }
  return out
}

/** 合并多个 AudioBuffer（采样率不一致时按第一个为准，逐通道对齐；短补零） */
export function concatAudio(buffers: AudioBuffer[]): AudioBuffer {
  if (buffers.length === 0) throw new Error('没有可合并的音频')
  const sampleRate = buffers[0].sampleRate
  const numCh = Math.max(...buffers.map((b) => b.numberOfChannels))
  const totalLen = buffers.reduce((s, b) => s + Math.round(b.duration * sampleRate), 0)
  const ctx = new OfflineAudioContext(numCh, Math.max(1, totalLen), sampleRate)
  const out = ctx.createBuffer(numCh, Math.max(1, totalLen), sampleRate)
  let off = 0
  for (const b of buffers) {
    const n = Math.round(b.duration * sampleRate)
    for (let c = 0; c < numCh; c++) {
      const src = b.getChannelData(Math.min(c, b.numberOfChannels - 1))
      out.getChannelData(c).set(src.subarray(0, n), off)
    }
    off += n
  }
  return out
}

/** canvas 裁剪图片区域（坐标为原图像素）→ Blob */
export async function cropImage(url: string, rect: { x: number; y: number; width: number; height: number }, mime = 'image/png'): Promise<Blob> {
  const img = new Image()
  img.crossOrigin = 'anonymous'
  await new Promise<void>((res, rej) => {
    img.onload = () => res()
    img.onerror = () => rej(new Error('图片加载失败'))
    img.src = url
  })
  const cv = document.createElement('canvas')
  cv.width = Math.round(rect.width)
  cv.height = Math.round(rect.height)
  const g = cv.getContext('2d')
  if (!g) throw new Error('canvas 不可用')
  g.drawImage(img, rect.x, rect.y, rect.width, rect.height, 0, 0, cv.width, cv.height)
  return await new Promise<Blob>((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('导出失败'))), mime))
}

/** blob 上传到站内素材接口（/api/assets），返回站内 URL */
export async function uploadAssetBlob(blob: Blob, fileName: string, mime: string, source = 'workbench'): Promise<string> {
  const form = new FormData()
  form.append('file', blob, fileName)
  form.append('source', source)
  const res = await fetch('/api/assets', { method: 'POST', body: form, credentials: 'include' })
  const j = await res.json().catch(() => null)
  if (!res.ok || !j?.success || !j?.data?.url) throw new Error(j?.message || '上传失败')
  return j.data.url as string
}

/** 时间格式化 mm:ss.d */
export function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`
}
