'use client'

import { useState, type ReactNode } from 'react'
import { ArrowUpRight, Pause, Play } from 'lucide-react'
import { ShaderBackground, type ShaderStatus } from '@/components/auth/ShaderBackground'
import styles from './glass.module.css'

export function GlassDemo({ homeLink }: { homeLink: ReactNode }) {
  const [enabled, setEnabled] = useState(true)
  const [status, setStatus] = useState<ShaderStatus | 'loading'>('loading')
  const running = status === 'ready' && enabled

  return <main className={styles.page}>
    <header className={styles.header}>
      <div className={styles.back}>{homeLink}</div>
      <span>DESIGN LAB / 01</span>
    </header>
    <section className={styles.stage} aria-labelledby="glass-title">
      <div className={styles.fallback} aria-hidden="true"><i /><i /><i /></div>
      <ShaderBackground className={status === 'ready' || status === 'reduced' ? styles.canvas : styles.hiddenCanvas} playing={enabled} onStatus={setStatus} />
      <div className={styles.card}>
        <p className={styles.kicker}>WEBGL · 交互演示</p>
        <h1 id="glass-title">芋泥紫<br /><span>液态玻璃</span></h1>
        <p className={styles.copy}>三道紫色光环在玻璃后缓缓交错。用鼠标移动视角，或暂停细看光影。</p>
        <a className={styles.source} href="https://github.com/makur6371/aigc-hub/blob/main/src/components/auth/ShaderBackground.tsx">查看组件源码 <ArrowUpRight size={15} aria-hidden="true" /></a>
      </div>
      <div className={styles.controls}>
        <span role="status">{status === 'unavailable' ? 'WebGL 不可用 · 静态预览' : status === 'reduced' ? '减少动态效果 · 静态预览' : status === 'loading' ? '正在载入光环…' : running ? '动态预览' : '动画已暂停'}</span>
        {status === 'ready' && <button type="button" onClick={() => setEnabled((previous) => !previous)}>
          {running ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
          {running ? '暂停动画' : '播放动画'}
        </button>}
      </div>
    </section>
  </main>
}
