import { createRoot } from 'react-dom/client'
import { ArrowLeft } from 'lucide-react'
import { GlassDemo } from '@/app/demo/glass/GlassDemo'
import './base.css'

createRoot(document.getElementById('app')!).render(
  <GlassDemo homeLink={<a href="https://github.com/makur6371/aigc-hub"><ArrowLeft size={16} aria-hidden="true" /> AIGC Hub</a>} />,
)
