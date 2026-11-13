import type { Metadata } from 'next'
import { ORG } from '../_content'
import ModelPricingClient from '@/components/site/ModelPricingClient'
import { loadPricingCatalog } from '@/lib/billing/model-pricing-catalog'
import { resolveVideoConstraints } from '@/lib/billing/billing-plans'
import { getPrisma } from '@/lib/prisma'
import type { PackageTier } from '@/lib/billing/model-pricing-calc'

// 内测页面：先不挂到 (public) layout 的主导航里，避免被当成对外正式价格传播。
// 访问方式：直接打开 /model-pricing。
export const metadata: Metadata = {
  title: `模型价格（内测） - ${ORG.name}`,
  description: `${ORG.name} 模型价格内测页：按模型、按清晰度档位与视频分辨率档列出现价，并可按充值档位换算可用次数。`,
  robots: { index: false, follow: false },
}

export const dynamic = 'force-dynamic'

export default async function ModelPricingPage() {
  const prisma = await getPrisma()
  const [catalog, pkgRows] = await Promise.all([
    loadPricingCatalog(),
    prisma.rechargePackage.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
  ])

  const packages: PackageTier[] = pkgRows.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    priceCents: p.priceCents,
    points: p.points,
    beans: p.beans,
    isSubscription: p.isSubscription,
    durationDays: p.durationDays,
  }))

  // 视频时长/分辨率的可选项直接来自模型自身约束 —— 让用户换算时选到的
  // 一定是这个模型真能跑的参数，不会算出「其实跑不了」的次数。
  const videoModels = await prisma.modelConfig.findMany({
    where: { isActive: true, isPublic: true, type: 'VIDEO', provider: { isActive: true } },
    select: { id: true, metadata: true },
  })
  const videoHints: Record<string, { durations?: number[]; minDuration?: number | null; maxDuration?: number | null }> = {}
  for (const m of videoModels) {
    const c = resolveVideoConstraints({ costPoints: 0, metadata: m.metadata as Record<string, unknown> | null })
    if (!c) continue
    videoHints[m.id] = {
      durations: c.durations?.length ? c.durations : undefined,
      minDuration: c.minDuration ?? null,
      maxDuration: c.maxDuration ?? null,
    }
  }

  return (
    <>
      <section className="mb-8">
        <h1 className="text-3xl md:text-4xl font-bold text-foreground mb-3">模型价格</h1>
        <p className="text-base text-text-muted leading-relaxed max-w-3xl">
          平台按模型计价：对话、生图、视频各按自己的口径扣额度。下表价格与实际结算同源，
          选择你的充值档位即可看到这一档在每个模型上大约能跑多少次。
        </p>
      </section>

      <ModelPricingClient
        rows={catalog.rows}
        packages={packages}
        videoHints={videoHints}
        note={catalog.note}
      />
    </>
  )
}
