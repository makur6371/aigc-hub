'use client'

import React, { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Avatar, App } from 'antd'
import { AnnouncementBell, AnnouncementPanel } from './AnnouncementBell'
import {
  HomeOutlined,
  BlockOutlined,
  ThunderboltOutlined,
  EditOutlined,
  AppstoreFilled,
  BookOutlined,
  UserOutlined,
  SettingOutlined,
  LogoutOutlined,
  DashboardOutlined,
  AppstoreOutlined,
  MenuOutlined,
  CloseOutlined,
  BellOutlined,
} from '@ant-design/icons'
import { useAuthStore } from '@/stores/useAuthStore'
import { apiFetch } from '@/lib/api-client'
import { NAV_START_EVENT } from './NavProgressBar'

// 顺序即导航顺序。Agent 排第二：它已是平台主力（多轮 + Skills + 成果区排队），
// 也是首页创作入口的默认落点之一，藏在工具箱后面会让新用户找不到。
const NAV_ITEMS = [
  { href: '/', label: '首页', icon: <HomeOutlined /> },
  // 创作工作区（2026-11-08）：图像/视频生成的沉浸式 composer 试点，
  // 不属于工具箱/画布/Agent —— 独立入口，工具箱里不再重复出现。
  { href: '/create', label: '创作', icon: <EditOutlined /> },
  { href: '/tools', label: '工具箱', icon: <ThunderboltOutlined /> },
  { href: '/canvas', label: '画布', icon: <BlockOutlined /> },
  { href: '/gallery', label: '作品广场', icon: <AppstoreFilled /> },
  { href: '/prompts', label: '提示词库', icon: <BookOutlined /> },
]

// 「个人中心」与「MCP 连接」都不占导航行：前者由底部头像圆钮进入，
// 后者作为个人中心内的一个 Tab（导航栏只放创作/浏览类入口，避免堆叠）

/**
 * 全局导航：
 * - 桌面：左侧竖向胶囊（微紫透明玻璃），悬停横向展开为带文字说明的面板
 * - 移动端（<768px）：左下角悬浮圆球，点击向上展开悬浮菜单（不占宽度，避开画布 Copilot 胶囊）
 */
