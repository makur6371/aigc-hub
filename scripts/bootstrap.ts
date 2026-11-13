import bcrypt from 'bcryptjs'
import { createHmac } from 'node:crypto'
import { getPrisma } from '../src/lib/prisma'
import { starterImageTool } from '../src/lib/starter-image-tool'
import { starterVideoTool } from '../src/lib/starter-video-tool'
import { syncBuiltinNodes } from '../src/lib/sync-builtin-nodes'

async function main() {
  const email = (process.env.BOOTSTRAP_EMAIL ?? '').trim().toLowerCase()
  const password = process.env.BOOTSTRAP_PASSWORD ?? ''
  const args = process.argv.slice(2)
  if (args.some((arg) => !['--demo', '--user'].includes(arg)) || (args.includes('--user') && args.includes('--demo'))) {
    throw new Error('Use --demo for local models, or --user to create a regular account.')
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || Buffer.byteLength(password) > 72) {
    throw new Error('Set BOOTSTRAP_EMAIL and a password of at least 12 characters (at most 72 UTF-8 bytes).')
  }
  if (args.includes('--demo') && process.env.APP_ENABLE_DEMO !== '1') {
    throw new Error('Set APP_ENABLE_DEMO=1 to enable local demo models.')
  }
  const prisma = await getPrisma()
  try {
    const role = args.includes('--user') ? 'USER' : 'ADMIN'
    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing && existing.role !== role) throw new Error('That email belongs to an account with a different role.')
    const user = existing ?? await prisma.user.create({
      data: { email, passwordHash: await bcrypt.hash(password, 12), nickname: role === 'ADMIN' ? '管理员' : email.split('@')[0], role, securityLevel: 'HIGH' },
    })
    if (role === 'USER') {
      console.log(existing ? 'Account already exists.' : 'Account created.')
      return
    }
    for (const tool of [starterImageTool, starterVideoTool, { ...starterImageTool, slug: 'image-workflow', name: '基础图像工作流' }]) {
      await prisma.tool.upsert({
        where: { slug: tool.slug },
        update: {},
        create: { ...tool, isOfficial: true, status: 'APPROVED', tags: tool.slug.endsWith('creation') ? 'composer' : null, authorId: user.id },
      })
    }
    await syncBuiltinNodes()
    if (args.includes('--demo')) {
      const base = new URL(process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000')
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
        throw new Error('NEXT_PUBLIC_APP_URL must be an HTTP(S) origin.')
      }
      const baseUrl = base.origin + '/api/demo'
      const apiKey = createHmac('sha256', process.env.JWT_SECRET!).update('local-demo-v1').digest('hex')
      const provider = await prisma.apiProvider.upsert({
        where: { code: 'local-demo' },
        update: { baseUrl, apiKey, isActive: true },
        create: { code: 'local-demo', name: '本地演示', baseUrl, apiKey },
      })
      const adapter = await prisma.providerAdapter.upsert({
        where: { code: 'openai-image-edits' },
        update: {},
        create: { code: 'openai-image-edits', name: '通用图像编辑接口', isBuiltin: true, source: 'builtin:openai-image-edits' },
      })
      const editProvider = await prisma.apiProvider.upsert({
        where: { code: 'local-demo-image' },
        update: { baseUrl, apiKey, isActive: true, adapterId: adapter.id },
        create: { code: 'local-demo-image', name: '本地图像演示', baseUrl, apiKey, adapterId: adapter.id },
      })
      const models = [
        { id: 'demo-text', name: '本地演示 · 文本', type: 'TEXT' as const, metadata: {} },
        { id: 'demo-image', name: '本地演示 · 图像', type: 'IMAGE' as const, metadata: { modes: ['text', 'singleImage', 'multiReference'], sizes: ['1:1@1K', '16:9@1K', '9:16@1K'] } },
        { id: 'demo-video', name: '本地演示 · 视频', type: 'VIDEO' as const, metadata: { video: { constraints: { modes: ['text', 'firstLastFrame', 'multiReference'], ratios: ['16:9'], resolutions: ['480P'], durations: [4, 5, 6], maxImages: 3, maxAudios: 1, maxVideos: 1 } } } },
      ]
      for (const model of models) {
        await prisma.modelConfig.upsert({
          where: { id: model.id }, update: { isActive: true },
          create: { ...model, modelName: model.id, providerId: model.type === 'IMAGE' ? editProvider.id : provider.id, isFree: true, costPoints: 0, videoCost: model.type === 'VIDEO' ? 0 : null, pricingType: 'PER_CALL' },
        })
      }
    }
    console.log(args.includes('--demo') ? 'Workspace ready with local demo models.' : 'Workspace ready. Configure models in System settings.')
  } finally {
    await prisma.$disconnect()
  }
}

main().then(() => process.exit(0), (error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
