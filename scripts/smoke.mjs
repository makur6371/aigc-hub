import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const base = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
const email = process.env.BOOTSTRAP_EMAIL
const password = process.env.BOOTSTRAP_PASSWORD
assert.ok(email && password, 'Supply the demo login through BOOTSTRAP_EMAIL and BOOTSTRAP_PASSWORD.')

const home = await fetch(base)
assert.equal(home.status, 200)
assert.match(await home.text(), /AIGC Hub/)
for (const path of ['/create', '/create/video', '/tools', '/login']) {
  assert.equal((await fetch(base + path)).status, 200, path)
}
const anon = await fetch(base + '/api/demo/models')
assert.equal(anon.status, 404, 'Demo upstream requires an internal credential')
const login = await fetch(base + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ account: email, password }),
})
assert.equal(login.status, 200, 'Login')
const cookie = login.headers.getSetCookie()[0]?.split(';')[0]
assert.ok(cookie)
async function api(path, body) {
  const response = await fetch(base + path, {
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  })
  const json = await response.json()
  assert.ok(response.ok && json.success, `${path} ${response.status}: ${json.message}`)
  return json.data
}
for (const path of ['/canvas', '/admin/settings', '/user/profile']) {
  assert.equal((await fetch(base + path, { redirect: 'manual', headers: { Cookie: cookie } })).status, 200, path)
}
const models = await api('/api/models')
assert.ok(JSON.stringify(models).includes('demo-image'), 'Model catalog')
const image = await api('/api/image/generate', { modelId: 'demo-image', prompt: 'local image', width: 1024, height: 1024 })
assert.ok(image.imageUrl)
assert.match((await fetch(new URL(image.imageUrl, base), { headers: { Cookie: cookie } })).headers.get('content-type') || '', /image\/png/)
const form = new FormData()
form.append('file', new Blob([await readFile('public/demo/preview.png')], { type: 'image/png' }), 'reference.png')
const upload = await fetch(base + '/api/assets', { method: 'POST', headers: { Cookie: cookie }, body: form })
assert.equal(upload.status, 200, 'Reference upload')
const uploadJson = await upload.json()
const imageRef = uploadJson.data.url || uploadJson.data.asset?.url
assert.ok(imageRef, 'Uploaded reference URL')
const graph = await fetch(base + '/api/canvas/execute', {
  method: 'POST',
  headers: { Cookie: cookie, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    workflowName: 'Demo reference image',
    nodes: [{ id: 'gen-image', type: 'image-generate', label: 'Edit image',
      inputs: { model: 'demo-image', prompt: 'local edit', width: 1024, height: 1024, referenceImage: [imageRef] } }],
    connections: [],
  }),
})
assert.equal(graph.status, 200)
assert.match(graph.headers.get('content-type') || '', /text\/event-stream/)
const events = await graph.text()
assert.match(events, /"imageUrl":"\/api\/asset\//, events)
assert.doesNotMatch(events, /"type":"error"/, events)
const agent = await fetch(base + '/api/agent/send', {
  method: 'POST',
  headers: { Cookie: cookie, 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 'manual', modelId: 'demo-text', prompt: 'Hello' }),
})
assert.equal(agent.status, 200)
assert.match(agent.headers.get('content-type') || '', /text\/event-stream/)
assert.match(await agent.text(), /本地演示回复/)
const video = await api('/api/video/generate', { modelId: 'demo-video', prompt: 'local video', duration: 4, resolution: '480P', aspectRatio: '16:9' })
assert.equal(video.status, 'PENDING')
const recovery = await api('/api/results/recovery')
assert.ok(recovery.items.some(item => item.id === 'video:' + video.recordId && item.status === 'PENDING'))
let result
for (let attempts = 0; attempts < 15; attempts++) {
  result = await api('/api/video/status/' + video.recordId)
  if (result.status !== 'PENDING') break
  await new Promise(resolve => setTimeout(resolve, 500))
}
assert.equal(result.status, 'SUCCESS')
assert.match((await fetch(new URL(result.videoUrl, base))).headers.get('content-type') || '', /video\/mp4/)
console.log('Local smoke passed: login, catalog, image, edit, Agent stream, async video, recovery, and workspace pages.')
