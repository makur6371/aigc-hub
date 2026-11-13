// 工具公共类型：直接对齐 SDK CallToolResult（content 块 + 可选 structuredContent）

export interface ToolTextContent {
  type: 'text'
  text: string
}

export interface ToolResult {
  content: ToolTextContent[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
  [key: string]: unknown
}

export function text(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], isError: isError || undefined }
}

export function structured(text: string, data: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: data }
}

export function error(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}
