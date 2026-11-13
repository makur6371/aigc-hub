'use client'

import { Typography } from 'antd'
import { WarningOutlined } from '@ant-design/icons'
import { readLocalText } from '@/lib/local-store'

const { Text } = Typography

/**
 * 低安全等级账号顶部警告条。
 * 仅当 user.securityLevel === 'LOW' 时显示。
 * 提示用户部分功能已锁定,需联系管理员核验。
 */
export function SecurityBanner() {
  // 从 localStorage 读取登录时缓存的用户信息(避免每个页面都调接口)
  let isLow = false
  try {
    const saved = readLocalText('current-user')
    if (saved) {
      const user = JSON.parse(saved)
      isLow = user.securityLevel === 'LOW'
    }
  } catch { /* */ }

  if (!isLow) return null

  return (
    <div className="sticky top-0 z-50 flex items-center justify-center gap-2 bg-warning-bg border-b border-warning-light px-4 py-2">
      <WarningOutlined className="text-warning-strong" />
      <Text className="text-xs text-warning-strong">
        ⚠️ 当前账号安全等级较低,部分高级功能已锁定,请联系管理员完成人工核验解锁全部能力。
      </Text>
    </div>
  )
}
