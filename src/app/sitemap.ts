import type { MetadataRoute } from 'next'
import { BASE_URL, LAST_MODIFIED, PUBLIC_ROUTES } from '@/lib/public-routes'

export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_ROUTES.filter((r) => r.indexed).map((r) => ({
    url: `${BASE_URL}${r.path}`,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
    lastModified: LAST_MODIFIED,
  }))
}
