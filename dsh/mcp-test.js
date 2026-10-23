// dsh/mcp-test.js —— 自测客户端：走完 MCP 握手 + 工具调用 + SSE 通知流
// 用法：node dsh/mcp-test.js [baseUrl]   （默认 http://127.0.0.1:51999/mcp）

const base = process.argv[2] || 'http://127.0.0.1:51999/mcp'

let sessionId = null
let failures = 0
const ok = (label, cond, extra = '') => {
  const mark = cond ? '✅' : '❌'
  if (!cond) failures++
  console.log(`${mark} ${label}${cond && extra ? `（${extra}）` : ''}`)
}

async function post(method, params, id) {
  const body = { jsonrpc: '2.0', id: id ?? Date.now(), method }
  if (params !== undefined) body.params = params
  const res = await fetch(base, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  })
  const sid = res.headers.get('mcp-session-id')
  if (sid) sessionId = sid
  const text = await res.text()
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
  const isSse = (res.headers.get('content-type') || '').includes('text/event-stream')
  if (isSse) {
    const m = text.match(/data:\s*(\{.*\})/s)
    return m ? JSON.parse(m[1]) : null
  }
  return JSON.parse(text)
}

async function openStreamAndWait(expectMethod, timeoutMs) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(base, {
      method: 'GET',
      headers: { accept: 'text/event-stream', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
      signal: ac.signal,
    })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        const m = line.match(/^data:\s*(\{.*\})/)
        if (!m) continue
        try {
          const evt = JSON.parse(m[1])
          if (evt.method === expectMethod) {
            clearTimeout(timer)
            ac.abort()
            return evt
          }
        } catch { /* 忽略坏行 */ }
      }
    }
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  // 1. 握手
  const init = await post('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dsh-mcp-test', version: '1.0.0' },
  })
  ok('initialize', init && init.result && !!init.result.serverInfo, `server=${init.result?.serverInfo?.name}`)
  await post('notifications/initialized')

  // 2. 工具列表
  const list = await post('tools/list')
  const names = (list?.result?.tools || []).map((t) => t.name)
  ok('tools/list 含全部 8 个工具', ['dsh_get_status','dsh_get_intent','dsh_set_intent','dsh_lock_acquire','dsh_lock_release','dsh_lock_status','dsh_inject_alert','dsh_review_request'].every((n) => names.includes(n)), names.join(','))

  const call = async (name, args) => {
    const r = await post('tools/call', { name, arguments: args || {} })
    const text = r?.result?.content?.[0]?.text || ''
    let parsed = null
    try { parsed = JSON.parse(text) } catch { /* 非 JSON */ }
    return { raw: r, text, parsed }
  }

  // 3. get_status
  let c = await call('dsh_get_status')
  ok('dsh_get_status', c.parsed && typeof c.parsed.status === 'string')

  // 4. set_intent（触发通知）
  c = await call('dsh_set_intent', { text: '测试共享意图：双方围绕 X 协作', by: 'test-client' })
  ok('dsh_set_intent', c.parsed && c.parsed.ok === true && c.parsed.intent.text.includes('测试共享意图'))

  // 5. get_intent
  c = await call('dsh_get_intent')
  ok('dsh_get_intent', c.parsed && c.parsed.intent && c.parsed.intent.by === 'test-client')

  // 6. 地板锁：获取 → 状态 → 冲突拒绝 → 释放
  c = await call('dsh_lock_acquire', { owner: 'mcp-client', ttlMs: 60000 })
  ok('dsh_lock_acquire', c.parsed && c.parsed.ok === true && c.parsed.lock.owner === 'mcp-client')
  c = await call('dsh_lock_acquire', { owner: 'other' })
  ok('锁冲突被拒', c.parsed && c.parsed.ok === false)
  c = await call('dsh_lock_status')
  ok('dsh_lock_status 持锁', c.parsed && c.parsed.held === true)
  c = await call('dsh_lock_release', { owner: 'mcp-client' })
  ok('dsh_lock_release', c.parsed && c.parsed.ok === true)
  c = await call('dsh_lock_status')
  ok('释放后未持锁', c.parsed && c.parsed.held === false)

  // 7. inject_alert
  c = await call('dsh_inject_alert', { message: '测试实时提醒', severity: 'warning' })
  ok('dsh_inject_alert', c.parsed && c.parsed.ok === true && c.parsed.queued >= 1)

  // 8. review_request
  c = await call('dsh_review_request', { title: '审查测试文件', targets: ['F:/test/a.js'], standards: ['无密钥'] })
  ok('dsh_review_request', c.parsed && c.parsed.ok === true && !!c.parsed.manifest.id)

  // 9. SSE 通知流：开流 → 并行触发 set_intent → 应收 notifications/dsh/intent
  const trigger = (async () => {
    await new Promise((r) => setTimeout(r, 200))
    await call('dsh_set_intent', { text: 'SSE 测试意图' })
  })()
  const evt = await openStreamAndWait('notifications/dsh/intent', 5000)
  await trigger
  ok('SSE 通知流收到 notifications/dsh/intent', !!evt && !!evt.params && String(evt.params.text).includes('SSE 测试'))

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('测试失败:', error.message)
  process.exit(1)
})
