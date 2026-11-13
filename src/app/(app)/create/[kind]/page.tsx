import { redirect } from 'next/navigation'

export default async function CreateKindPage({ params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params
  redirect(`/create?kind=${encodeURIComponent(kind)}`)
}
