import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 源码守卫的共用底座（台账 Q-D30）。
 *
 * 为什么需要：仓库里有 30+ 个测试用 `readFileSync` + 字符串/正则给源码定规矩
 * （「终态必须条件写」「不得裸 jwt.sign」「模板槽位必须有键」这类不变式，编译器看不见，
 * 只能靠源码断言钉住）。这类测试有两种失效模式，而且**都是静默的**：
 *
 *   1. **假绿**：切片/正则失配后返回空串，`expect('').not.toMatch(...)` 自然通过 ——
 *      守卫变成永远为真的空话。本轮就实际踩到过：旧负向正则 `(ctx)` 匹配不到
 *      `Foo(ctx, extra)`，最需要它的分支回归时测试照样是绿的。
 *   2. **假红**：工作副本是 CRLF（仓库里 `*.ts` 存 LF，但 checkout 后是 CRLF），
 *      多行正则与 `toContain` 的换行断言会莫名失败。30+ 个文件里只有 2 个自己做了归一化。
 *
 * 本文件把三件事变成强制：
 *   - 读源码必须过 `readSource()`（内部统一换行 + 非空校验）；
 *   - 取「某个声明到下一个声明之间」的片段必须过 `sliceBlock()`（取不到就抛，不返回空串）；
 *   - 每个**负向**断言必须带一条正向锚点（`anchor`）：锚点不成立说明读取/解析坏了，
 *     于是"假绿"当场变红。
 */

/** 读仓库内文件，统一换行符；空文件或读不到一律直接失败（不许静默通过） */
export function readSource(relPath: string): string {
  const abs = join(process.cwd(), relPath)
  if (!existsSync(abs)) throw new Error(`源码守卫读不到文件：${relPath}（被改名或删除？先确认不变式是否仍然成立再改测试）`)
  const text = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
  if (text.trim().length === 0) throw new Error(`源码守卫读到空文件：${relPath}`)
  return text
}

/**
 * 截出「从某个标记到下一个顶层声明之前」的一段源码。
 * 找不到标记就抛 —— 返回空串会让后面的负向断言假绿。
 */
export function sliceBlock(src: string, startMarker: string, endMarker = /^\s*export\s+(?:async\s+)?(?:type|interface|const|function)\b/m): string {
  const at = src.indexOf(startMarker)
  if (at < 0) throw new Error(`源码守卫找不到锚：${startMarker.slice(0, 60)}`)
  const rest = src.slice(at + startMarker.length)
  const endMatch = endMarker.exec(rest)
  const body = endMatch ? rest.slice(0, endMatch.index) : rest
  if (body.trim().length === 0) throw new Error(`源码守卫锚点 ${startMarker.slice(0, 60)} 后取到空片段`)
  return body
}

/** 正向断言：src 必须包含 needle */
export function assertContains(src: string, needle: string, why: string): void {
  if (!src.includes(needle)) throw new Error(`源码守卫失败：${why}\n  缺少片段：${needle.slice(0, 120)}`)
}

/**
 * 负向断言：src 不得匹配 re。
 * `anchor` 是**必须成立**的正向锚点（正则或字符串）：它证明你真的读到了该读的区域，
 * 否则本条断言就是空跑 —— 这是把「假绿」变「红」的关键。
 */
export function assertNotMatches(src: string, re: RegExp, why: string, anchor: RegExp | string): void {
  const anchored = typeof anchor === 'string' ? src.includes(anchor) : anchor.test(src)
  if (!anchored) throw new Error(`源码守卫的锚点没命中，无法证明检查范围（可能是解析失效）：\n  锚点=${String(anchor)}`)
  if (re.test(src)) throw new Error(`源码守卫失败：${why}\n  命中的违规模式=${String(re)}`)
}

/**
 * 读多个文件并**按给定顺序**拼成一个字符串。
 *
 * 为什么需要：源码守卫常用「从 A 声明切到 B 声明」这种区间断言
 * （`sliceBetween(src, 'export function Foo', 'export function Bar')`）。
 * 一个文件被拆成多个模块后，这个区间可能**跨文件** —— 按顺序拼起来才能保住
 * 原来的区间语义（起点在前、终点在后）。
 *
 * 传空数组会抛错，而不是返回空串 —— 空串会让所有负向断言变成永远为真的空话。
 */
export function readSourcesConcat(relPaths: string[]): string {
  if (!relPaths.length) throw new Error('readSourcesConcat 传了空列表（会得到空串，让负向断言假绿）')
  return relPaths.map((p) => readSource(p)).join('\n')
}

/** 供「新守卫必须使用本文件」的自检使用 */
export const SOURCE_GUARD_HELPER = 'tests/helpers/source-guard'
