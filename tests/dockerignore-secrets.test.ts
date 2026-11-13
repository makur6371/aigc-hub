import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * .dockerignore 必须排除所有真实密钥文件（防回归）
 *
 * 实测事故（2026-10-01 整理时发现）：
 *   .dockerignore 里只列了精确名 .env / .env.local / ...，
 *   而 **.env.bak-、.env.bak-20260911124243、.env.bak-manual** 这些「备份」文件
 *   不匹配任何一条 —— 于是被 docker build 的 `COPY . .` 打进了镜像层。
 *   WX_TOKEN / EMBEDDING_API_KEY。镜像可被任何有 docker 权限的人读取 = 密钥外泄。
 *
 * 修法：改成通配 `.env` + `.env.*`，覆盖一切变体。
 * 这个测试盯的就是「别再退回成列举固定文件名的写法」。
 */
const DOCKERIGNORE = readFileSync(join(__dirname, '..', '.dockerignore'), 'utf8')
const LINES = DOCKERIGNORE.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))

/** 极简 glob 匹配：支持 * 通配（够用于本文件里的模式） */
function matches(pattern: string, name: string): boolean {
  if (pattern === name) return true
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  return re.test(name)
}

const ignored = (name: string) => LINES.some((p) => matches(p, name))

describe('.dockerignore 密钥防护', () => {
  it('真实密钥文件全部被排除（含各种备份变体）', () => {
    const mustIgnore = [
      '.env',
      '.env.local',
      '.env.production',
      '.env.bak-',
      '.env.bak-manual',
      '.env.bak-20260911124243',
      '.env.bak-20260911145113',
      '.env.production.local',
      '.env.development.local',
    ]
    for (const f of mustIgnore) {
      expect(ignored(f), `${f} 会被打进镜像`).toBe(true)
    }
  })

  it('不能只靠列举固定文件名（当前实现必须是通配思路）', () => {
    // 若有人把 .env.* 去掉、退回逐个列举，新增的备份文件名就会漏
    expect(LINES).toContain('.env*')
  })

  it('根目录已知临时/资料文件也被排除（白占镜像体积）', () => {
    for (const f of ['data', 'public/generated', 'coverage']) {
      expect(ignored(f), `${f} 会进镜像`).toBe(true)
    }
  })

  it('源码与依赖不能被误排除（否则构建直接挂）', () => {
    // 注意：Dockerfile / docker-compose.yml 被排除是**故意的**（Docker 不需要把
    // 它们复制进镜像），所以不在本断言之列。这里只断言构建真正需要的路径。
    for (const f of ['src', 'public', 'package.json', 'package-lock.json', 'prisma', 'next.config.ts', 'prisma.config.ts']) {
      expect(ignored(f), `${f} 被误排除会导致构建失败`).toBe(false)
    }
  })
})
