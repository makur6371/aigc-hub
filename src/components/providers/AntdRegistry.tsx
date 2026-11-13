'use client'

import React from 'react'
import { ConfigProvider, App } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import { AntdRegistry as AntdStyleRegistry } from '@ant-design/nextjs-registry'

// antd 内置文案默认英文（Modal 的 OK/Cancel、分页、DatePicker 面板、Popconfirm 等）→ 全站锁中文
dayjs.locale('zh-cn')

const theme = {
  token: {
    colorPrimary: '#1677FF',
    colorTextBase: '#141414',
    colorText: '#141414',
    colorTextSecondary: '#8C8C8C',
    colorBorder: '#F0F0F0',
    colorBorderSecondary: '#F0F0F0',
    colorBgContainer: '#FFFFFF',
    colorBgLayout: '#FAFAFA',
    borderRadius: 8,
    wireframe: false,
  },
  components: {
    Layout: {
      bodyBg: '#FFFFFF',
      headerBg: 'rgba(255,255,255,0.82)',
      siderBg: 'rgba(255,255,255,0.82)',
      footerBg: '#FFFFFF',
    },
    Menu: {
      itemHeight: 50,
      itemBorderRadius: 10,
      itemSelectedColor: '#7D50E0',
      itemSelectedBg: '#F3EDFC',
      itemHoverColor: '#7D50E0',
      itemHoverBg: '#F5F5F5',
    },
    Card: {
      borderRadius: 8,
      boxShadow: '0 1px 2px 0 rgba(0,0,0,0.03), 0 2px 12px 0 rgba(15,23,42,0.05)',
    },
    Button: {
      borderRadius: 8,
      primaryColor: '#FFFFFF',
    },
    Input: {
      borderRadius: 8,
    },
    Select: {
      borderRadius: 8,
    },
    Table: {
      borderRadius: 8,
    },
  },
}

export function AntdRegistry({ children }: { children: React.ReactNode }) {
  return (
    <AntdStyleRegistry>
      <ConfigProvider theme={theme} locale={zhCN}>
        <App>{children}</App>
      </ConfigProvider>
    </AntdStyleRegistry>
  )
}
