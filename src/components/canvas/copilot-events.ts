// 简单事件总线:画布执行完工作流后通知 Copilot 自动分析

type ExecutionResult = {
  logs: { nodeId: string; status: 'success' | 'error'; error?: string }[]
  error?: string
}

type Listener = (result: ExecutionResult) => void

let listener: Listener | null = null

export function onWorkflowExecuted(fn: Listener) {
  listener = fn
  return () => { listener = null }
}

export function emitWorkflowExecuted(result: ExecutionResult) {
  listener?.(result)
}
