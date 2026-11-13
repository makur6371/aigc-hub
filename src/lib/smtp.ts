import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'

let cachedTransporter: Transporter | null = null
let cachedConfigKey = ''

/**
 * 获取或创建 SMTP 传输器。配置变更时自动重建。
 */
export async function getSmtpTransporter(
  config: { host: string; port: number; username: string; password: string; senderEmail: string; senderName: string }
): Promise<Transporter> {
  const key = `${config.host}:${config.port}:${config.username}`
  if (cachedTransporter && cachedConfigKey === key) return cachedTransporter

  const secure = config.port === 465 // SSL
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure,
    requireTLS: !secure,
    auth: { user: config.username, pass: config.password },
    pool: true, // 连接池复用
    maxConnections: 3,
  })

  // 验证连通性
  await transporter.verify()
  cachedTransporter = transporter
  cachedConfigKey = key
  return transporter
}

export interface SendMailParams {
  to: string
  subject: string
  html: string
  text?: string
}

export async function sendMail(config: {
  host: string
  port: number
  username: string
  password: string
  senderEmail: string
  senderName: string
}, params: SendMailParams): Promise<{ success: boolean; error?: string }> {
  try {
    const transporter = await getSmtpTransporter(config)
    await transporter.sendMail({
      from: `"${config.senderName}" <${config.senderEmail}>`,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : '发送失败' }
  }
}
