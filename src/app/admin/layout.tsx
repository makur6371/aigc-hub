import { AppLayout } from '@/components/layout/AppLayout'

export default function AdminGroupLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <AppLayout>{children}</AppLayout>
}
