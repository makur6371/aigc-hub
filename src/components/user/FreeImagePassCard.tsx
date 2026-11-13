'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { FieldTimeOutlined, GiftOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'

export interface FreeImagePassInfo {
  freeImagePass?: { enabled: boolean; limited: boolean; reason: string | null; models: Array<{ id: string; name: string }> }
  freeImageUntil?: string | null
  freeImageWelcomeStartsAt?: string
  freeImageWelcomeClaimedAt?: string | null
  freeImageGrants?: Array<{
    id: string
    source?: string
    minutes: number
    description: string
    startsAt?: string
    createdAt: string
    expiresAt: string
  }>
}

const grantSourceLabels: Record<string, string> = {
  WELCOME: '公告领取',
  SUBSCRIPTION: '月度套餐',
  CHECKIN: '签到',
  INVITE: '邀请',
  ADMIN: '客服赠送',
}

function formatGrantDuration(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`
  if (minutes % 60 === 0) return `${minutes / 60} 小时`
  return `${minutes} 分钟`
}

export function FreeImagePassCard({ info, onRefresh }: { info: FreeImagePassInfo; onRefresh?: () => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!onRefresh) return
    const refreshAt = [info.freeImageWelcomeStartsAt, info.freeImageUntil]
      .filter((value): value is string => !!value)
      .map((value) => new Date(value).getTime())
      .filter((value) => value > Date.now())
      .sort((left, right) => left - right)[0]
    const delay = refreshAt ? refreshAt - Date.now() : 0
    const timer = delay > 0 && delay < 2_147_483_647 ? window.setTimeout(onRefresh, delay + 200) : null
    const onVisible = () => { if (document.visibilityState === 'visible') onRefresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      if (timer != null) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [info.freeImageUntil, info.freeImageWelcomeStartsAt, onRefresh])

  const remaining = info.freeImageUntil ? Math.max(0, new Date(info.freeImageUntil).getTime() - now) : 0
  const minutes = Math.ceil(remaining / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const pending = !!info.freeImageWelcomeStartsAt && new Date(info.freeImageWelcomeStartsAt).getTime() > now
  const policy = info.freeImagePass
  const blocked = policy && (!policy.enabled || !policy.models.length || policy.reason === 'user-limit' || policy.reason === 'platform-limit')
  const status = remaining > 0 ? blocked ? '时长有效 · 暂不可用' : '使用中' : pending ? '即将开放' : '暂无生效时长'

  return (
    <section aria-label="我的生图时长" className="overflow-hidden rounded-[28px] border border-accent/15 bg-gradient-to-br from-accent-light/80 via-surface/90 to-surface/70 shadow-sm backdrop-blur-xl">
      <div className="flex flex-wrap items-start justify-between gap-5 p-5 sm:p-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
            <FieldTimeOutlined className="text-accent" /> 我的生图时长
            <span className="rounded-full bg-accent/10 px-2.5 py-1 text-xs text-accent">{status}</span>
          </div>
          <div className="mt-3 text-3xl font-semibold tabular-nums tracking-tight text-accent" aria-live="off">
            {remaining > 0 ? `${days > 0 ? `${days} 天 ` : ''}${hours} 小时 ${minutes % 60} 分` : pending ? '上线领 1 天' : '时长已用完'}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-text-secondary">
            {remaining > 0 && info.freeImageUntil ? `至 ${dayjs(info.freeImageUntil).format('YYYY-MM-DD HH:mm')}，${!policy ? '指定模型按当前规则免费使用。' : !policy.enabled ? '时长券免费服务暂时关闭。' : !policy.models.length ? '暂未配置可用模型。' : policy.reason === 'user-limit' ? '今日用券已达上限，明天再来。' : policy.reason === 'platform-limit' ? '今日平台用券额度已满，明天再来。' : policy.limited ? '指定模型免费使用，受每日限额约束。' : '指定模型不限次使用。'}` : '无生效时长时，指定免费模型仍可使用每日免费额度。'}
          </p>
          {!!policy?.models.length && <p className="mt-1 break-words text-xs leading-relaxed text-text-secondary">适用模型：{policy.models.map((model) => model.name).join('、')}</p>}
          <p className="mt-1 text-xs leading-relaxed text-text-muted">1 天 = 连续 24 小时，领取即生效，多次赠送自动叠加。</p>
        </div>
        <Link href="/create" className="rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent">去创作 →</Link>
      </div>
      <div className="border-t border-accent/10 bg-surface/40 px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-secondary">
          <span><GiftOutlined className="mr-1.5 text-accent" />{info.freeImageWelcomeClaimedAt ? '上线礼 · 1 天券已领取' : `${info.freeImageWelcomeStartsAt ? dayjs(info.freeImageWelcomeStartsAt).format('M 月 D 日') : ''}起，阅读公告并确认领取 1 天券`}</span>
          <span>体验版 3 天 · 专业版 5 天 · 旗舰版 10 天</span>
        </div>
        {!!info.freeImageGrants?.length && (
          <details className="mt-3 text-xs text-text-secondary">
            <summary className="w-fit cursor-pointer rounded py-1 text-accent focus-visible:outline-2 focus-visible:outline-accent">
              领取日志 · 看看时长是怎么来的
            </summary>
            <ul className="mt-2 space-y-2.5">
              {info.freeImageGrants.map((grant) => (
                <li key={grant.id} className="rounded-xl bg-surface/70 px-3 py-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="break-words">
                      {grant.source && (
                        <span className="mr-1.5 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
                          {grantSourceLabels[grant.source] || grant.source}
                        </span>
                      )}
                      {grant.description}
                      <span className="ml-1 font-medium text-accent">+{formatGrantDuration(grant.minutes)}</span>
                    </span>
                    <time className="text-text-muted" dateTime={grant.createdAt}>{dayjs(grant.createdAt).format('MM-DD HH:mm')}</time>
                  </div>
                  <div className="mt-1 text-[11px] text-text-muted">
                    领取后 {grant.startsAt ? dayjs(grant.startsAt).format('MM-DD HH:mm') : '立即'} 生效 · 到期 {dayjs(grant.expiresAt).format('MM-DD HH:mm')}
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-text-muted">只展示最近 10 笔；多次赠送会在原到期时间上继续叠加。</p>
          </details>
        )}
      </div>
    </section>
  )
}
