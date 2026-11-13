export function handle401() {
  if (typeof window === 'undefined') return
  const current = window.location.pathname
  if (current === '/login') return
  window.location.href = `/login?from=${encodeURIComponent(current)}`
}
