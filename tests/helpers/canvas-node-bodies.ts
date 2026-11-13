import { readSourcesConcat } from './source-guard'

/**
 * 画布节点卡身源码（Q-303 拆分后）。
 *
 * 拆分前是**一个** `node-bodies.tsx`（2142 行）；现在是 `node-bodies/` 目录下的 6 个模块
 * + 一个 barrel。三个源码守卫测试（canvas-dispatch-components / node-body-workbench-wiring /
 * face-doodle-layers）都靠「从 A 声明切到 B 声明」的区间断言工作，而这些区间**跨文件**
 * （例如 FaceDoodleBody 在 bodies.tsx、FaceDoodleParamBar 在 param-bars.tsx）。
 *
 * 所以这里按**固定顺序**拼起来，区间语义与拆分前保持一致。
 * 顺序不能随便改：`bodies → param-bars → prompt-panels → dispatch` 正好对应
 * 「卡身 → 参数条 → 填写面板 → 分派」的分层顺序。
 */
export const NODE_BODIES_FILES = [
  'src/components/canvas/node-bodies/types.ts',
  'src/components/canvas/node-bodies/shared.tsx',
  'src/components/canvas/node-bodies/bodies.tsx',
  'src/components/canvas/node-bodies/param-bars.tsx',
  'src/components/canvas/node-bodies/prompt-panels.tsx',
  'src/components/canvas/node-bodies/dispatch.tsx',
]

export function readNodeBodiesSource(): string {
  return readSourcesConcat(NODE_BODIES_FILES)
}
