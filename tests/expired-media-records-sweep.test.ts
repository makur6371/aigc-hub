import { describe, expect, it } from 'vitest'
import { readSource } from './helpers/source-guard'

const records = readSource('src/lib/user-media-records.ts')
const maint = readSource('src/lib/maintenance.ts')

describe('过期生成记录平台级回收（Q-D61 收口）', () => {
  it('平台清理走既有删除实现（含本站文件回收），不另写一份删除逻辑', () => {
    expect(records).toMatch(/purgeExpiredMediaRecordsForPlatform/)
    expect(records).toMatch(/await deleteRecordsWithFiles\(kind, rows\)/)
  })

  it('清理范围限定 expiresAt 已过，且 PENDING 必须被排除（异步退款依赖它）', () => {
    expect(records).toMatch(/expiresAt: \{ lt: new Date\(\) \}, status: \{ not: 'PENDING' \}/)
  })

  it('平台级查询不带 userId（全平台范围）；用户级两条入口仍带 userId', () => {
    expect(records).toMatch(/findRecordUrls\(kind, \{ take: 2000 \}\)/)
    expect(records).toMatch(/findRecordUrls\(kind, \{ userId: authUser\.userId, ids \}\)/)
    expect(records).toMatch(/findRecordUrls\(kind, \{ userId: authUser\.userId, take: 2000 \}\)/)
  })

  it('已接入维护任务（否则写了也不会跑），且失败走 mlog 进错误面板', () => {
    expect(maint).toMatch(/purgeExpiredMediaRecordsForPlatform/)
    expect(maint).toMatch(/清理过期生成记录失败/)
  })

  it('维护结果带过期记录回收计数，后台手动维护的提示文案能拿到', () => {
    expect(maint).toMatch(/expiredMediaRecords: \{ image: number; video: number; audio: number \}/)
    const adminRoute = readSource('src/app/api/admin/assets-cleanup/route.ts')
    expect(adminRoute).toMatch(/过期生成记录/)
  })
})
