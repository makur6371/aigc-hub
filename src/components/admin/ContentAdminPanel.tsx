'use client'

import { useCallback, useState } from 'react'
import { SettingsWorkspace } from '@/components/layout/SettingsWorkspace'
import { ToolsAdminPanel } from './ToolsAdminPanel'
import { WorksReviewPanel } from './WorksReviewPanel'
import { PromptsAdminPanel } from './PromptsAdminPanel'
import { PromptSourcesPanel } from './PromptSourcesPanel'

type ContentTab = 'tools' | 'works' | 'prompts' | 'promptSources'

export function ContentAdminPanel({ defaultTab = 'tools' }: { defaultTab?: ContentTab }) {
  const [activeTab, setActiveTab] = useState<ContentTab>(defaultTab)
  const handleTabChange = useCallback((key: string) => setActiveTab(key as ContentTab), [])

  return (
    <SettingsWorkspace
      title="内容管理"
      description="工具、作品和提示词统一审核与维护。"
      defaultActiveKey={defaultTab}
      activeKey={activeTab}
      onChange={handleTabChange}
      items={[
        { key: 'tools', label: '工具管理', group: '内容审核', description: '审核、上下架、编辑与删除平台工具。', children: <ToolsAdminPanel /> },
        { key: 'works', label: '作品管理', group: '内容审核', description: '审核作品广场的公开作品。', children: <WorksReviewPanel /> },
        { key: 'prompts', label: '提示词管理', group: '提示词', description: '审核与维护提示词库。', children: <PromptsAdminPanel /> },
        { key: 'promptSources', label: '提示词来源', group: '提示词', description: '从外部标准 JSON 批量拉取提示词。', children: <PromptSourcesPanel /> },
      ]}
    />
  )
}
