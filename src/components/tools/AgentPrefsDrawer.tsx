'use client'

import { useState, useEffect, useCallback } from 'react'
import { Drawer, Button, Select, Space, App, Input, Segmented } from 'antd'
import { apiFetch } from '@/lib/api-client'
import { DurationSlider } from '@/components/tools/DurationSlider'
import { findImageSize, getImageCapabilities } from '@/lib/image-sizes'
import {
  getVideoCapabilities,
  resolveVideoDurations,
  normalizeVideoResolution,
  isSelectableVideoModel,
  isContinuousDurationRange,
  DEFAULT_VIDEO_RATIOS,
  DEFAULT_VIDEO_RESOLUTIONS,
} from '@/lib/video-capabilities'

const { Option } = Select

interface ModelOption { id: string; name: string; isFree: boolean }
type ModelMeta = { id: string; name: string; isFree: boolean; type: string; metadata: Record<string, unknown> | null }
interface Prefs {
  imageModelId: string | null
  videoModelId: string | null
  audioModelId: string | null
  imageRatio: string | null
  imageTier: string | null
  imageQuality: string | null
  videoRatio: string | null
  videoResolution: string | null
  videoDuration: number | null
  memoryText: string | null
  executeMode: AgentExecuteMode
}

/** 执行权限：auto = 全自动；confirm = 执行前先列计划等确认 */
type AgentExecuteMode = 'auto' | 'confirm'

const RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '2:1', '1:2', '21:9', '9:21']
// 模型未配置 sizes 时的兜底：只出 1K（后台没勾档位就按最保守处理，防 4K 冒出）
const TIERS = ['1K']

