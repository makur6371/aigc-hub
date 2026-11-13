// 画布图片工具（Q-803 拆出）：浏览器端数据 URL 降采样，DOM/Canvas 相关，仅前端可用。



// 压缩图片数据 URL：降采样到 maxDim 内，一律 JPEG 白底编码。
// 不做 getImageData alpha 扫描（同步全像素遍历是上传卡顿的主因）；
// 透明 PNG 铺白底而非黑底，输出体积稳定可控。
export function compressImageDataUrl(dataUrl: string, maxDim = 1280, quality = 0.85): Promise<string> {
  return new Promise((resolve) => {
    const img = document.createElement('img')
    img.onload = () => {
      try {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(dataUrl)
          return
        }
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, w, h)
        ctx.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', quality))
      } catch {
        resolve(dataUrl)
      }
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}
