import { redirect } from 'next/navigation'

export default async function AgentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (key === 'kind' || value == null) continue
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item)
  }
  query.set('kind', 'agent')
  redirect(`/create?${query.toString()}`)
}
