// 画布数据契约（Q-803 自 canvas-utils 拆出）：只有类型，无逻辑、无副作用。


export type FileInfo = {
  uid: string
  name: string
  status?: 'done' | 'uploading' | 'error'
  url?: string
  originFileObj?: File
  type?: string
  size?: number
}

export type NodePort = {
  type: string
  required?: boolean
  label: string
  description?: string
  defaultValue?: unknown
}

export type NodeInfo = {
  id: string
  nodeType: string
  label: string
  category: string
  categoryLabel: string
  inputs: Record<string, NodePort>
  outputs: Record<string, NodePort>
  description: string
}

export type CanvasNode = {
  id: string
  type: string
  label: string
  category: string
  x: number
  y: number
  inputs: Record<string, unknown>
  outputs: Record<string, unknown>
  batch?: { sourceId: string; index: number }
}


/** 画布便签节点（轻量级注释卡片，不参与 DAG 拓扑执行） */
export type StickyNote = {
  id: string
  x: number
  y: number
  width: number
  height: number
  text: string
  color: 'yellow' | 'pink' | 'blue' | 'green' | 'orange'
  createdAt: number
}

export type Connection = {
  id: string
  sourceNodeId: string
  sourcePort: string
  targetNodeId: string
  targetPort: string
  index?: number
}

export type Viewport = {
  x: number
  y: number
  scale: number
}

export type DragState =
  | { type: 'idle' }
  | { type: 'pan'; startX: number; startY: number; startViewport: Viewport }
  | { type: 'node'; nodeId: string; startX: number; startY: number; startNodeX: number; startNodeY: number }
  | { type: 'connection'; sourceNodeId: string; sourcePort: string; endX: number; endY: number }
  | { type: 'select'; startX: number; startY: number; curX: number; curY: number }

export type HistorySnapshot = { nodes: CanvasNode[]; connections: Connection[]; stickyNotes?: StickyNote[] }


/** 历史快照扩展：便签纳入撤销/重做 */
export type FullHistorySnapshot = HistorySnapshot

export type ExecutionLog = {
  nodeId: string
  status: 'running' | 'success' | 'error'
  output?: Record<string, unknown>
  error?: string
}

export type WorkflowItem = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}
