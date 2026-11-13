import { ContentAdminPanel } from '@/components/admin/ContentAdminPanel'
import { PageContainer } from '@/components/layout/PageContainer'

type ContentTab = 'tools' | 'works' | 'prompts' | 'promptSources'

function parseContentTab(value: string | string[] | undefined): ContentTab {
  const tab = Array.isArray(value) ? value[0] : value
  return tab === 'works' || tab === 'prompts' || tab === 'promptSources' ? tab : 'tools'
}

export default async function AdminContentPage({
  searchParams,
}: {
  searchParams?: Promise<{ tab?: string | string[] }>
}) {
  const { tab } = (await searchParams) ?? {}

  return (
    <PageContainer>
      <ContentAdminPanel defaultTab={parseContentTab(tab)} />
    </PageContainer>
  )
}
