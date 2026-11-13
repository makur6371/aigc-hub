// 值转换与归一化：把内部统一参数值映射成厂商要求的格式。
// 由 VendorProfile.fieldMap.transforms 声明驱动，resolver 据此生成请求体。
import type { ValueTransform, AdapterConfig } from '@/types'

/**
 * 应用单个值转换。
 * 未命中任何转换规则时原样返回（视为恒等）。
 */
export function applyValueTransform(
  value: unknown,
  transform: ValueTransform | undefined,
  config: AdapterConfig & Record<string, unknown>,
): unknown {
  if (transform === undefined) return value
  switch (transform.type) {
    case 'scale': {
      const n = Number(value)
      if (Number.isNaN(n)) return value
      return Math.round(n * transform.scale + (transform.offset || 0))
    }
    case 'clamp': {
      const n = Number(value)
      if (Number.isNaN(n)) return value
      let v = n
      if (transform.min !== undefined) v = Math.max(v, transform.min)
      if (transform.max !== undefined) v = Math.min(v, transform.max)
      return v
    }
    case 'enum': {
      const key = String(value)
      return key in transform.map ? transform.map[key] : value
    }
    case 'format': {
      // 支持 {field} 占位符：从 config / value 上下文取值。value 本身可被当作 {value}
      const inject = (template: string): unknown => {
        return template.replace(/\{(\w+)\}/g, (_, name: string) => {
          if (name === 'value') return String(value ?? '')
          return String(config[name] ?? '')
        })
      }
      return inject(transform.template)
    }
    case 'bool': {
      const b = Boolean(value)
      if (transform.as === '0/1') return b ? 1 : 0
      if (transform.as === 'true/false') return b ? 'true' : 'false'
      return b
    }
    case 'tostring':
      return value === null || value === undefined ? value : String(value)
    default:
      return value
  }
}

/** 便捷工具：把某内部参数值转成厂商请求体字段名 + 转换后的值。 */
export function toVendorField(
  internal: string,
  value: unknown,
  aliases: Record<string, string> | undefined,
  transforms: Record<string, ValueTransform> | undefined,
  config: AdapterConfig & Record<string, unknown>,
): { key: string; value: unknown } {
  const key = aliases?.[internal] ?? internal
  const v = applyValueTransform(value, transforms?.[internal], config)
  return { key, value: v }
}
