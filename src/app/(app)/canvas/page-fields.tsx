'use client'

// 画布节点的输入渲染与上传队列（纯函数，状态由参数传入）
//
// 从 canvas/page.tsx 抽出：这三个函数不依赖组件内任何 state，
// 只通过 setCanvasNodes 回写，抽离后页面文件聚焦交互逻辑。

import React from 'react'
import { Input, InputNumber, Select, Switch, Upload, message } from 'antd'
import { InboxOutlined } from '@ant-design/icons'
import type { UploadFile } from 'antd'
import { modelTypesForCategory } from '@/lib/media-kinds'
import { getVideoCapabilities, DEFAULT_VIDEO_RATIOS, DEFAULT_VIDEO_RESOLUTIONS, resolveVideoDurations, normalizeVideoResolution } from '@/lib/video-capabilities'

const { TextArea } = Input
import { compressImageDataUrl, type CanvasNode, type NodePort } from '@/lib/canvas-utils'
import { decodeSize, findImageSize, getImageCapabilities } from '@/lib/image-sizes'

// 批量上传合帧队列：N 张图只触发 1 次 setCanvasNodes（50ms 窗口内到达的先并行压缩再一次性追加）
const pendingUploads = new Map<string, string[]>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
export function enqueueImage(
  nodeId: string,
  dataUrl: string,
  setCanvasNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>>
) {
  const arr = pendingUploads.get(nodeId) ?? []
  arr.push(dataUrl)
  pendingUploads.set(nodeId, arr)
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const batches = new Map(pendingUploads)
    pendingUploads.clear()
    for (const [nid, raws] of batches) {
      void Promise.all(raws.map((r) => compressImageDataUrl(r))).then((compressed) => {
        setCanvasNodes((prev) =>
          prev.map((n) =>
            n.id === nid
              ? { ...n, inputs: { ...n.inputs, images: [...(Array.isArray(n.inputs.images) ? (n.inputs.images as string[]) : []), ...compressed] } }
              : n
          )
        )
      })
    }
  }, 50)
}

// 单图上传大小守卫：超过 20MB 拒绝读取（base64 会膨胀 ~1.33 倍）
export function isImageFileTooLarge(file: File): boolean {
  return file.size > 20 * 1024 * 1024
}

