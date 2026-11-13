'use client'

import { isEphemeralUrl } from '@/lib/media-url'

/**
 * 图片地址 → 上游可拉取的站内地址（统一入口）
 *
 * 背景：工具面板、Agent 面板、批量图像处理都要把「原图」交给上游模型，
 * 而上游是远端服务器，必须能自己 fetch 到这张图。早先每个调用点各写一套，
 * 口径分散、容易漏（blob 上传了、外链没转存、相对路径没拼域名…），
 * 出问题又要四处修。这里收敛成**唯一实现**，所有入口共用。
 *
 * 三类地址：
 *   1) blob: / data:   只存在浏览器 → 上传服务器换站内地址
 *   2) http(s)://      外链（上游临时图/防盗链）→ 转存为站内素材
 *   3) /api/asset/...  已是站内地址 → 原样返回
 *
 * 上传一律用 source='tool'（2 小时 TTL，由既有清理任务回收），
 * 不新增 source 类型，避免磁盘上多出一类无人回收的素材。
 */
export async function ensureServerUrl(url: string): Promise<string> {
  if (!url) return url

  // 1) 本地临时地址（blob: / data:）：只能上传
  // 判定走 isEphemeralUrl：前缀清单集中在 media-url 一处，避免这里写一遍、别处又写一遍
  // （漏判 data: 就会把 base64 大图直接送给上游）。
  if (isEphemeralUrl(url)) {
    const blob = await fetch(url).then((r) => r.blob())
    const fd = new FormData()
    fd.append('file', blob, `local-${Date.now()}.png`)
    fd.append('source', 'tool')
    const res = await fetch('/api/assets', { method: 'POST', body: fd, credentials: 'include' })
    const j = await res.json().catch(() => null)
    if (!j?.success || !j?.data?.url) throw new Error(j?.message || '图片上传服务器失败')
    return j.data.url as string
  }

  // 2) 外链：转存为站内素材（上游链接会过期，且 http 外链在 https 页面会被拦）
  if (/^https?:\/\//i.test(url)) {
    const res = await fetch('/api/assets/rehost', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    const j = await res.json().catch(() => null)
    if (j?.success && j?.data?.url) return j.data.url as string
    // 转存失败不阻断：很多外链上游其实能直接拉，退回原地址
    return url
  }

  // 3) 站内相对路径：原样返回
  return url
}
