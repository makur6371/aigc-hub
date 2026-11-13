'use client'

import dynamic from 'next/dynamic'
import { PageContainer } from '@/components/layout/PageContainer'
import { SettingsWorkspace } from '@/components/layout/SettingsWorkspace'
import { UsersPanel } from '@/components/admin/UsersPanel'
import { CardKeysPanel } from '@/components/admin/CardKeysPanel'
import { PageState } from '@/components/ui/PageState'

const LoadingPanel = () => <PageState status="loading" description="正在加载设置…" minHeight="180px" />

const ApiConfigPanel = dynamic(() => import('@/components/admin/ApiConfigPanel').then((module) => module.ApiConfigPanel), { loading: LoadingPanel })
const AnnouncementsPanel = dynamic(() => import('@/components/admin/AnnouncementsPanel').then((module) => module.AnnouncementsPanel), { loading: LoadingPanel })
const TeamReviewPanel = dynamic(() => import('@/components/admin/TeamReviewPanel').then((module) => module.TeamReviewPanel), { loading: LoadingPanel })
const AgentsNodesPanel = dynamic(() => import('@/components/admin/AgentsNodesPanel').then((module) => module.AgentsNodesPanel), { loading: LoadingPanel })
const AgentConfigPanel = dynamic(() => import('@/components/admin/AgentConfigPanel').then((module) => module.AgentConfigPanel), { loading: LoadingPanel })
const FreeQuotaPanel = dynamic(() => import('@/components/admin/FreeQuotaPanel').then((module) => module.FreeQuotaPanel), { loading: LoadingPanel })
const FreeImagePassPanel = dynamic(() => import('@/components/admin/FreeImagePassPanel').then((module) => module.FreeImagePassPanel), { loading: LoadingPanel })

export default function AdminSettingsPage() {
  return (
    <PageContainer>
      <SettingsWorkspace
        title="系统设置"
        description="管理用户、模型、画布节点和使用额度。"
        defaultActiveKey="users"
        items={[
          { key: 'users', label: '用户管理', group: '用户与权益', description: '查找账号、调整权益，或查看某位用户的使用情况。', children: <UsersPanel /> },
          { key: 'card-keys', label: '卡密管理', group: '用户与权益', description: '管理积分卡、视频豆卡和订阅卡，支持批量复制与导出。', children: <CardKeysPanel /> },
          { key: 'free-image-pass', label: '生图时长券', group: '用户与权益', description: '配置时长券限额，查看发放与用户用券情况。', children: <FreeImagePassPanel /> },
          { key: 'team-review', label: '企业团队审核', group: '用户与权益', children: <TeamReviewPanel /> },
          { key: 'api-config', label: '供应商与模型', group: '模型与创作', children: <ApiConfigPanel /> },
          { key: 'free-quota', label: '免费额度池', group: '模型与创作', children: <FreeQuotaPanel /> },
          { key: 'agent-config', label: 'Agent 配置', group: '模型与创作', children: <AgentConfigPanel /> },
          { key: 'agents-nodes', label: '画布节点', group: '模型与创作', children: <AgentsNodesPanel /> },
          { key: 'announcement', label: '公告发布', group: '站点设置', children: <AnnouncementsPanel /> },
        ]}
      />
    </PageContainer>
  )
}