/** Agent 偏好设定抽屉：全局生效，保存后每轮对话自动带上 */
export default function AgentPrefsDrawer({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved?: () => void }) {
  const { message } = App.useApp()
  const [imageModels, setImageModels] = useState<ModelMeta[]>([])
  const [imageRatios, setImageRatios] = useState<string[]>(RATIOS)
  const [imageTiers, setImageTiers] = useState<string[]>(TIERS)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [imageModelId, setImageModelId] = useState<string | null>(null)
  const [ratio, setRatio] = useState<string | null>(null)
  const [tier, setTier] = useState<string | null>(null)
  /**
   * 视频偏好（2026-10-26）—— 结构与生图那三项**完全同构**：
   * 先选模型，再由该模型的 metadata.video.constraints 决定可选值。
   * 不复制一份筛选逻辑：直接用 lib/video-capabilities 的 getVideoCapabilities
   * 与 resolveVideoDurations（工具面板、画布节点、这里三处共用同一口径）。
   */
  const [videoModels, setVideoModels] = useState<ModelMeta[]>([])
  const [videoModelId, setVideoModelId] = useState<string | null>(null)
  const [videoRatio, setVideoRatio] = useState<string | null>(null)
  const [videoResolution, setVideoResolution] = useState<string | null>(null)
  const [videoDuration, setVideoDuration] = useState<number | null>(null)
  const [videoRatios, setVideoRatios] = useState<string[]>(DEFAULT_VIDEO_RATIOS)
  const [videoResolutions, setVideoResolutions] = useState<string[]>(DEFAULT_VIDEO_RESOLUTIONS)
  const [videoDurations, setVideoDurations] = useState<number[]>([5, 10])
  // 用户自述 / 长期记忆（纯手填，全局生效）
  const [memoryText, setMemoryText] = useState('')
  // 执行权限：默认全自动（与后端默认一致，不改变老用户行为）
  const [executeMode, setExecuteMode] = useState<AgentExecuteMode>('auto')

  /**
   * 按所选视频模型的约束，算出可选的比例/分辨率/时长。
   *
   * 与工具面板同一口径（`lib/video-capabilities`）：
   *   · 模型声明了 constraints.ratios/resolutions → 只给这些
   *   · 没声明 → 回落 DEFAULT_VIDEO_*（不限制时给通用集合）
   *   · 时长：resolveVideoDurations 会处理「固定时长 / 离散集合 / 区间展开」
   *
   * ⚠️ 不在这里自造一套「按像素推比例」的逻辑 —— 工具面板踩过：
   * 各自推一套必然漂移，最后面板显示 A、提交的却是 B。
   */
  const applyVideoSpecs = useCallback((model: ModelMeta | undefined) => {
    const cap = getVideoCapabilities(model as never)
    const ratios = cap.ratios.length > 0 ? cap.ratios : DEFAULT_VIDEO_RATIOS
    const resolutions = (cap.resolutions.length > 0 ? cap.resolutions : DEFAULT_VIDEO_RESOLUTIONS)
      .map((r) => normalizeVideoResolution(r))
    const durations = resolveVideoDurations(cap)
    setVideoRatios(ratios)
    setVideoResolutions(resolutions)
    setVideoDurations(durations)
    return { ratios, resolutions, durations }
  }, [])

  const applyImageSpecs = useCallback((model: ModelMeta | undefined, keep?: { ratio?: string | null; tier?: string | null }) => {
    const cap = getImageCapabilities(model)
    if (!model) {
      setImageRatios(RATIOS)
      setImageTiers(TIERS)
      setRatio(null)
      setTier(null)
      return { cap, ratios: RATIOS, tiers: TIERS, selectedRatio: null, selectedTier: null }
    }
    const ratios = cap.declared ? cap.ratios : RATIOS
    const selectedRatio = keep?.ratio && ratios.includes(keep.ratio) ? keep.ratio : null
    const tiers = selectedRatio && cap.declared
      ? (cap.tiersByRatio[selectedRatio] ?? [])
      : (cap.declared ? [] : TIERS)
    const selectedTier = selectedRatio && keep?.tier && tiers.includes(keep.tier)
      ? keep.tier
      : null
    setImageRatios(ratios)
    setImageTiers(tiers)
    setRatio(selectedRatio)
    setTier(selectedTier)
    return { cap, ratios, tiers, selectedRatio, selectedTier }
  }, [])

  const load = useCallback(async () => {
    if (!open) return
    setLoading(true)
    try {
      const [prefRes, modelsRes] = await Promise.all([
        apiFetch<Prefs>('/api/agent/preferences'),
        apiFetch<ModelMeta[]>('/api/models'),
      ])
      if (prefRes.success && prefRes.data) {
        setImageModelId(prefRes.data.imageModelId)
        setRatio(prefRes.data.imageRatio)
        setTier(prefRes.data.imageTier)
        setVideoModelId(prefRes.data.videoModelId)
        setVideoRatio(prefRes.data.videoRatio)
        setVideoResolution(
          prefRes.data.videoResolution ? normalizeVideoResolution(prefRes.data.videoResolution) : null,
        )
        setVideoDuration(prefRes.data.videoDuration)
        setMemoryText(prefRes.data.memoryText || '')
        setExecuteMode(prefRes.data.executeMode === 'confirm' ? 'confirm' : 'auto')
      }
      if (modelsRes.success && modelsRes.data) {
        // IMAGE 类型本身就是生图能力。metadata.modes 只描述参考图形态，
        // 不能拿来当「是否支持生图」的开关，否则老模型/未填 modes 的模型会从 Agent 消失。
        const list = (modelsRes.data || []).filter((m) => m.type === 'IMAGE')
        setImageModels(list)
        // 视频模型单独一份列表（同一个 /api/models，不做第二次请求）。
        // 排除固定专属工具的模型：Agent 通用视频生成只走「文生/首尾帧/全能参考」三形态。
        const vids = (modelsRes.data || []).filter((m) => m.type === 'VIDEO' && isSelectableVideoModel(m))
        setVideoModels(vids)
        // 选中模型的约束 → 可选比例/分辨率/时长（与工具面板同口径）
        const vSel = vids.find((m) => m.id === (prefRes.data?.videoModelId || videoModelId))
        const vSpecs = applyVideoSpecs(vSel)
        if (prefRes.data) {
          const savedRes = prefRes.data.videoResolution
            ? normalizeVideoResolution(prefRes.data.videoResolution)
            : null
          setVideoRatio(
            prefRes.data.videoRatio && vSpecs.ratios.includes(prefRes.data.videoRatio)
              ? prefRes.data.videoRatio
              : null,
          )
          setVideoResolution(savedRes && vSpecs.resolutions.includes(savedRes) ? savedRes : null)
          setVideoDuration(
            prefRes.data.videoDuration != null && vSpecs.durations.includes(prefRes.data.videoDuration)
              ? prefRes.data.videoDuration
              : null,
          )
        }
        // 选定模型后按 metadata.sizes 筛选支持的比例与档位（与工具面板同口径）
        const selected = list.find((m) => m.id === (prefRes.data?.imageModelId || imageModelId))
        applyImageSpecs(selected, {
          ratio: prefRes.data?.imageRatio ?? ratio,
          tier: prefRes.data?.imageTier ?? tier,
        })
      }
    } catch { /* */ } finally { setLoading(false) }
    // 依赖只放 open / applyVideoSpecs：
    // 如果把 imageModelId / videoModelId 也放进依赖，用户每选一次模型就会重新拉一遍
    // 已保存的偏好、把刚做的选择覆盖掉（表单自己重置自己）。
    // 这里读到的模型 id 只用于「首次打开时按已保存的模型算规格」，用闭包里的旧值是对的。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, applyImageSpecs, applyVideoSpecs])

  useEffect(() => { void load() }, [load])

  const handleModelChange = (id: string | undefined) => {
    setImageModelId(id ?? null)
    const selected = imageModels.find((m) => m.id === id)
    applyImageSpecs(selected, { ratio, tier })
  }

  const handleImageRatioChange = (next: string | undefined) => {
    const nextRatio = next ?? null
    const selected = imageModels.find((m) => m.id === imageModelId)
    const cap = getImageCapabilities(selected)
    if (!nextRatio) {
      setRatio(null)
      setTier(null)
      setImageTiers(cap.declared ? [] : TIERS)
      return
    }
    const tiers = cap.declared ? (cap.tiersByRatio[nextRatio] ?? []) : TIERS
    setRatio(nextRatio)
    setImageTiers(tiers)
    setTier(tier && tiers.includes(tier) ? tier : (tiers[0] ?? null))
  }

  const handleImageTierChange = (next: string | undefined) => {
    const selected = imageModels.find((m) => m.id === imageModelId)
    const cap = getImageCapabilities(selected)
    const nextTier = next ?? null
    if (!nextTier) {
      setTier(null)
      return
    }
    if (!ratio) return
    if (cap.declared && !findImageSize(cap, ratio, nextTier)) return
    setTier(nextTier)
  }

  /**
   * 换视频模型时重算可选规格，并**清掉当前模型不支持的旧选择**。
   *
   * 为什么必须清：用户先选了「16:9 + 10 秒」，换成一个只支持 5 秒的模型后，
   * 若不清掉，保存下来的是一组该模型根本不接受的组合，
   * planner 照着它排计划 → 提交时被上游拒 → 用户看到「参数错误」但不知道错在哪。
   */
  const handleVideoModelChange = (id: string | undefined) => {
    setVideoModelId(id ?? null)
    if (!id) {
      applyVideoSpecs(undefined)
      setVideoRatio(null)
      setVideoResolution(null)
      setVideoDuration(null)
      return
    }
    const selected = videoModels.find((m) => m.id === id)
    const { ratios, resolutions, durations } = applyVideoSpecs(selected)
    if (videoRatio && !ratios.includes(videoRatio)) setVideoRatio(null)
    if (videoResolution && !resolutions.includes(normalizeVideoResolution(videoResolution))) setVideoResolution(null)
    if (videoDuration != null && !durations.includes(videoDuration)) setVideoDuration(null)
  }

  const save = async () => {
    setSaving(true)
    try {
      const res = await apiFetch('/api/agent/preferences', {
        method: 'PUT',
        body: JSON.stringify({
          imageModelId, imageRatio: ratio, imageTier: tier,
          videoModelId, videoRatio, videoResolution, videoDuration,
          memoryText, executeMode,
        }),
      })
      if (res.success) { message.success('偏好已保存，全局生效'); onSaved?.(); onClose() }
      else message.error(res.message || '保存失败')
    } catch { message.error('保存失败') } finally { setSaving(false) }
  }

  return (
    <Drawer title="偏好设定（全局生效）" open={open} onClose={onClose} width={380} destroyOnClose>
      <Space direction="vertical" size="middle" className="w-full">
        {/* ===== 第 1 段：模型偏好（技术参数）===== */}
        <div className="text-[11px] font-medium tracking-wide text-black/35">模型偏好</div>
        <div>
          <div className="mb-1 text-[12px] font-medium text-black/70">生图模型</div>
          <Select
            className="w-full" size="small" placeholder="自动选择"
            value={imageModelId ?? undefined} onChange={handleModelChange} allowClear loading={loading}
          >
            {imageModels.map((m) => (
              <Option key={m.id} value={m.id}>{m.name}{m.isFree ? '（免费）' : ''}</Option>
            ))}
          </Select>
        </div>
        <div>
          <div className="mb-1 text-[12px] font-medium text-black/70">画面比例</div>
          <Select
            className="w-full" size="small" placeholder={imageModelId ? '自动选择' : '请先选择生图模型'}
            disabled={!imageModelId}
            value={ratio ?? undefined} onChange={handleImageRatioChange} allowClear
          >
            {imageRatios.map((r) => <Option key={r} value={r}>{r}</Option>)}
          </Select>
        </div>
        <div>
          <div className="mb-1 text-[12px] font-medium text-black/70">分辨率档位</div>
          <Select
            className="w-full" size="small" placeholder={ratio ? '自动选择' : '请先选择画面比例'}
            disabled={!ratio || imageTiers.length === 0}
            value={tier ?? undefined} onChange={handleImageTierChange} allowClear
          >
            {imageTiers.map((t) => <Option key={t} value={t}>{t}</Option>)}
          </Select>
        </div>

        {/* ===== 第 1b 段：视频偏好 =====
            与上面生图完全同构：先选模型，再由该模型的 constraints 决定下面三项的可选值。
            为什么分成独立一段而不是塞进「生图」里：视频与图片的比例/档位集合不同
            （视频常常只支持 16:9 / 9:16 / 1:1），混在一起必然给出一组非法组合。 */}
        <div className="border-t border-black/[0.06] pt-3 text-[11px] font-medium tracking-wide text-black/35">
          视频偏好
        </div>
        <div>
          <div className="mb-1 text-[12px] font-medium text-black/70">视频模型</div>
          <Select
            className="w-full" size="small" placeholder="自动选择"
            value={videoModelId ?? undefined} onChange={handleVideoModelChange} allowClear loading={loading}
          >
            {videoModels.map((m) => (
              <Option key={m.id} value={m.id}>{m.name}</Option>
            ))}
          </Select>
        </div>
        {/* 没选视频模型时，下面三项没有参照物 —— 禁用并说明原因，
            避免用户先挑了一组规格、之后选的模型却不支持（与工具面板「先选模型」同一规则）。 */}
        <div>
          <div className="mb-1 text-[12px] font-medium text-black/70">视频比例</div>
          <Select
            className="w-full" size="small" placeholder={videoModelId ? '自动选择' : '请先选择视频模型'}
            disabled={!videoModelId}
            value={videoRatio ?? undefined} onChange={(v) => setVideoRatio(v ?? null)} allowClear
          >
            {videoRatios.map((r) => <Option key={r} value={r}>{r}</Option>)}
          </Select>
        </div>
        <div>
          <div className="mb-1 text-[12px] font-medium text-black/70">视频分辨率</div>
          <Select
            className="w-full" size="small" placeholder={videoModelId ? '自动选择' : '请先选择视频模型'}
            disabled={!videoModelId}
            value={videoResolution ?? undefined} onChange={(v) => setVideoResolution(v ?? null)} allowClear
          >
            {videoResolutions.map((r) => <Option key={r} value={r}>{r}</Option>)}
          </Select>
        </div>
        <div>
          <div className="mb-1 text-[12px] font-medium text-black/70">视频时长</div>
          {videoModelId && isContinuousDurationRange(videoDurations) ? (
            // 连续区间（如 4–30）用滑块，避免 27 个选项的长下拉
            <div className="px-1">
              <DurationSlider
                min={videoDurations[0]}
                max={videoDurations[videoDurations.length - 1]}
                value={videoDuration ?? videoDurations[0]}
                onChange={(v) => setVideoDuration(v)}
                label={null}
              />
              <button
                type="button"
                onClick={() => setVideoDuration(null)}
                className={`text-[11px] ${videoDuration == null ? 'text-accent' : 'text-black/35 hover:text-accent'}`}
              >
                自动选择（不指定）
              </button>
            </div>
          ) : (
            <Select
              className="w-full" size="small" placeholder={videoModelId ? '自动选择' : '请先选择视频模型'}
              disabled={!videoModelId}
              value={videoDuration ?? undefined} onChange={(v) => setVideoDuration(v ?? null)} allowClear
            >
              {videoDurations.map((d) => <Option key={d} value={d}>{d} 秒</Option>)}
            </Select>
          )}
        </div>
        {/* ===== 第 2 段：执行权限（我信不信任它自动花钱）===== */}
        <div className="border-t border-black/[0.06] pt-3 text-[11px] font-medium tracking-wide text-black/35">
          执行权限
        </div>
        <div>
          <Segmented
            block
            size="small"
            value={executeMode}
            onChange={(v) => setExecuteMode(v as AgentExecuteMode)}
            options={[
              { label: '全自动', value: 'auto' },
              { label: '执行前确认', value: 'confirm' },
            ]}
          />
          <div className="mt-1 text-[11px] leading-relaxed text-black/40">
            {executeMode === 'confirm'
              ? 'Agent 会先把要做的事列出来（方向、提示词、模型、比例、张数），你点确认后才真正生成、才扣费。'
              : 'Agent 判断完直接执行，不做二次确认。省事，但会直接扣费。'}
          </div>
        </div>

        {/* ===== 第 3 段：我的记忆（关于人的知识）===== */}
        <div className="border-t border-black/[0.06] pt-3 text-[11px] font-medium tracking-wide text-black/35">
          我的记忆
        </div>
        <div>
          <div className="mb-1 text-[12px] font-medium text-black/70">让 Agent 记住你</div>
          <Input.TextArea
            value={memoryText}
            onChange={(e) => setMemoryText(e.target.value)}
            rows={5}
            maxLength={2000}
            showCount
            placeholder={'例：我是做俄罗斯跨境电商的，主营冬季保暖用品，客群偏年轻女性；出图喜欢北欧极简风、冷色调；文案要俄语，语气简洁不夸张。'}
            className="!text-[12px]"
          />
          <div className="mt-1 text-[11px] leading-relaxed text-black/40">
            只写一次，之后每轮对话 Agent 都会带上，不用反复交代。
            <br />本会话中你明确说的内容优先于这里。
          </div>
        </div>

        <Button type="primary" block onClick={save} loading={saving}>保存</Button>
        <div className="text-[11px] leading-relaxed text-black/40">
          保存后 Agent 每轮对话自动采用；以上都是默认值，对话中明确指定的优先。
        </div>
      </Space>
    </Drawer>
  )
}
