import { NextRequest } from 'next/server'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError } from '@/lib/api-handler'
import { sendMail } from '@/lib/smtp'
import { ORG } from '@/lib/site-content'

export const GET = apiHandler(async () => {
  const prisma = await getPrisma()
  const config = await prisma.smtpConfig.findUnique({ where: { id: 'primary' } })
  if (!config) {
    return null
  }
  const maskedPassword = config.password.length > 4
    ? config.password.slice(0, 2) + '***' + config.password.slice(-2)
    : '***'
  return { ...config, password: maskedPassword }
})

export const PUT = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const body = await request.json()
  const { host, port, username, password, senderEmail, senderName } = body

  if (!host || port == null || port === '' || !username || !senderEmail) {
    throw new Error('请填写完整')
  }
  // Number('abc')=NaN 写进 Int 列会直接 500，这里提前变 400
  const portNum = Number(port)
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new ApiHandlerError('端口需为 1-65535 的整数', 400)
  }

  const prisma = await getPrisma()
  let finalPassword = password
  if (password && password.includes('***')) {
    const existing = await prisma.smtpConfig.findUnique({ where: { id: 'primary' } })
    finalPassword = existing?.password || ''
  }

  const config = await prisma.smtpConfig.upsert({
    where: { id: 'primary' },
    update: { host, port: portNum, username, password: finalPassword, senderEmail, senderName },
    create: { id: 'primary', host, port: portNum, username, password: finalPassword, senderEmail, senderName },
  })

  return config
})

export const POST = apiHandler(async (request: NextRequest) => {
  await requireAuth(request, { admin: true })
  const { testEmail } = await request.json()
  if (!testEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail)) {
    throw new Error('请输入有效的测试邮箱')
  }

  const prisma = await getPrisma()
  const config = await prisma.smtpConfig.findUnique({ where: { id: 'primary' } })
  if (!config) {
    throw new Error('请先保存 SMTP 配置')
  }

  const result = await sendMail(
    {
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      senderEmail: config.senderEmail,
      senderName: config.senderName,
    },
    {
      to: testEmail,
      subject: `【${ORG.name}】SMTP 测试邮件`,
      html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px;background:#fff;border:1px solid #e8e8e8;border-radius:12px">
  <h2 style="color:#1677ff;margin-top:0">SMTP 配置测试成功</h2>
  <p>您的 SMTP 发件配置已正常工作。</p>
  <p style="color:#8c8c8c">发送时间: ${new Date().toLocaleString('zh-CN')}</p>
</div>`,
      text: 'SMTP 配置测试成功',
    },
  )

  if (!result.success) {
    throw new Error(`发送失败: ${result.error}`)
  }
  return null
})
