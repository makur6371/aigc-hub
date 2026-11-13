export const USAGE_FAILURE_WHERE = { OR: [{ statusCode: { notIn: [200, 202] } }, { statusCode: null }] }

export function isUsageError(code: number | null): boolean {
  return code !== 200 && code !== 202
}

export function readUsageResponse(raw: string | null): Record<string, unknown> {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch { return {} }
}
