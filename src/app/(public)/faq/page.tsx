import type { Metadata } from 'next'
import Link from 'next/link'
import { ORG, FAQS } from '../_content'

export const metadata: Metadata = {
  title: `常见问题 - ${ORG.name}`,
  description: `${ORG.name} 常见问题：对话记录、积分计费与退款、充值、模型可用性、作品广场、数据安全、AI 漫剧与电商图创作等 ${FAQS.length} 条问答。`,
}

function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  )
}

const faqJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQS.map((f) => ({
    '@type': 'Question',
    name: f.q,
    acceptedAnswer: { '@type': 'Answer', text: f.a },
  })),
}

export default function FaqPage() {
  return (
    <>
      <JsonLd data={faqJsonLd} />

      <section className="mb-10">
        <h1 className="text-3xl md:text-4xl font-bold text-foreground mb-4">常见问题</h1>
        <p className="text-lg text-text-muted leading-relaxed max-w-3xl">
          关于 {ORG.name} 的积分计费、充值退款、模型可用性、创作方法与数据安全，这里有 {FAQS.length} 条想要了解的答案。
        </p>
      </section>

      <section className="space-y-3">
        {FAQS.map((f) => (
          <details
            key={f.q}
            className="group rounded-xl border border-border bg-white open:ring-1 open:ring-accent-border"
          >
            <summary className="cursor-pointer list-none px-5 py-4 font-medium text-foreground flex items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
              <span>{f.q}</span>
              <span className="text-accent text-xl leading-none group-open:rotate-45 transition-transform" aria-hidden>
                +
              </span>
            </summary>
            <p className="px-5 pb-5 text-sm text-text-muted leading-relaxed">{f.a}</p>
          </details>
        ))}
      </section>

      <div className="mt-12 rounded-xl border border-border bg-surface p-6 text-sm text-text-muted">
        没有找到想要的答案？{' '}
        <Link href="/login" className="text-accent font-medium hover:underline">
          注册账号
        </Link>{' '}
        后即可在应用内帮助中心查看完整指南，或通过管理员反馈问题。
      </div>
    </>
  )
}
