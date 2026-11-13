import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/api-auth'
import { invokeImage } from '@/lib/provider-invoker'
import { chargeRun, ChargeRunError } from '@/lib/billing/charge-run'

export const runtime = 'nodejs'
export const maxDuration = 300

// AI 消水印（工作台）：前端框选区域生成品红标注图（markedUrl），连同原图发给图像编辑模型，
// 提示词要求「用周围背景自然填充品红区域」。复用现有 provider 图生图链路（referenceImages 多图编辑），
// 按 IMAGE 模型单价扣积分，失败退款（与人声分离同模式）。
export async function POST(request: NextRequest) {
  const authUser = await getAuthUser(request)
  if (!authUser) {
    return NextResponse.json({ success: false, data: null, message: '未登录' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const imageUrl = typeof body?.imageUrl === 'string' ? body.imageUrl : ''
  const markedUrl = typeof body?.markedUrl === 'string' ? body.markedUrl : ''
  const modelId = typeof body?.modelId === 'string' ? body.modelId : undefined
  if (!imageUrl || !markedUrl) {
    return NextResponse.json({ success: false, data: null, message: '缺少原图或标注图' }, { status: 400 })
  }

  // 计费事务统一走 charge-run：模型解析（含回退）+ 免费额度 + 预扣 + 失败退款 + 调用日志
  let run
  try {
    run = await chargeRun({ userId: authUser.userId, modelType: 'IMAGE', modelId, source: 'tool' })
  } catch (err) {
    if (err instanceof ChargeRunError) {
      return NextResponse.json({ success: false, data: null, message: err.message }, { status: err.status })
    }
    throw err
  }

  // 转成上游可访问的 URL（站内相对路径 → 公网绝对地址）
  const base = process.env.NEXT_PUBLIC_APP_URL || ''
  const abs = (u: string) => (u.startsWith('http') ? u : base + u)

  const prompt = 'Remove the object marked with the translucent pink rectangle from the first image. Fill the marked area naturally by extending the surrounding background. Keep everything else exactly unchanged. Output the cleaned image.'
  const requestDetail = { prompt, modelId: run.model.id, imageUrl, markedUrl }

  try {
    const result = await run.execute(() => invokeImage(
      {
        baseUrl: run.model.baseUrl,
        apiKey: run.model.apiKey,
        adapterId: run.model.adapterId ?? undefined,
        configJson: run.model.configJson ?? undefined,
        metadata: run.model.metadata,
      },
      run.model.modelName,
      { prompt, referenceImages: [abs(imageUrl), abs(markedUrl)] },
      authUser.userId,
    ))
    if (!result.imageUrl) {
      throw new Error('上游未返回图像')
    }
    await run.settle({ nodeLabel: 'AI 消水印', request: requestDetail, response: { url: result.imageUrl } })
    return NextResponse.json({ success: true, data: { url: result.imageUrl, cost: run.cost.points }, message: '去除完成' })
  } catch (err: unknown) {
    const message = await run.fail(err, { nodeLabel: 'AI 消水印', request: requestDetail })
    return NextResponse.json({ success: false, data: null, message }, { status: 502 })
  }
}
