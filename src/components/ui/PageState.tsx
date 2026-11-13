'use client'

import React from 'react'
import { Typography } from 'antd'
import { InboxOutlined, WarningOutlined } from '@ant-design/icons'
import { AnimatedLogo } from './AnimatedLogo'

const { Text } = Typography

type PageStateProps = {
  status: 'loading' | 'empty' | 'error'
  description?: React.ReactNode
  children?: React.ReactNode
  minHeight?: string
}

export function PageState({ status, description, children, minHeight = '320px' }: PageStateProps) {
  return (
    <div
      className="flex flex-col items-center justify-center px-6 text-center"
      style={{ minHeight }}
    >
      {status === 'loading' && (
        <>
          {/* 全站统一加载语言：品牌 Logo 动画（小尺寸纯 Logo 版） */}
          <AnimatedLogo size={56} className="mb-4" />
          <Text type="secondary">{description || '加载中...'}</Text>
        </>
      )}

      {status === 'empty' && (
        <>
          <div className="brand-gradient-bg relative mb-4 flex h-16 w-16 items-center justify-center rounded-2xl shadow-sm">
            <div className="pointer-events-none absolute inset-0 rounded-2xl bg-white/10" />
            <InboxOutlined className="relative text-2xl text-white" />
          </div>
          <Text type="secondary">{description || '暂无数据'}</Text>
        </>
      )}

      {status === 'error' && (
        <>
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-warning-bg">
            <WarningOutlined className="text-2xl text-warning" />
          </div>
          <Text type="secondary">{description || '加载失败'}</Text>
        </>
      )}

      {children && <div className="mt-4">{children}</div>}
    </div>
  )
}
