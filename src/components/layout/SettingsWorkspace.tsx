'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Select } from 'antd'

export interface SettingsSection {
  key: string
  label: ReactNode
  group?: string
  description?: string
  children?: ReactNode
}

interface Props {
  title: string
  description: string
  items: SettingsSection[]
  defaultActiveKey: string
  activeKey?: string
  onChange?: (key: string) => void
}

export function SettingsWorkspace({ title, description, items, defaultActiveKey, activeKey, onChange }: Props) {
  const [selected, setSelected] = useState(defaultActiveKey)
  const [visited, setVisited] = useState([defaultActiveKey])
  const keys = items.map((item) => item.key).join('|')
  const current = activeKey ?? selected

  useEffect(() => {
    const timer = window.setTimeout(() => setVisited((previous) => previous.includes(current) ? previous : [...previous, current]), 0)
    return () => window.clearTimeout(timer)
  }, [current])

  useEffect(() => {
    const sync = () => {
      const next = new URL(window.location.href).searchParams.get('tab')
      if (!next || !keys.split('|').includes(next)) return
      setSelected(next)
      setVisited((previous) => previous.includes(next) ? previous : [...previous, next])
      onChange?.(next)
    }
    const timer = window.setTimeout(sync, 0)
    window.addEventListener('popstate', sync)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('popstate', sync)
    }
  }, [keys, onChange])

  const choose = (key: string) => {
    setSelected(key)
    setVisited((previous) => previous.includes(key) ? previous : [...previous, key])
    onChange?.(key)
    const url = new URL(window.location.href)
    url.searchParams.set('tab', key)
    window.history.replaceState(window.history.state, '', url)
  }

  const groups = [...new Set(items.map((item) => item.group ?? '常用'))]
  const active = items.find((item) => item.key === current)

  return (
    <div className="settings-workspace space-y-6">
      <header className="px-1 pt-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-text-muted">{description}</p>
      </header>
      <div className="grid items-start gap-5 lg:grid-cols-[200px_minmax(0,1fr)] xl:gap-7">
        <aside className="hidden lg:sticky lg:top-0 lg:block">
          <nav aria-label={`${title}导航`} className="aigc-hub-scrollbar max-h-[calc(100dvh-160px)] overflow-y-auto rounded-[26px] border border-accent/10 bg-white/65 p-3 shadow-sm backdrop-blur-xl">
            {groups.map((group) => (
              <div key={group} className="mb-4 last:mb-0">
                <p className="px-3 pb-2 pt-1 text-[11px] font-medium tracking-wide text-text-secondary">{group}</p>
                <div className="space-y-1">
                  {items.filter((item) => (item.group ?? '常用') === group).map((item) => (
                    <button key={item.key} type="button" aria-current={current === item.key ? 'page' : undefined} onClick={() => choose(item.key)} className={`flex w-full items-center justify-between gap-2 rounded-2xl px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${current === item.key ? 'bg-accent-light font-semibold text-accent' : 'text-text-muted hover:bg-accent/5 hover:text-foreground'}`}>
                      {item.label}<span aria-hidden="true" className={current === item.key ? 'text-accent' : 'text-transparent'}>›</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </nav>
        </aside>
        <div className="min-w-0 space-y-4">
          <div className="rounded-2xl border border-accent/10 bg-white/80 p-3 lg:hidden">
            <Select aria-label="切换设置栏目" value={current} onChange={choose} className="w-full" size="large" options={groups.map((group) => ({ label: group, options: items.filter((item) => (item.group ?? '常用') === group).map((item) => ({ value: item.key, label: item.label })) }))} />
          </div>
          {active?.description && <p className="px-1 text-sm leading-relaxed text-text-muted">{active.description}</p>}
          {items.map((item) => (visited.includes(item.key) || item.key === current) && (
            <section key={item.key} aria-label={typeof item.label === 'string' ? item.label : item.key} hidden={item.key !== current} className="min-w-0 motion-safe:animate-[canvasPanelIn_180ms_ease-out]">{item.children}</section>
          ))}
        </div>
      </div>
    </div>
  )
}
