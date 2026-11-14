import type { Metadata } from 'next'
import { GlassDemo } from './GlassDemo'

export const metadata: Metadata = {
  title: '芋泥紫 × 液态玻璃 · AIGC Hub',
  description: 'AIGC Hub 的 WebGL 动态玻璃演示。',
}

export default function GlassDemoPage() {
  return <GlassDemo />
}
