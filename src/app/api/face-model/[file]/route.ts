import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, dirname, extname } from 'node:path'

const requirePackage = createRequire(join(process.cwd(), 'package.json'))
const allowed = /^face_detection_(?:solution_(?:simd_)?wasm_bin\.(?:js|wasm|data)|short\.binarypb|short_range\.tflite)$/

export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params
  if (!allowed.test(file)) return new Response(null, { status: 404 })
  const types: Record<string, string> = { '.wasm': 'application/wasm', '.js': 'text/javascript' }
  try {
    const dir = dirname(requirePackage.resolve('@mediapipe/face_detection'))
    const data = await readFile(join(dir, file))
    return new Response(Uint8Array.from(data), { headers: {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600',
    } })
  } catch {
    return new Response(null, { status: 404 })
  }
}
