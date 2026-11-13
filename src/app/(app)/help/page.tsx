'use client'

import { Card, Typography, Collapse } from 'antd'
import { PageContainer } from '@/components/layout/PageContainer'
import { BrandTag } from '@/components/ui/BrandTag'
import { ORG } from '@/lib/site-content'
import {
  RocketOutlined,
  MessageOutlined,
  AppstoreOutlined,
  FolderOutlined,
  ThunderboltOutlined,
  QuestionCircleOutlined,
  SafetyOutlined,
} from '@ant-design/icons'

const { Title, Text } = Typography

const guides = [
  {
    icon: <RocketOutlined />,
    color: 'bg-accent',
    title: '快速开始',
    items: [
      '注册登录后，在「对话」页选择一个模型开始使用',
      '首次使用建议选择文本模型进行对话，熟悉界面',
      '积分用于抵扣 AI 生成成本，可在「个人中心」查看余额和充值',
    ],
  },
  {
    icon: <MessageOutlined />,
    color: 'bg-primary',
    title: 'AI 对话',
    items: [
      '支持文本、视觉（传图）、生图多种模型，右上角可切换',
      '选择生图模型后输入描述即可生成图片，可选图片比例',
      '视觉模型可点击「图片」按钮上传参考图，进行识图/编辑',
      '对话记录会自动保存，刷新页面不会丢失，可随时回看历史会话',
    ],
  },
  {
    icon: <AppstoreOutlined />,
    color: 'bg-warning',
    title: '无限画布',
    items: [
      '画布是节点式工作流编辑器：拖拽节点、连线、运行',
      '左侧节点库分类添加节点，支持 LLM、生图、逻辑、数据处理等',
      'Copilot 助手可帮你自动搭建工作流：描述需求 → 生成计划 → 一键执行',
      '工作流可保存、加载、导出，官方工作流可直接导入体验',
    ],
  },
  {
    icon: <FolderOutlined />,
    color: 'bg-success',
    title: '素材库',
    items: [
      '在「素材库」页上传和管理图片、视频、音频',
      '上传的素材会保存到你的账号，可复制 URL 在其他创作中引用',
      '生成结果也会自动归集，方便统一管理',
    ],
  },
  {
    icon: <ThunderboltOutlined />,
    color: 'bg-warning-amber',
    title: '积分与计费',
    items: [
      '每次 AI 调用按模型定价扣除积分，可在模型列表中查看价格',
      '积分不足时请联系管理员',
      '生成失败会自动退还已扣积分，无需担心损失',
    ],
  },
  {
    icon: <SafetyOutlined />,
    color: 'bg-accent-3',
    title: '账号与安全',
    items: [
      '由管理员为工作台创建账户并分配使用权限',
      '通过邮箱和密码登录工作台',
      '充值、积分变动可在「个人中心」的充值记录与积分记录中随时查看',
    ],
  },
]

const faqs = [
  {
    key: '1',
    label: '对话记录会丢失吗？',
    children: '不会。所有对话都会自动保存到你的账号，刷新页面或更换设备后都可以在输入框上方的「历史」里找回。',
  },
  {
    key: '2',
    label: '为什么有些模型不可用？',
    children: '模型可用性由管理员配置的 API 供应商决定。如果供应商未配置或服务异常，模型会被标记不可用。',
  },
  {
    key: '3',
    label: '生成失败了会扣积分吗？',
    children: '不会。无论是对话、生图还是视频，生成失败都会自动退还已预扣的积分。',
  },
  {
    key: '4',
    label: '如何获得更多积分？',
    children: '请联系管理员调整使用额度。',
  },
  {
    key: '5',
    label: '低安全等级有什么限制？',
    children: '账户的创作权限由管理员配置。',
  },
  {
    key: '6',
    label: '如何反馈问题或建议？',
    children: '可以通过站点管理员反馈。平台会持续优化体验，感谢你的支持！',
  },
]

export default function HelpPage() {
  return (
    <PageContainer>
      <div className="space-y-6 max-w-3xl mx-auto">
        <Title level={4} className="mb-0">
          <QuestionCircleOutlined className="mr-2 text-accent" />
          帮助中心
        </Title>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {guides.map((g) => (
            <Card key={g.title} variant="outlined" className="h-full">
              <div className="flex items-center gap-2 mb-3">
                <span className={`w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm ${g.color}`}>
                  {g.icon}
                </span>
                <Text strong className="text-foreground">{g.title}</Text>
              </div>
              <ul className="space-y-2 m-0 pl-4">
                {g.items.map((item, i) => (
                  <li key={i} className="text-sm text-text-muted leading-relaxed list-disc">
                    {item}
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>

        <Card variant="outlined" title="常见问题">
          <Collapse
            items={faqs}
            className="help-faq"
          />
        </Card>

        <div className="flex items-center justify-center gap-2 py-4">
          <BrandTag>{ORG.name}</BrandTag>
          <Text className="text-xs text-text-disabled">v0.1.0 · 遇到问题可联系管理员反馈</Text>
        </div>
      </div>
    </PageContainer>
  )
}
