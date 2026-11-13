import { describe, expect, it } from 'vitest'
import { readSource } from './helpers/source-guard'

/**
 * Q-D39 守卫：容器启动的 `prisma db push` 不允许带 --accept-data-loss。
 *
 * 为什么值得钉死：带这个标志时，「生产库里有、schema.prisma 里没有」的列会被静默删除，
 * 部署不报错、监控看不出来，只会在某天发现数据不见了。这类缺陷必须靠机械检查挡住，
 * 不能靠 review 时记住。
 */
describe('生产 schema 同步不得携带数据丢失授权', () => {
  const dockerfile = readSource('Dockerfile')

  // 只查真正的指令行：注释里保留这个标志名是有价值的（说明为什么不能用），
  // 全文匹配会把解释也判成违规，逼人删注释。
  const instructionLines = dockerfile
    .split('\n')
    .filter((l) => !l.trim().startsWith('#') && /\S/.test(l))
    .join('\n')

  it('指令行里不出现 --accept-data-loss', () => {
    expect(instructionLines).not.toContain('--accept-data-loss')
  })

  it('启动仍执行 prisma db push（防止反过来被整条删掉，导致加列不上线）', () => {
    expect(dockerfile).toMatch(/prisma db push(?!!)/)
  })

  it('schema 同步失败时不启动应用', () => {
    expect(instructionLines).toMatch(/prisma db push && exec /)
  })
})
