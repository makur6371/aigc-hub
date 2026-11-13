import Link from 'next/link'

export default function HomePage() {
  return <main className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center gap-8 p-8">
    <p className="font-semibold tracking-widest text-accent">AIGC HUB</p>
    <h1 className="text-5xl font-semibold tracking-tight">你的 AI 创作工作台</h1>
    <p className="max-w-xl text-lg text-text-secondary">在同一个工作台生成图像和视频，与 Agent 对话，或在画布上搭建自己的工作流。</p>
    <nav className="flex flex-wrap gap-4" aria-label="创作入口">
      <Link className="rounded-full bg-accent px-6 py-3 font-semibold text-white" href="/create">开始创作</Link>
      <Link className="rounded-full border border-accent/20 px-6 py-3" href="/tools">工具箱</Link>
      <Link className="rounded-full border border-accent/20 px-6 py-3" href="/canvas">画布</Link>
      <Link className="rounded-full border border-accent/20 px-6 py-3" href="/login">登录</Link>
    </nav>
  </main>
}
