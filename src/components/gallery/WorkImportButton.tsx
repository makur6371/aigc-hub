'use client'

/**
 * 作品详情页「导入到画布」按钮（客户端组件）。
 *
 * 为什么单独抽出来：详情页是服务端组件（要 SEO），而导入需要写 localStorage + 路由跳转。
 * 导入协议与作品广场列表弹窗、原 (app)/works 详情页完全一致 —— 写 `pendingWorkflowImport`
 * 后跳 /canvas，由画布页消费（见 canvas/page.tsx 的 pending 处理）。
 */
import { App, Button } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { useRouter } from 'next/navigation'
import { writeLocalText } from '@/lib/local-store'

export function WorkImportButton({
  title,
  nodes,
  connections,
}: {
  title: string
  nodes: unknown
  connections: unknown
}) {
  const router = useRouter()
  const { message } = App.useApp()

  return (
    <Button
      type="primary"
      icon={<PlusOutlined />}
      onClick={() => {
        try {
          writeLocalText(
            'pendingWorkflowImport',
            JSON.stringify({ name: title, nodes, connections }),
          )
          message.success('已写入导入队列，正在跳转画布...')
          router.push('/canvas')
        } catch {
          message.error('导入失败')
        }
      }}
    >
      导入到画布
    </Button>
  )
}
