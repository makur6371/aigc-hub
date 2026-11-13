// 端口类型兼容判断：src 输出端口能否连接到 tgt 输入端口
// 规则：同类型直接连；数组可连任意(整传或按 index 取元素)；文本/图片等按可强制转换的关系放行，杜绝明显错误(如 number→image)
export function canConnect(srcType: string | undefined, tgtType: string | undefined): boolean {
  if (!srcType || !tgtType) return true // 未知类型放行
  if (srcType === tgtType) return true
  if (srcType === 'array' || srcType === 'stream') return true // 数组/流可连任意
  switch (tgtType) {
    case 'array':
      return srcType === 'string' // 数组目标:接数组(已在上行返回)或 JSON 字符串
    case 'string':
      return ['number', 'boolean', 'object', 'image'].includes(srcType)
    case 'image':
      return srcType === 'string' // 图片目标:接图片(已在上行返回)或图片 URL 字符串
    case 'number':
      return srcType === 'string'
    case 'object':
      return srcType === 'string'
    case 'boolean':
      return srcType === 'string'
    case 'stream':
      return srcType === 'string'
    default:
      return false
  }
}
