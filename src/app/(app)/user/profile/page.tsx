'use client'
import Link from 'next/link'
import { PageContainer } from '@/components/layout/PageContainer'
import { useAuthStore } from '@/stores/useAuthStore'

export default function ProfilePage() {
  const user = useAuthStore((state) => state.user)
  return <PageContainer><section className="space-y-4">
    <h1 className="text-2xl font-semibold">个人中心</h1>
    {user && <><p>{user.nickname || user.email}</p><p>积分余额：{user.availPoints ?? user.points}</p><p>视频额度：{user.availBeans ?? user.beans ?? 0}</p></>}
    <nav className="flex flex-wrap gap-5"><Link href="/user/images">生成记录</Link><Link href="/user/assets">素材库</Link><Link href="/user/videos">视频记录</Link></nav>
  </section></PageContainer>
}
