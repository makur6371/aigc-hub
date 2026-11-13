// 工具库类型定义：一个「工作流工具」= 工作流快照 + 暴露的输入/输出端口绑定。
// 面板(components/canvas/ToolPanel)据此渲染一键输入、一键运行、一键输出。

export interface ToolNodeDef {
  type: string
  label?: string
  inputs?: Record<string, unknown>
  systemPrompt?: string
}

export interface ToolConnDef {
  source: number
  sourcePort: string
  target: number
  targetPort: string
}

export interface ToolInputBinding {
  /** 工具内部唯一标识（用于面板输入状态） */
  key: string
  /** 指向快照 nodes 的下标 */
  nodeIndex: number
  /** 写入目标节点输入端口名（ratio 特殊:写入 width/height） */
  port: string
  label: string
  control: 'text' | 'textarea' | 'model' | 'ratio' | 'number'
  options?: string[]
  placeholder?: string
}

export interface ToolOutputBinding {
  key: string
  nodeIndex: number
  port: string
  label: string
  kind: 'image' | 'text' | 'video' | 'audio' | 'url'
}

export interface WorkflowTool {
  id: string
  name: string
  description: string
  category: string
  nodes: ToolNodeDef[]
  connections: ToolConnDef[]
  inputs: ToolInputBinding[]
  outputs: ToolOutputBinding[]
}
