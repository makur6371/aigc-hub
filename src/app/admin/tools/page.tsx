import { redirect } from 'next/navigation'

export default function AdminToolsPage() {
  redirect('/admin/content?tab=tools')
}
