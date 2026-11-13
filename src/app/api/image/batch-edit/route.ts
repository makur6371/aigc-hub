import { NextRequest, NextResponse } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { getAuthUser } from '@/lib/api-auth'
import { invokeImage } from '@/lib/provider-invoker'
import { chargeRun, ChargeRunError } from '@/lib/billing/charge-run'
export const runtime = 'nodejs'
export const maxDuration = 300

// ===== 成果区「批量操作」的单张执行单元 =====
//
// 四个批量能力（高清放大 / 抠图 / 去水印 / 翻译）**全部走图生图**：
// 把原图当参考图 + 一段针对性的提示词，交给所选 IMAGE 模型重绘。
//
// 为什么合成一个接口而不是四个：
//   1) 四者的链路完全同构（选模型 → 计费 → invokeImage(referenceImages) → 退款兜底），
//      分开写等于把同一套计费/退款/免费额度逻辑抄四遍，必然漂移；
//   2) 前端批量派发时每张一个独立任务，只有 `op` 不同，一个接口最贴合。
//
// 计费口径与画布 image-generate 节点完全一致
// （planNodeCharge 档位价 + 折扣；免费额度原子占用；失败全额退款 + 归还额度）。

type Op = 'upscale' | 'cutout' | 'dewatermark' | 'translate'

/** 各操作的基础提示词（英文，与既有 upscale/cleanup 保持同一语言风格） */
const BASE_PROMPTS: Record<Op, string> = {
  upscale:
    'Upscale and enhance this image to high resolution. Keep the composition, subject, colors and all text exactly the same as the input image. Only improve sharpness, fine details, material texture and overall clarity. Do not add or remove any element.',
  cutout:
    'Remove the background from this image and keep only the main subject. Output the subject on a fully transparent background. Keep the subject edges clean and precise (including fine details like hair, fur and semi-transparent areas). Do not change the subject itself — keep its shape, color, material and proportions exactly as in the input.',
  dewatermark:
    'Remove the watermark / logo / text overlay from this image. Fill the removed area naturally by extending the surrounding background and texture so that no trace of the watermark remains. Keep everything else in the image exactly unchanged.',
  translate:
    'Translate all the text in this image into the target language specified below, and redraw the image with the translated text. Keep the layout, composition, colors, fonts style, and all non-text elements exactly the same as the input image. The translated text must be well-typeset, correctly spelled, and clearly readable. Do not leave any text in the original language.',
}

/** 抠图的背景处理：透明白底 / 纯色 —— 由前端选，这里拼进提示词 */
function buildPrompt(op: Op, opts: { background?: string; targetLanguage?: string }): string {
  const base = BASE_PROMPTS[op]
  if (op === 'cutout') {
    const bg = (opts.background || '').trim()
    if (!bg || bg === 'transparent') return base
    return `${base}\n\nBackground requirement: instead of transparent, fill the background with a clean solid ${bg} color, with no texture or gradient.`
  }
  if (op === 'translate') {
    const lang = (opts.targetLanguage || '').trim() || 'English'
    return `${base}\n\nTarget language: ${lang}.`
  }
  return base
}

