import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/api-auth'
import { isolateVoice } from '@/lib/perception'
import { chargeRun, ChargeRunError } from '@/lib/billing/charge-run'

export const runtime = 'nodejs'
export const maxDuration = 300

// 按所选分离模型扣积分（与画布节点同价），返回分离后的人声音频 URL。
export async function POST(request: NextRequest) {
  const authUser = await getAuthUser(request)
  if (!authUser) {
    return NextResponse.json({ success: false, data: null, message: '未登录' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const audioUrl = typeof body?.audioUrl === 'string' ? body.audioUrl : ''
  const modelId = typeof body?.modelId === 'string' ? body.modelId : undefined
  if (!audioUrl) {
    return NextResponse.json({ success: false, data: null, message: '缺少音频' }, { status: 400 })
  }

  // 计费事务统一走 charge-run：模型解析（含回退）+ 免费额度 + 预扣 + 失败退款 + 调用日志
  let run
  try {
    run = await chargeRun({ userId: authUser.userId, modelType: 'AUDIO', modelId, source: 'tool' })
  } catch (err) {
    if (err instanceof ChargeRunError) {
      return NextResponse.json({ success: false, data: null, message: err.message }, { status: err.status })
    }
    throw err
  }

  const requestDetail = { modelId: run.model.id, audioUrl }

  try {
    const url = await run.execute(() => isolateVoice({
      baseUrl: run.model.baseUrl,
      apiKey: run.model.apiKey,
      modelName: run.model.modelName,
      fileUrl: audioUrl,
      path: (run.model.configJson as Record<string, unknown> | null)?.isolationPath as string | undefined,
    }))
    await run.settle({ nodeLabel: '人声分离', request: requestDetail, response: { url } })
    return NextResponse.json({ success: true, data: { url, cost: run.cost.points }, message: '分离完成' })
  } catch (err: unknown) {
    const message = await run.fail(err, { nodeLabel: '人声分离', request: requestDetail })
    return NextResponse.json({ success: false, data: null, message }, { status: 502 })
  }
}
