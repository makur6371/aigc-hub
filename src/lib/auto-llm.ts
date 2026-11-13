/** 文本/多模态槽位的“自动模型”哨兵值：按 Agent 全局配置的顺序选择并在失败时降级。 */
export const AUTO_LLM_MODEL_ID = 'auto-llm'
export const AUTO_LLM_MODEL_NAME = 'Auto-LLM（自动切换）'

export function isAutoLlm(modelId: string | null | undefined): boolean {
  return modelId === AUTO_LLM_MODEL_ID
}
