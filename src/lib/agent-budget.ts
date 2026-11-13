/**
 * Agent run 的硬预算。
 *
 * 规划轮次和工具动作分开计数：
 * - 规划轮次限制模型来回次数，防止一直追问/返工；
 * - 动作预算限制真正派发到上游的次数，支持一轮多镜头，但不能无限烧成本。
 *
 * 放在叶子模块，供 prompt、工具循环和测试共用，避免循环依赖。
 */
export const AGENT_MAX_PLANNER_TURNS = 8
export const AGENT_MAX_TOOL_ACTIONS = 24