export function NavRail() {
  const pathname = usePathname()
  const router = useRouter()
  const { message } = App.useApp()
  const user = useAuthStore((state) => state.user)
  const setUser = useAuthStore((state) => state.setUser)
  const [touchOpen, setTouchOpen] = useState(false)
  // 移动端公告面板控制
  const [bellOpen, setBellOpen] = useState(false)
  // 导航跳转 pending：点击后立刻高亮目标项 + 按钮按压反馈，避免「点了没反应」的错觉
  const [pendingHref, setPendingHref] = useState<string | null>(null)

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname?.startsWith(href))
  // Link 是 <a>，会被全局链接蓝色影响；导航必须显式锁品牌紫。
  const navColor = (href: string) => (isActive(href) || pendingHref === href ? 'var(--accent)' : '#5b3aa8')

  // 统一跳转入口：先给即时反馈（pending 高亮），再在 transition 里切路由
  const navigate = (href: string) => {
    if (href === pathname) return
    setPendingHref(href)
    // 程序化跳转（头像/个人中心）也要让顶部进度条立即开始推进
    window.dispatchEvent(new Event(NAV_START_EVENT))
    router.push(href)
  }

  // 路由落地（pathname 变化）后清掉 pending 高亮；用派生比较代替 effect setState
  const [lastPathname, setLastPathname] = useState(pathname)
  if (pathname !== lastPathname) {
    setLastPathname(pathname)
    if (pendingHref) setPendingHref(null)
  }

  const handleLogout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' })
    } catch { /* cookie cleared server-side regardless */ }
    setUser(null)
    message.success('已退出登录')
    router.replace('/login')
  }

  const isAdminRole = user?.role === 'ADMIN'
  // 管理员页面类选项平铺进导航（按真实角色判断）
  const ADMIN_NAV_ITEMS = isAdminRole ? [
    { href: '/admin/settings', label: '系统设置', icon: <SettingOutlined /> },
    { href: '/admin/content', label: '内容管理', icon: <AppstoreOutlined /> },
    { href: '/admin/ops', label: '运维面板', icon: <DashboardOutlined /> },
  ] : []

  const itemBtn = (item: { href: string; label: string; icon: React.ReactNode }) => (
    <Link
      key={item.href}
      href={item.href}
      prefetch
      onClick={(event) => {
        if (item.href === pathname) { event.preventDefault(); return }
        setPendingHref(item.href)
      }}
      style={{ color: navColor(item.href) }}
      title={item.label}
      aria-current={isActive(item.href) ? 'page' : undefined}
      className={`flex h-10 w-full items-center gap-3 rounded-xl px-3 text-base transition-all duration-150 active:scale-[0.97] ${
        isActive(item.href) || pendingHref === item.href
          ? 'bg-white/85 text-accent shadow-sm'
          : 'text-[#5b3aa8]/80 hover:bg-white/60 hover:text-accent'
      }`}
    >
      <span className="flex w-5 shrink-0 justify-center">{item.icon}</span>
      <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">{item.label}</span>
      {(isActive(item.href) || pendingHref === item.href) && (
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full bg-accent ${pendingHref === item.href ? 'animate-pulse' : ''}`} />
      )}
    </Link>
  )

  const avatarEl = (
    <button
      type="button"
      onClick={() => router.push(user ? '/user/profile' : '/login')}
      title={user ? '个人中心' : '登录 / 注册'}
      className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-white/60 transition-all duration-150 active:scale-95"
    >
      {user ? (
        <Avatar size={28} icon={<UserOutlined />} className="bg-accent" />
      ) : (
        <Avatar size={28} icon={<UserOutlined />} className="bg-white/70 !text-[#5b3aa8]" />
      )}
    </button>
  )

  return (
    <>
      {/* 桌面：左侧竖向胶囊，悬停展开为说明面板 */}
      <nav
        className={`nav-rail group hidden md:flex fixed left-3 top-1/2 -translate-y-1/2 z-40 flex-col gap-1 p-2 rounded-3xl backdrop-blur-xl ring-1 ring-white/30 shadow-[0_6px_24px_rgba(90,50,180,0.18)] w-14 hover:w-36 transition-[width] duration-200 overflow-clip ${touchOpen ? '!w-36' : ''}`}
        style={{
          background: 'linear-gradient(180deg, rgba(150,118,226,0.20) 0%, rgba(120,86,210,0.14) 100%)',
        }}
        onTouchStart={() => setTouchOpen((o) => !o)}
      >
        <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
        {NAV_ITEMS.map(item => itemBtn(item))}
        {/* 个人中心 由底部头像进入；此处仅平铺管理员页面项 */}
        {isAdminRole && ADMIN_NAV_ITEMS.map(item => itemBtn(item))}
        {/* 底部动作区：公告铃铛(时间线) + 头像(进个人中心/登录) + 退出登录，竖排 */}
        <div className="mt-1 border-t border-white/25 pt-2 w-full flex flex-col items-center gap-1">
          {user && <AnnouncementBell />}
          {avatarEl}
          {user && (
            <button
              type="button"
              onClick={handleLogout}
              title="退出登录"
              className="flex h-8 w-8 items-center justify-center rounded-full text-[#5b3aa8]/60 hover:bg-red-50 hover:text-red-500 transition-colors"
            >
              <LogoutOutlined />
            </button>
          )}
        </div>
      </nav>

      {/* 移动端：左下角悬浮圆球，点击向上展开悬浮菜单（不占宽度，避开画布 Copilot 胶囊所在右下区域） */}
      <nav className="md:hidden">
        {/* 悬浮球 */}
        <button
          type="button"
          onClick={() => setTouchOpen((o) => !o)}
          className="nav-mobile-ball fixed left-3 bottom-4 z-40 grid size-12 place-items-center rounded-full backdrop-blur-xl ring-1 ring-white/30 shadow-[0_6px_24px_rgba(90,50,180,0.28)] transition-transform active:scale-95"
          style={{
            background: 'linear-gradient(180deg, rgba(150,118,226,0.35) 0%, rgba(120,86,210,0.25) 100%)',
          }}
          aria-label="菜单"
        >
          {touchOpen ? <CloseOutlined className="text-base text-[#4a2f8f]" /> : <MenuOutlined className="text-base text-[#4a2f8f]" />}
        </button>
        {/* 向上展开的悬浮菜单（不占布局宽度） */}
        {touchOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setTouchOpen(false)} />
            <div
              className="nav-mobile-popover fixed left-3 bottom-20 z-40 flex flex-col gap-0.5 w-40 rounded-2xl p-2 backdrop-blur-xl ring-1 ring-white/30 shadow-[0_8px_32px_rgba(90,50,180,0.25)]"
              style={{
                background: 'linear-gradient(180deg, rgba(150,118,226,0.30) 0%, rgba(120,86,210,0.22) 100%)',
                animation: 'canvasPanelIn 0.18s ease',
              }}
            >
              {NAV_ITEMS.map(item => (
                <Link
                  key={item.href}
                  href={item.href}
                  prefetch
                  onClick={(event) => {
                    setTouchOpen(false)
                    if (item.href === pathname) { event.preventDefault(); return }
                    setPendingHref(item.href)
                  }}
                  style={{ color: navColor(item.href) }}
                  className={`flex h-10 items-center gap-3 rounded-xl px-3 text-sm transition-all duration-150 active:scale-[0.97] ${
                    isActive(item.href) || pendingHref === item.href ? 'bg-white/85 text-accent font-medium' : 'text-[#4a2f8f]'
                  }`}
                >
                  <span className="flex w-5 shrink-0 justify-center">{item.icon}</span>
                  {item.label}
                </Link>
              ))}
              {/* 管理员页面（个人中心由头像进入） */}
              {isAdminRole && ADMIN_NAV_ITEMS.map(item => (
                <Link
                  key={item.href}
                  href={item.href}
                  prefetch
                  onClick={(event) => {
                    setTouchOpen(false)
                    if (item.href === pathname) { event.preventDefault(); return }
                    setPendingHref(item.href)
                  }}
                  style={{ color: navColor(item.href) }}
                  className={`flex h-10 items-center gap-3 rounded-xl px-3 text-sm transition-all duration-150 active:scale-[0.97] ${
                    isActive(item.href) || pendingHref === item.href ? 'bg-white/85 text-accent font-medium' : 'text-[#4a2f8f]'
                  }`}
                >
                  <span className="flex w-5 shrink-0 justify-center">{item.icon}</span>
                  {item.label}
                </Link>
              ))}
              <div className="h-px bg-white/25 my-1" />
              {user ? (
                <>
                  <button
                    type="button"
                    onClick={() => { setTouchOpen(false); navigate('/user/profile') }}
                    className={`flex h-10 items-center gap-3 rounded-xl px-3 text-sm transition-all duration-150 active:scale-[0.97] ${
                      isActive('/user') ? 'bg-white/85 text-accent font-medium' : 'text-[#4a2f8f]'
                    }`}
                  >
                    <span className="flex w-5 shrink-0 justify-center">
                      <Avatar size={20} icon={<UserOutlined />} className="bg-accent" />
                    </span>
                    个人中心
                  </button>
                  <button
                    type="button"
                    onClick={() => { setTouchOpen(false); setBellOpen(true) }}
                    className="flex h-10 items-center gap-3 rounded-xl px-3 text-sm text-[#4a2f8f]"
                  >
                    <span className="flex w-5 shrink-0 justify-center"><BellOutlined /></span>
                    消息
                  </button>
                  <button
                    type="button"
                    onClick={() => { setTouchOpen(false); handleLogout() }}
                    className="flex h-10 items-center gap-3 rounded-xl px-3 text-sm text-red-500"
                  >
                    <span className="flex w-5 shrink-0 justify-center"><LogoutOutlined /></span>
                    退出登录
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => { setTouchOpen(false); router.push('/login') }}
                  className="flex h-10 items-center gap-3 rounded-xl px-3 text-sm text-[#4a2f8f]"
                >
                  <span className="flex w-5 shrink-0 justify-center"><UserOutlined /></span>
                  登录 / 注册
                </button>
              )}
            </div>
          </>
        )}
        {/* 公告面板挂在菜单外层：点「公告」会先收起菜单，面板需独立于 touchOpen 存活 */}
        <AnnouncementPanel open={bellOpen} onClose={() => setBellOpen(false)} />
      </nav>
    </>
  )
}
