type SubtaskLike = {
  id?: string
  title?: string
  type?: string
  status?: string
  imageUrl?: string
  imageUrls?: string[]
  videoUrl?: string
  videoUrls?: string[]
  audioUrl?: string
  audioUrls?: string[]
}

/** 从 payload.subtasks 里抽成果（与 canvas/runs 的 extractResults 同思路，但源结构不同） */
export function extractAgentResults(subtasks: unknown): Array<{ kind: 'image' | 'video' | 'audio'; url: string; label?: string }> {
  if (!Array.isArray(subtasks)) return []
  const out: Array<{ kind: 'image' | 'video' | 'audio'; url: string; label?: string }> = []
  for (const st of subtasks as SubtaskLike[]) {
    // 只认成功项：失败/取消的 subtask 不该进成果区
    if (st?.status !== 'success') continue
    const push = (kind: 'image' | 'video' | 'audio', v: unknown) => {
      if (Array.isArray(v)) {
        for (const u of v) if (typeof u === 'string' && u) out.push({ kind, url: u, label: st.title })
      } else if (typeof v === 'string' && v) {
        out.push({ kind, url: v, label: st.title })
      }
    }
    push('image', st?.imageUrls ?? st?.imageUrl)
    push('video', st?.videoUrls ?? st?.videoUrl)
    push('audio', st?.audioUrls ?? st?.audioUrl)
  }
  return out
}

export function extractCanvasResults(
  seedOutputs: unknown,
  resultNodeIds: string[] | null,
): Array<{ nodeId: string; kind: 'image' | 'video' | 'audio'; url: string; label?: string }> {
  if (!seedOutputs || typeof seedOutputs !== 'object') return []
  const outputs = seedOutputs as Record<string, unknown>
  const ids = new Set(resultNodeIds ?? [])
  // 没记 resultNodeIds 的旧任务：退回「节点名以 gen- 开头」的启发式（生成节点命名约定）
  const heuristic = ids.size === 0
  const out: Array<{ nodeId: string; kind: 'image' | 'video' | 'audio'; url: string; label?: string }> = []

  const pickUrls = (val: unknown): Array<{ kind: 'image' | 'video' | 'audio'; url: string }> => {
    if (typeof val !== 'object' || val === null) return []
    const rec = val as Record<string, unknown>
    const urls: Array<{ kind: 'image' | 'video' | 'audio'; url: string }> = []
    for (const [port, v] of Object.entries(rec)) {
      const kind =
        port === 'imageUrl' || port === 'images' ? 'image' :
        port === 'videoUrl' || port === 'videoUrls' || port === 'videos' ? 'video' :
        port === 'audioUrl' || port === 'audioUrls' || port === 'audios' ? 'audio' : null
      if (!kind) continue
      for (const u of Array.isArray(v) ? v : [v]) {
        if (typeof u === 'string' && u) urls.push({ kind, url: u })
      }
    }
    return urls
  }

  for (const [nodeId, output] of Object.entries(outputs)) {
    if (!heuristic && !ids.has(nodeId)) continue
    if (heuristic && !nodeId.startsWith('gen-')) continue
    for (const { kind, url } of pickUrls(output)) {
      out.push({ nodeId, kind, url })
    }
  }
  return out
}
