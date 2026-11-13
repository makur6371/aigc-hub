'use client'

import React, { useEffect } from 'react'
import { Layout } from 'antd'
import { usePathname } from 'next/navigation'
import { NavRail } from './NavRail'
import { NavProgressBar } from './NavProgressBar'
// 公告已改用导航铃铛（AnnouncementBell），不再挂顶部横条
import { useAuthStore } from '@/stores/useAuthStore'
import { apiFetch } from '@/lib/api-client'
import type { User } from '@/types'

const { Content } = Layout

export function AppLayout({ children }: { children: React.ReactNode }) {
  const setUser = useAuthStore((s) => s.setUser)
  const pathname = usePathname()

  // 画布沉浸模式：隐藏横幅，最大化作图空间（导航胶囊仍保留，随时可切换页面）
  const isCanvas = pathname === '/canvas' || pathname?.startsWith('/canvas/')

  // 刷新后 Zustand 内存状态丢失，挂载时从后端恢复当前用户
  useEffect(() => {
    let alive = true
    const restore = () => apiFetch<User>('/api/user/profile', { silent401: true })
      .then((res) => {
        if (alive && res.success && res.data) {
          setUser(res.data)
        }
      })
      .catch(() => {})
    const onVisible = () => { if (document.visibilityState === 'visible') void restore() }
    void restore()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [setUser])

  return (
    <Layout className="h-screen relative">
      {/* 顶部导航进度条：客户端路由跳转即时反馈（点击即出现，切换完成淡出） */}
      <NavProgressBar />
      {/* 全局竖向导航胶囊：所有页面（含画布）固定存在 */}
      <NavRail />
      <Layout className="flex flex-col h-screen">
        <Content className="relative flex-1 overflow-hidden bg-surface">
          {/* 液态玻璃氛围底：与首页同语言的多层淡紫光晕（右上品牌紫、左下蓝紫、中部柔光） */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'radial-gradient(75% 45% at 100% 0%, rgba(125,80,224,0.10) 0%, transparent 60%), radial-gradient(55% 40% at 0% 100%, rgba(144,107,228,0.08) 0%, transparent 62%), radial-gradient(45% 35% at 30% 45%, rgba(107,43,201,0.04) 0%, transparent 70%)',
            }}
          />
          {/* 内容避让导航：桌面左侧胶囊（pl-20）；移动端悬浮球不占布局，无需避让；画布自管间距 */}
          <div className={`relative h-full ${isCanvas ? '' : 'md:pl-20'}`}>
            {children}
          </div>
        </Content>
      </Layout>
    </Layout>
  )
}
