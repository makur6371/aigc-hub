'use client'

import { Dropdown } from 'antd'
import { DownOutlined, CheckOutlined } from '@ant-design/icons'

export type CreateMode = 'agent' | 'image' | 'video'

export function CreateModePicker({ value, onChange }: { value: CreateMode; onChange: (mode: CreateMode) => void }) {
  const options: { value: CreateMode; label: string; description: string }[] = [
    { value: 'agent', label: '✦ Agent', description: '描述目标，协助规划并执行' },
    { value: 'image', label: '图像生成', description: '按描述直接生成或编辑图片' },
    { value: 'video', label: '视频生成', description: '使用文字或素材生成视频' },
  ]
  return <Dropdown trigger={['click']} placement="topLeft" menu={{
    items: options.map((option) => ({
      key: option.value,
      label: <span className="flex min-w-[190px] items-center gap-4 py-1"><span className="flex-1"><span className="block text-sm font-medium">{option.label}</span><span className="block text-xs text-black/45">{option.description}</span></span>{value === option.value && <CheckOutlined className="text-accent" />}</span>,
    })),
    onClick: ({ key }) => onChange(key as CreateMode),
  }}><button type="button" aria-label="选择创作类型" className="composer-chip h-9 shrink-0 whitespace-nowrap px-3 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{options.find((option) => option.value === value)?.label}<DownOutlined className="text-[10px]" /></button></Dropdown>
}
