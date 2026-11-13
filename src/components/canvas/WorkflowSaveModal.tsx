'use client'

import { App, Button, Input, Modal, Popconfirm, Typography } from 'antd'
import { DeleteOutlined, EditOutlined, FolderOpenOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { PageState } from '@/components/ui/PageState'
import { apiFetch } from '@/lib/api-client'

const { Text } = Typography

// ===== 工作流「保存 / 打开」弹窗 =====
//
// 从 canvas/page.tsx（4100+ 行）抽出。与画布交互状态无关，
// 只依赖「打开态 / 名称 / 保存中 / 列表」四个值 + 四个回调。
//
// 抽离时顺手统一了网络层：原先重命名与删除用裸 fetch，
// 绕过项目统一的 apiFetch（会丢 401 处理与统一错误提示），现已改为 apiFetch。

/// 组件只用到 id/name/updatedAt 三个字段，但 onLoad 的实参类型由调用方决定
/// （画布那边传的是完整 WorkflowItem）。用泛型保持结构兼容，避免类型不匹配。
export type WorkflowLike = {
  id: string
  name: string
  updatedAt: string
}

interface Props<T extends WorkflowLike> {
  open: boolean
  onClose: () => void
  /** 新工作流名称（受控） */
  name: string
  onNameChange: (v: string) => void
  /** 保存当前画布为新工作流 */
  onSave: () => void | Promise<void>
  saving: boolean
  /** 已保存的工作流列表 */
  workflows: T[]
  /** 加载某个工作流到画布 */
  onLoad: (w: T) => void
  /** 列表变更后刷新（重命名 / 删除后调用） */
  onRefresh: () => void | Promise<void>
}

export function WorkflowSaveModal<T extends WorkflowLike>({
  open, onClose, name, onNameChange, onSave, saving, workflows, onLoad, onRefresh,
}: Props<T>) {
  const { message } = App.useApp()

  /** 行内重命名：用 Modal.confirm + Input（比再开一个弹窗轻） */
  const rename = (w: T) => {
    let newName = w.name
    Modal.confirm({
      title: '重命名工作流',
      icon: null,
      content: (
        <Input
          defaultValue={w.name}
          autoFocus
          onChange={(e) => { newName = e.target.value }}
        />
      ),
      onOk: async () => {
        const trimmed = newName.trim()
        if (!trimmed || trimmed === w.name) return
        const res = await apiFetch(`/api/canvas-workflows/${w.id}`, {
          method: 'PUT',
          body: JSON.stringify({ name: trimmed }),
        })
        if (res.success) {
          message.success('已重命名')
          await onRefresh()
        } else {
          message.error(res.message || '重命名失败')
        }
      },
    })
  }

  /** 删除：不可恢复，二次确认（Popconfirm 已承担确认） */
  const remove = async (w: T) => {
    const res = await apiFetch(`/api/canvas-workflows/${w.id}`, { method: 'DELETE' })
    if (res.success !== false) {
      message.success('已删除')
      await onRefresh()
    } else {
      message.error(res.message || '删除失败')
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title="保存 / 打开工作流"
      width={520}
      centered
      destroyOnHidden
    >
      <div className="flex gap-2 mb-4">
        <Input
          placeholder="新工作流名称"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          onPressEnter={() => void onSave()}
        />
        <Button type="primary" loading={saving} onClick={() => void onSave()}>
          保存当前
        </Button>
      </div>
      <Text className="text-xs text-text-secondary mb-2 block">已保存的工作流</Text>
      {workflows.length === 0 ? (
        <PageState status="empty" description="暂无保存的工作流" minHeight="120px" />
      ) : (
        <div className="max-h-[50vh] overflow-y-auto aigc-hub-scrollbar space-y-2">
          {workflows.map((w) => (
            <div key={w.id} className="flex items-center justify-between px-3 py-2 rounded-lg border border-border hover:bg-surface">
              <div>
                <div className="text-sm font-medium">{w.name}</div>
                <div className="text-xs text-text-disabled">{dayjs(w.updatedAt).format('YYYY-MM-DD HH:mm')}</div>
              </div>
              <div className="flex gap-1">
                <Button
                  type="text"
                  size="small"
                  icon={<FolderOpenOutlined />}
                  onClick={() => { onLoad(w); onClose() }}
                >
                  加载
                </Button>
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => rename(w)}
                >
                  重命名
                </Button>
                <Popconfirm
                  title="删除工作流"
                  description={`确定删除「${w.name}」？此操作不可恢复。`}
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void remove(w)}
                >
                  <Button type="text" size="small" danger icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
