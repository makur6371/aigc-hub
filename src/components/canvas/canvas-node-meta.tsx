'use client'

/**
 * 画布节点分类图标（从 canvas/page.tsx 抽到共享模块）。
 *
 * 页面层与节点卡片都要用 —— 放共享模块是为了两边**共用同一份定义**（Q-25/Q-801）。
 */
import {
  ThunderboltOutlined,
  PictureOutlined,
  VideoCameraOutlined,
  SoundOutlined,
  BranchesOutlined,
  DatabaseOutlined,
  ImportOutlined,
} from '@ant-design/icons'
import type React from 'react'

export const categoryIcons: Record<string, React.ReactNode> = {
  llm: <ThunderboltOutlined />,
  image: <PictureOutlined />,
  video: <VideoCameraOutlined />,
  audio: <SoundOutlined />,
  logic: <BranchesOutlined />,
  data: <DatabaseOutlined />,
  io: <ImportOutlined />,
  custom: <ImportOutlined />,
}
