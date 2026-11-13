'use client'

import { Typography } from 'antd'
import { PageContainer } from '@/components/layout/PageContainer'
import { McpPairingCard } from '@/components/user/McpPairingCard'

const { Title, Text } = Typography

export default function UserMcpPage() {
  return (
    <PageContainer>
      <div className="mx-auto w-full max-w-4xl space-y-6">
        <div>
          <Title level={4} className="mb-1">MCP 连接</Title>
          <Text type="secondary">创建和管理用于连接外部 Agent 的 MCP 配对码。</Text>
        </div>
        <McpPairingCard />
      </div>
    </PageContainer>
  )
}
