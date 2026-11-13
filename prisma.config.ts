import { defineConfig } from 'prisma/config'
import { resolve } from 'path'

// Prisma 7 起 schema.prisma 不再支持 datasource.url：
// 连接串只能由本文件（或 `prisma db push --url`）提供。
//
// ⚠️ 这里必须读 DATABASE_URL，不能硬编码路径：
//   生产容器里 DATABASE_URL=file:/data/dev.db（持久卷），
//   若写死 __dirname/prisma/dev.db，db push 会把 schema 推到容器内的空库，
//   真实数据库永远不迁移 —— 而应用读 /data/dev.db，表现为「新字段不存在」。
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // 生产走 DATABASE_URL；本地开发未设置时回落仓库内 prisma/dev.db
    url: process.env.DATABASE_URL || `file:${resolve(__dirname, 'prisma', 'dev.db')}`,
  },
})
