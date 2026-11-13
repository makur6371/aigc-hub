import Link from 'next/link'
import { ArrowUpRight, Boxes, Image, Layers, Sparkles, Video, Workflow } from 'lucide-react'
import { CreateEntry } from '@/components/home/CreateEntry'
import styles from '@/components/home/HomePage.module.css'

const surfaces = [
  { label: '图像生成', href: '/create/image', icon: Image },
  { label: '视频生成', href: '/create/video', icon: Video },
  { label: '创作 Agent', href: '/create/agent', icon: Sparkles },
]

export default function HomePage() {
  return (
    <div className={styles.home}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}>
          {/* eslint-disable-next-line @next/next/no-img-element -- local vector logo */}
          <img src="/logo.svg" width="34" height="34" alt="" /> AIGC Hub
        </Link>
        <nav aria-label="站点导航">
          <a href="https://github.com/makur6371/aigc-hub">GitHub <ArrowUpRight size={14} aria-hidden="true" /></a>
          <Link href="/login">登录</Link>
        </nav>
      </header>
      <main className={styles.hero}>
        <div className={styles.orbit} aria-hidden="true">
          <span>参考图编辑</span><span>镜头设计</span><span>故事分镜</span><span>节点工作流</span>
        </div>
        <p className={styles.eyebrow}><span /> 开源 · 可自托管</p>
        <h1>从一句话，<br className={styles.mobileBreak} />到<span>你的作品</span></h1>
        <p className={styles.lead}>用自己的模型做图、做视频，与 Agent 一起创作，也可以在画布上搭起自己的工作流。</p>
        <CreateEntry />
        <nav className={styles.modes} aria-label="创作模式">
          {surfaces.map(({ label, href, icon: Icon }) => (
            <Link key={href} href={href}><Icon size={17} aria-hidden="true" />{label}</Link>
          ))}
        </nav>
        <nav className={styles.workspaces} aria-label="更多工作区">
          <Link href="/canvas">
            <Workflow size={23} aria-hidden="true" />
            <span><strong>打开画布</strong><small>用节点搭建工作流</small></span>
            <ArrowUpRight size={17} aria-hidden="true" />
          </Link>
          <Link href="/tools">
            <Boxes size={23} aria-hidden="true" />
            <span><strong>浏览工具箱</strong><small>打开可复用的工作流</small></span>
            <ArrowUpRight size={17} aria-hidden="true" />
          </Link>
        </nav>
      </main>
      <footer className={styles.footer}><Layers size={15} aria-hidden="true" /> 自带模型，自由创作 <span>·</span> <a href="https://github.com/makur6371/aigc-hub/blob/main/LICENSE">Apache 2.0</a></footer>
    </div>
  )
}