export async function POST(request: NextRequest) {
  const authUser = await getAuthUser(request)
  if (!authUser) {
    return NextResponse.json({ success: false, data: null, message: '未登录' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const op = (typeof body?.op === 'string' ? body.op : '') as Op
  const imageUrl = typeof body?.imageUrl === 'string' ? body.imageUrl : ''
  const modelId = typeof body?.modelId === 'string' ? body.modelId : undefined
  const width = Number(body?.width) || undefined
  const height = Number(body?.height) || undefined
  const background = typeof body?.background === 'string' ? body.background : undefined
  const targetLanguage = typeof body?.targetLanguage === 'string' ? body.targetLanguage : undefined

  if (!(op in BASE_PROMPTS)) {
    return NextResponse.json({ success: false, data: null, message: '不支持的批量操作' }, { status: 400 })
  }
  if (!imageUrl) {
    return NextResponse.json({ success: false, data: null, message: '缺少原图' }, { status: 400 })
  }

  const prisma = await getPrisma()
  const user = await prisma.user.findUnique({ where: { id: authUser.userId } })
  if (!user) return NextResponse.json({ success: false, data: null, message: '用户不存在' }, { status: 404 })

  // ===== 服务端任务记录（surface=batch）：刷新后前端据此恢复成果区 =====
  // 每张图一条 run；前端认领时按 claimedRunId 去重。nodes/connections 对纯生图无意义，
  // 存最小占位（空数组）保持 schema 允许。
  const taskRun = await prisma.canvasRun.create({
    data: {
      userId: user.id,
      workflowName: `批量${({ upscale: '高清放大', cutout: '抠图', dewatermark: '去水印', translate: '翻译' } as Record<string, string>)[op] ?? op}`,
      surface: 'batch',
      nodes: [],
      connections: [],
      status: 'RUNNING',
    },
  })

  // 模型解析 → 档位计价 → 免费额度 → 预扣，统一由 charge-run 负责（与其余生成入口同一实现）
  let run: Awaited<ReturnType<typeof chargeRun>>
  try {
    run = await chargeRun({
      userId: user.id,
      modelType: 'IMAGE',
      modelId,
      width,
      height,
      source: 'api',
      runId: taskRun.id,
    })
  } catch (err) {
    await prisma.canvasRun.update({
      where: { id: taskRun.id },
      data: { status: 'FAILED', error: err instanceof Error ? err.message : '计费失败' },
    }).catch(() => {})
    if (err instanceof ChargeRunError) {
      return NextResponse.json({ success: false, data: null, message: err.message }, { status: err.status })
    }
    throw err
  }
  const cost = run.cost.points
  const actualWidth = run.imageSize?.width ?? width
  const actualHeight = run.imageSize?.height ?? height

  // 站内相对路径 → 公网绝对地址（上游要能拉到图）。
  // 前端 toServerUrl 已经拼过一次绝对地址；这里兜底，防止旧客户端/直接调接口漏掉。
  const base = process.env.NEXT_PUBLIC_APP_URL || ''
  const abs = (u: string) => (u.startsWith('http') ? u : base + u)

  const opLabel: Record<Op, string> = { upscale: '高清放大', cutout: '抠图', dewatermark: '去水印', translate: '翻译' }

  try {
    const prompt = buildPrompt(op, { background, targetLanguage })
    const requestDetail = { prompt, imageUrl, modelId: run.model.id, width: actualWidth, height: actualHeight }
    const result = await run.execute(() => invokeImage(
      { baseUrl: run.model.baseUrl, apiKey: run.model.apiKey, adapterId: run.model.adapterId ?? undefined, configJson: run.model.configJson ?? undefined, metadata: run.model.metadata },
      run.model.modelName,
      { prompt, referenceImages: [abs(imageUrl)], width: actualWidth, height: actualHeight },
      user.id,
    ))
    if (!result.imageUrl) throw new Error('上游未返回图像')
    await prisma.canvasRun.update({
      where: { id: taskRun.id },
      data: {
        status: 'SUCCEEDED',
        seedOutputs: { [`gen-${op}`]: { imageUrl: result.imageUrl } },
        resultNodeIds: [`gen-${op}`],
        costPoints: cost,
      },
    })
    await run.settle({ nodeLabel: opLabel[op], request: requestDetail, response: { url: result.imageUrl } })
    return NextResponse.json({ success: true, data: { url: result.imageUrl, cost }, message: `${opLabel[op]}完成` })
  } catch (err: unknown) {
    // 退款 + 归还额度 + 写失败调用日志（统一实现）
    const message = await run.fail(err, { nodeLabel: opLabel[op], request: { op, imageUrl, modelId: run.model.id, width: actualWidth, height: actualHeight } })
    await prisma.canvasRun.update({
      where: { id: taskRun.id },
      data: { status: 'FAILED', error: message.slice(0, 500) },
    }).catch(() => {})
    return NextResponse.json({ success: false, data: null, message }, { status: 502 })
  }
}
