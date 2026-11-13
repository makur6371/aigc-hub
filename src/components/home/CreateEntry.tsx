'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Pencil } from 'lucide-react'
import styles from './HomePage.module.css'

const samples = ['generate a cat…', 'generate a video of a paper boat…', '让 Agent 规划一组海报…']

export function CreateEntry() {
  const [text, setText] = useState(samples[0])

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    let timer: ReturnType<typeof setTimeout> | undefined
    let index = 0
    let length = samples[0].length
    let deleting = true

    function tick() {
      const sample = samples[index]
      length += deleting ? -1 : 1
      setText(sample.slice(0, length))
      let delay = deleting ? 30 : 66
      if (deleting && length === 0) {
        index = (index + 1) % samples.length
        deleting = false
        delay = 320
      } else if (!deleting && length === sample.length) {
        deleting = true
        delay = 2000
      }
      timer = setTimeout(tick, delay)
    }

    function syncMotion() {
      clearTimeout(timer)
      if (preference.matches || document.hidden) {
        if (preference.matches) {
          index = 0
          length = samples[0].length
          deleting = true
          setText(samples[0])
        }
        return
      }
      timer = setTimeout(tick, deleting && length === samples[index].length ? 2200 : 120)
    }

    syncMotion()
    preference.addEventListener('change', syncMotion)
    document.addEventListener('visibilitychange', syncMotion)
    return () => {
      clearTimeout(timer)
      preference.removeEventListener('change', syncMotion)
      document.removeEventListener('visibilitychange', syncMotion)
    }
  }, [])

  return (
    <Link href="/create" prefetch aria-label="开始创作" className={styles.entry}>
      <span className={styles.entryIcon} aria-hidden="true"><Pencil size={20} /></span>
      <span className={styles.typeSample} aria-hidden="true"><span>{text}</span><span className={styles.caret} /></span>
      <span className={styles.entryAction} aria-hidden="true">开始创作 <ArrowRight size={16} /></span>
    </Link>
  )
}
