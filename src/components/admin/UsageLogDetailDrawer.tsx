'use client'

import { App, Button, Drawer, Typography } from 'antd'
import dayjs from 'dayjs'
import { StatusTag } from '@/components/ui/StatusTag'

const { Text } = Typography

export interface UsageLogDetailItem {
  id: string
  userId: string
  user?: { id: string; phone: string | null; nickname: string | null } | null
  modelId?: string
  model?: { id: string; name: string; type: string } | null
  tokensUsed?: number | null
  pointsDeducted?: number | null
  beansDeducted?: number | null
  statusCode?: number | null
  errorMessage?: string | null
  durationMs?: number | null
  submissionDurationMs?: number | null
  confirmationDurationMs?: number | null
  source?: string | null
  nodeLabel?: string | null
  runId?: string | null
  taskId?: string | null
  taskProgress?: string | null
  requestJson?: string | null
  responseJson?: string | null
  createdAt: string
}

export const usageSourceLabels: Record<string, string> = {
  api: '接口直调', canvas: '画布', workflow: '工具箱', copilot: 'Copilot', agent: 'Agent', ecom: '电商 Agent',
}

function duration(value: number | null | undefined, submission = false) {
  if (value == null) return '-'
  const text = value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`
  return submission ? `提交 ${text}` : text
}

function status(code: number | null | undefined) {
  if (code === 202) return <StatusTag tone="accent">进行中（等上游）</StatusTag>
  if (code === 200) return <StatusTag tone="success">成功</StatusTag>
  return <StatusTag tone="danger">失败 {code ?? '异常'}</StatusTag>
}

/** 管理员调用详情：用户管理「使用日志」与运维「调用记录」共用。 */
export function UsageLogDetailDrawer({ log, onClose }: { log: UsageLogDetailItem | null; onClose: () => void }) {
  const { message } = App.useApp()
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); message.success('已复制') }
    catch { message.error('复制失败，请手动选中复制') }
  }

  return (
    <Drawer title="调用详情" open={!!log} onClose={onClose} width="min(720px, 100vw)" destroyOnHidden>
      {log && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 text-[13px]">
            <div><Text type="secondary" className="block text-[11px]">用户</Text>{log.user?.nickname || log.user?.phone || log.userId}</div>
            <div><Text type="secondary" className="block text-[11px]">模型</Text>{log.model?.name || log.modelId || '—'}</div>
            <div><Text type="secondary" className="block text-[11px]">状态</Text>{status(log.statusCode)}</div>
            <div><Text type="secondary" className="block text-[11px]">时间</Text>{dayjs(log.createdAt).format('YYYY-MM-DD HH:mm:ss')}</div>
            <div>
              <Text type="secondary" className="block text-[11px]">来源</Text>
              {usageSourceLabels[log.source ?? ''] || log.source || '—'}{log.nodeLabel ? ` · ${log.nodeLabel}` : ''}
            </div>
            <div>
              <Text type="secondary" className="block text-[11px]">扣除</Text>
              {(log.beansDeducted ?? 0) > 0 ? `${Number(log.beansDeducted).toFixed(2)} 豆` : `${Number(log.pointsDeducted ?? 0).toFixed(2)} 积分`}
            </div>
            <div>
              <Text type="secondary" className="block text-[11px]">耗时</Text>
              {duration(log.durationMs, log.submissionDurationMs != null)}
              {log.confirmationDurationMs != null && <Text className="block text-xs text-text-secondary">完成确认总用时 {(log.confirmationDurationMs / 1000).toFixed(1)} 秒</Text>}
            </div>
            <div><Text type="secondary" className="block text-[11px]">Tokens</Text>{log.tokensUsed ?? '—'}</div>
            {log.taskId && (
              <div className="col-span-2">
                <Text type="secondary" className="block text-[11px]">上游任务 ID</Text>
                <Text copyable={{ text: log.taskId }} className="break-all font-mono text-[11px]">{log.taskId}</Text>
                {log.taskProgress && <Text className="block text-[11px] text-text-disabled">{log.taskProgress}</Text>}
              </div>
            )}
            {log.runId && <div className="col-span-2"><Text type="secondary" className="block text-[11px]">执行任务</Text><Text copyable={{ text: log.runId }} className="break-all font-mono text-[11px]">{log.runId}</Text></div>}
          </div>

          {log.errorMessage && (
            <div>
              <Text type="secondary" className="mb-1 block text-[11px]">错误信息</Text>
              <div className="rounded-lg bg-red-50 p-3 text-[12px] leading-relaxed text-danger">{log.errorMessage}</div>
            </div>
          )}

          <div>
            <div className="mb-1 flex items-center justify-between">
              <Text type="secondary" className="text-[11px]">请求详情</Text>
              {log.requestJson && <Button type="link" size="small" onClick={() => void copy(log.requestJson!)}>复制</Button>}
            </div>
            <pre className="aigc-hub-scrollbar max-h-72 overflow-auto rounded-lg bg-surface p-3 text-[11px] leading-relaxed">{log.requestJson || '（本次调用未记录请求详情）'}</pre>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <Text type="secondary" className="text-[11px]">返回详情</Text>
              {log.responseJson && <Button type="link" size="small" onClick={() => void copy(log.responseJson!)}>复制</Button>}
            </div>
            <pre className="aigc-hub-scrollbar max-h-72 overflow-auto rounded-lg bg-surface p-3 text-[11px] leading-relaxed">{log.responseJson || '（本次调用未记录返回详情）'}</pre>
          </div>
        </div>
      )}
    </Drawer>
  )
}