export function renderInputField(
  node: CanvasNode,
  key: string,
  port: NodePort,
  setCanvasNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>>,
  modelOptions: { id: string; name: string; type: string; metadata?: Record<string, unknown> | null }[],
  modelsLoading?: boolean
) {
  const value = node.inputs[key]

  const update = (newValue: unknown) => {
    setCanvasNodes((prev) =>
      prev.map((n) => (n.id === node.id ? { ...n, inputs: { ...n.inputs, [key]: newValue } } : n))
    )
  }
  // 一次写入宽高两个字段（比例/档位联动下拉用）
  const updateSize = (width: number, height: number) => {
    setCanvasNodes((prev) =>
      prev.map((n) => (n.id === node.id ? { ...n, inputs: { ...n.inputs, width, height } } : n))
    )
  }

  // model 字段：下拉选模型（按节点类别过滤：llm 类选 TEXT/VISION，image 类选 IMAGE，video 类选 VIDEO）
  if (key === 'model') {
    const wantTypes = modelTypesForCategory(node.category)
    const options = modelOptions
      .filter((m) => wantTypes.includes(m.type))
      .map((m) => ({ value: m.id, label: `${m.name} ${m.type}` }))
    return (
      <Select
        showSearch
        className="w-full"
        size="small"
        value={value ? String(value) : undefined}
        onChange={(v) => update(v)}
        placeholder="搜索并选择模型"
        allowClear
        optionFilterProp="label"
        options={options}
        loading={modelsLoading}
        notFoundContent={options.length === 0 ? (modelsLoading ? '模型加载中...' : '暂无可用模型') : undefined}
      />
    )
  }

  if (port.type === 'boolean') {
    return <Switch size="small" checked={!!value} onChange={(v) => update(v)} />
  }

  // 视频生成节点的画幅 / 清晰度 / 时长：按所选视频模型声明的能力过滤选项，
  // 与工具箱面板、Agent 偏好使用同一个 getVideoCapabilities（口径唯一），
  // 避免用户选了上游不支持的规格、提交后才失败。
  if (node.type === 'video-generate' && (key === 'aspectRatio' || key === 'resolution' || key === 'duration')) {
    const modelId = node.inputs.model as string | undefined
    const model = modelOptions.find((m) => m.id === modelId)
    const cap = getVideoCapabilities(model ? { metadata: model.metadata } : null)
    if (key === 'aspectRatio') {
      const ratios = cap.ratios.length > 0 ? cap.ratios : DEFAULT_VIDEO_RATIOS
      return (
        <Select
          className="w-full" size="small" value={value ? String(value) : undefined}
          onChange={(v) => update(v)} placeholder="比例" allowClear
          options={ratios.map((r) => ({ value: r, label: r }))}
        />
      )
    }
    if (key === 'resolution') {
      const resolutions = (cap.resolutions.length > 0 ? cap.resolutions : DEFAULT_VIDEO_RESOLUTIONS).map(normalizeVideoResolution)
      return (
        <Select
          className="w-full" size="small"
          value={value ? normalizeVideoResolution(String(value)) : undefined}
          onChange={(v) => update(v)} placeholder="清晰度" allowClear
          options={resolutions.map((r) => ({ value: r, label: r }))}
        />
      )
    }
    // duration
    const durations = resolveVideoDurations(cap)
    return (
      <Select
        className="w-full" size="small" value={value != null && value !== '' ? Number(value) : undefined}
        onChange={(v) => update(v)} placeholder="时长（秒）" allowClear
        options={durations.map((d) => ({ value: d, label: `${d} 秒` }))}
      />
    )
  }

  if (port.type === 'number') {
    // 生图节点的 width/height:模型配了预设尺寸时渲染为「比例+档位」联动下拉(只列勾选过的组合,避免传非法尺寸报错)
    if ((node.type === 'image-generate' || node.type === 'nine-grid-loop') && (key === 'width' || key === 'height')) {
      const modelId = node.inputs.model as string | undefined
      const model = modelOptions.find((m) => m.id === modelId)
      const imageCap = getImageCapabilities(model)
      if (imageCap.declared && imageCap.sizes.length > 0) {
        if (key === 'width') {
          // 宽度槽位渲染整套联动控件；高度槽位渲染占位(值由宽度槽位统一写入)
          const decoded = imageCap.sizes
          const ratios = [...new Set(decoded.map((d) => d.ratio))]
          const current = decodeSize(`${Number(node.inputs.width) || 0}x${Number(node.inputs.height) || 0}`)
          const selRatio = current && ratios.includes(current.ratio) ? current.ratio : undefined
          const selTier = selRatio && current?.tier ? current.tier : undefined
          const tierOptions = selRatio
            ? decoded.filter((d) => d.ratio === selRatio).map((d) => ({ value: d.tier, label: `${d.tier} (${d.width}x${d.height})` }))
            : []
          return (
            <div className="flex gap-1.5">
              <Select
                className="flex-1 min-w-0"
                size="small"
                value={selRatio}
                onChange={(r) => {
                  // 切比例后自动带出该比例第一个档位
                  const first = findImageSize(imageCap, r)
                  if (first) updateSize(first.width, first.height)
                }}
                options={ratios.map((r) => ({ value: r, label: r }))}
                placeholder="比例"
              />
              <Select
                className="flex-1 min-w-0"
                size="small"
                value={selTier || undefined}
                onChange={(t) => {
                  const hit = decoded.find((d) => d.ratio === selRatio && d.tier === t)
                  if (hit) updateSize(hit.width, hit.height)
                }}
                options={tierOptions}
                placeholder="档位"
                disabled={!selRatio}
              />
            </div>
          )
        }
        return null
      }
    }
    return <InputNumber className="w-full" size="small" value={Number(value) || 0} onChange={(v) => update(v)} />
  }

  // 图片批量上传节点：多图上传(点击/拖拽/粘贴,张数不限)；批量走合帧队列避免逐张卡顿
  if (node.type === 'image-upload-batch' && key === 'images') {
    const images = Array.isArray(node.inputs.images) ? (node.inputs.images as string[]) : []
    const readAndEnqueue = (file: File) => {
      if (isImageFileTooLarge(file)) { message.error(`图片 ${file.name} 超过 20MB，已跳过`); return }
      const reader = new FileReader()
      reader.onload = () => enqueueImage(node.id, reader.result as string, setCanvasNodes)
      reader.onerror = () => message.error('读取图片失败')
      reader.readAsDataURL(file)
    }
    return (
      <div
        tabIndex={0}
        data-paste-zone
        onPaste={(e) => {
          const items = e.clipboardData?.items
          if (!items) return
          let pasted = 0
          for (const item of items) {
            if (item.type.startsWith('image/')) {
              const file = item.getAsFile()
              if (!file) continue
              e.preventDefault()
              readAndEnqueue(file)
              pasted++
            }
          }
          if (pasted > 0) message.success(pasted > 1 ? `已粘贴 ${pasted} 张图片` : '已粘贴图片')
        }}
        className="focus:outline-none"
      >
        <Upload.Dragger
          multiple
          name="images"
          fileList={images.map((v, i) => ({ uid: `img-${node.id}-${i}`, name: `图 ${i + 1}`, status: 'done', url: v }))}
          beforeUpload={(file) => {
            readAndEnqueue(file)
            return false
          }}
          onRemove={(file) => {
            setCanvasNodes((prev) =>
              prev.map((n) =>
                n.id === node.id
                  ? { ...n, inputs: { ...n.inputs, images: (Array.isArray(n.inputs.images) ? (n.inputs.images as string[]) : []).filter((v) => v !== file.url) } }
                  : n
              )
            )
            return true
          }}
          accept="image/*"
          className="bg-surface"
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text text-xs px-2">
            点击 / 拖拽 / Ctrl+V 上传多张图片（张数不限）
          </p>
        </Upload.Dragger>
      </div>
    )
  }

  if (port.type === 'image') {
    const fileList: UploadFile[] =
      typeof value === 'string' && (value.startsWith('data:image') || value.startsWith('http'))
        ? [
            {
              uid: `image-${node.id}-${key}`,
              name: 'image',
              status: 'done',
              url: value,
            },
          ]
        : []

    return (
      <div
        tabIndex={0}
        data-paste-zone
        onPaste={(e) => {
          const items = e.clipboardData?.items
          if (!items) return
          for (const item of items) {
            if (item.type.startsWith('image/')) {
              const file = item.getAsFile()
              if (!file) continue
              if (isImageFileTooLarge(file)) {
                message.warning('图片超过 20MB，请压缩后再上传')
                e.preventDefault()
                return
              }
              e.preventDefault()
              const reader = new FileReader()
              reader.onload = async () => {
                update(await compressImageDataUrl(reader.result as string))
                message.success('已粘贴图片')
              }
              reader.readAsDataURL(file)
              return
            }
          }
        }}
        className="focus:outline-none"
      >
        <Upload.Dragger
          name={key}
          fileList={fileList}
          beforeUpload={(file) => {
            if (isImageFileTooLarge(file)) {
              message.warning('图片超过 20MB，请压缩后再上传')
              return false
            }
            const reader = new FileReader()
            reader.onload = async () => {
              update(await compressImageDataUrl(reader.result as string))
            }
            reader.onerror = () => message.error('读取图片失败')
            reader.readAsDataURL(file)
            return false
          }}
          onRemove={() => {
            update('')
          }}
          accept="image/*"
          multiple={false}
          className="bg-surface"
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text text-xs px-2">
            点击 / 拖拽 / Ctrl+V 粘贴图片
          </p>
        </Upload.Dragger>
      </div>
    )
  }

  if (port.type === 'string' && (key === 'prompt' || key === 'systemPrompt' || key === 'negativePrompt' || key === 'template' || key === 'content')) {
    return (
      <TextArea
        rows={node.type === 'text-input' ? 6 : 3}
        size="small"
        value={String(value || '')}
        onChange={(e) => update(e.target.value)}
        placeholder={node.type === 'text-input' ? '输入文本（支持多行）' : undefined}
      />
    )
  }

  if (port.type === 'string' && (key === 'operator' || key === 'method' || key === 'format')) {
    const options =
      key === 'operator'
        ? ['equals', 'contains', 'greaterThan', 'lessThan']
        : key === 'method'
        ? ['GET', 'POST', 'PUT', 'DELETE']
        : ['plain', 'markdown', 'html']
    return (
      <Select
        size="small"
        className="w-full"
        value={String(value || port.defaultValue || options[0])}
        options={options.map((o) => ({ value: o, label: o }))}
        onChange={(v) => update(v)}
      />
    )
  }

  if (port.type === 'object') {
    return (
      <TextArea
        rows={3}
        size="small"
        value={typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value || '')}
        placeholder='{"key":"value"}'
        onChange={(e) => {
          try {
            update(JSON.parse(e.target.value))
          } catch {
            update(e.target.value)
          }
        }}
      />
    )
  }

  return <Input size="small" value={String(value || '')} onChange={(e) => update(e.target.value)} />
}
