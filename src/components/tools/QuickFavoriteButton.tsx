'use client'

import { useState } from 'react'
import { App as AntApp, Button, Modal, Select, Tooltip } from 'antd'
import {
  DeleteOutlined,
  GlobalOutlined,
  PlusOutlined,
  StarOutlined,
} from '@ant-design/icons'
import { usePathname } from 'next/navigation'
import {
  QUICK_FAVORITE_PAGES,
  mergeQuickFavorite,
  readQuickFavorites,
  writeQuickFavorites,
  type QuickFavorite,
} from '@/lib/quick-favorites'

export function QuickFavoriteButton({ currentLabel }: { currentLabel: string }) {
  const { message } = AntApp.useApp()
  const pathname = usePathname() || '/'
  const [open, setOpen] = useState(false)
  const [favorites, setFavorites] = useState<QuickFavorite[]>([])
  const [selectedPage, setSelectedPage] = useState<string | undefined>()

  const openModal = () => {
    setFavorites(readQuickFavorites())
    setSelectedPage(undefined)
    setOpen(true)
  }

  const addFavorite = (label: string, href: string) => {
    const next = mergeQuickFavorite(favorites, { label, href })
    setFavorites(next.items)
    if (!next.added) {
      message.info('这个页面已经在快捷收藏里了')
      return
    }
    writeQuickFavorites(next.items)
    message.success(`已收藏「${label}」`)
  }

  const removeFavorite = (href: string) => {
    const next = favorites.filter((item) => item.href !== href)
    setFavorites(next)
    writeQuickFavorites(next)
  }

  return (
    <>
      <Tooltip title="把常用页面收藏到当前浏览器">
        <Button
          size="small"
          icon={<StarOutlined />}
          className="shrink-0"
          onClick={openModal}
        >
          <span className="max-sm:hidden">快捷收藏</span>
        </Button>
      </Tooltip>

      <Modal
        title="收藏到快捷标签"
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        width={430}
      >
        <div className="space-y-3 pt-1">
          <button
            type="button"
            onClick={() => addFavorite(currentLabel, pathname)}
            className="flex w-full items-start gap-3 rounded-lg border border-black/[0.09] px-3 py-3 text-left transition hover:border-accent/45 hover:bg-accent-soft/30"
          >
            <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
              <PlusOutlined />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-black/80">添加本页面</span>
              <span className="mt-0.5 block truncate text-[11px] text-black/40">{currentLabel} · {pathname}</span>
            </span>
          </button>

          <div className="rounded-lg border border-black/[0.09] px-3 py-3">
            <div className="flex items-center gap-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-black/[0.04] text-black/45">
                <GlobalOutlined />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-black/80">选择添加页面</div>
                <div className="mt-0.5 text-[11px] text-black/40">选中后自动添加</div>
              </div>
            </div>
            <Select
              className="mt-2 w-full"
              size="small"
              showSearch
              optionFilterProp="label"
              value={selectedPage}
              placeholder="选择首页、Agent、画布等页面"
              options={QUICK_FAVORITE_PAGES.map((page) => ({ value: page.href, label: page.label }))}
              onChange={(href) => {
                const page = QUICK_FAVORITE_PAGES.find((item) => item.href === href)
                if (!page) return
                addFavorite(page.label, page.href)
                setSelectedPage(undefined)
              }}
            />
          </div>

          {favorites.length > 0 && (
            <div>
              <div className="mb-1.5 text-[11px] font-medium text-black/40">已收藏</div>
              <div className="max-h-44 space-y-1 overflow-y-auto pr-1 aigc-hub-scrollbar">
                {favorites.map((item) => (
                  <div
                    key={item.href}
                    className="flex items-center gap-2 rounded-md border border-black/[0.06] px-2.5 py-2"
                  >
                    <a
                      href={item.href}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 flex-1 truncate text-[12px] text-black/65 transition hover:text-accent"
                      title={`${item.label} · ${item.href}`}
                    >
                      {item.label}
                      <span className="ml-1.5 text-[10px] text-black/30">{item.href}</span>
                    </a>
                    <Button
                      type="text"
                      size="small"
                      danger
                      aria-label={`移除 ${item.label}`}
                      title={`移除 ${item.label}`}
                      icon={<DeleteOutlined />}
                      onClick={() => removeFavorite(item.href)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="text-[10.5px] leading-relaxed text-black/35">
            收藏保存在当前浏览器；点击已收藏页面会在新标签打开。
          </div>
        </div>
      </Modal>
    </>
  )
}
