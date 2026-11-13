import { redirect } from 'next/navigation'

export default function AdminWorksReviewPage() {
  redirect('/admin/content?tab=works')
}
