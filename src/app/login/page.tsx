'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '@/stores/useAuthStore'

export default function LoginPage() {
  const router = useRouter()
  const setUser = useAuthStore((s) => s.setUser)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: data.get('account'), password: data.get('password') }),
      })
      const result = await res.json()
      if (!res.ok || !result.success) throw new Error(result.message || '登录失败')
      setUser(result.data.user)
      const target = new URLSearchParams(window.location.search).get('redirect')
      router.replace(target && /^\/(?![\/\\])/.test(target) && !target.includes('\\') ? target : '/create')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  return <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-8">
    <Link href="/" className="text-accent">AIGC Hub</Link>
    <h1 className="text-3xl font-semibold">登录创作工作台</h1>
    <form onSubmit={login} className="grid gap-4 rounded-3xl bg-white p-6 shadow-sm">
      <label className="grid gap-2">邮箱<input name="account" type="email" autoComplete="username" required className="rounded-xl border border-accent/20 p-3" /></label>
      <label className="grid gap-2">密码<input name="password" type="password" autoComplete="current-password" required className="rounded-xl border border-accent/20 p-3" /></label>
      {error && <p role="alert" className="text-red-700">{error}</p>}
      <button disabled={busy} className="rounded-full bg-accent p-3 font-semibold text-white">{busy ? '正在登录…' : '登录'}</button>
    </form>
    <p className="text-sm text-text-secondary">账号由站点管理员创建。</p>
  </main>
}
