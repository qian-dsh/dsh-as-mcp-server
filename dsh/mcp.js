// dsh/mcp.js —— DSH ↔ MCP 实时会诊桥的 MCP server（Streamable HTTP，多会话：支持记录器 + MCP 客户端 并存）
//
// 对外暴露工具（MCP 客户端调）：
//   dsh_get_status / dsh_get_intent / dsh_set_intent      —— 实时状态 + 共享用户意图（开会）
//   dsh_lock_acquire / dsh_lock_release / dsh_lock_status —— 地板锁（单位时间只许一个智能体动工作区）
//   dsh_inject_alert                                       —— 中断提醒（插进 DSH 正在进行的这一轮）
//   dsh_review_request                                     —— 审查委托（写入收件箱，wb_inbox 可接）
//
// 事件通知（server → client，实时流）：
//   notifications/dsh/status  notifications/dsh/tool  notifications/dsh/file
//   notifications/dsh/thinking  notifications/dsh/intent  notifications/dsh/lock
//   notifications/dsh/alert-queued  notifications/dsh/review
//
// 多会话实现要点（实测修复）：
//   SDK 的 Server 只能 connect 一个 transport，且单个 StreamableHTTPServerTransport 只服务一个会话，
//   所以「每会话独立 Server+transport」才支持多个客户端并存；notify 遍历所有会话广播。
//   客户端重连必须换新 sessionId（旧 id 会 400 死循环）。
//
// 零第三方依赖：SDK 由插件 node_modules junction 提供；支持 node dsh/mcp.js [port] 独立自测。

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js'

export function buildBridgeTools(shared, hooks, opts = {}) {
  const lockTtlMs = Number.isFinite(opts.lockTtlMs) ? opts.lockTtlMs : 300000
  const { notify, writeInboxAlert, writeReviewManifest } = hooks
  const lockValid = () => shared.lock !== null && shared.lock.expiresAt > Date.now()
  const getStatus = () => ({
    status: shared.status,
    current: shared.current,
    turn: shared.turn,
    lastTool: shared.lastTool,
    problems: (shared.problems || []).slice(-10),
    intent: shared.intent,
    lock: lockValid() ? shared.lock : null,
    alertQueue: (shared.alerts || []).length,
  })
  return {
    dsh_get_status: {
      name: 'dsh_get_status',
      description: '读取 DSH 当前实时状态：status/current/turn/lastTool/problems/intent/lock/alertQueue',
      properties: {},
      required: [],
      async execute() { return getStatus() },
    },
    dsh_get_intent: {
      name: 'dsh_get_intent',
      description: '读取共享用户意图（会议议程）：双方实时读到同一份 { text, by, at }',
      properties: {},
      required: [],
      async execute() { return { intent: shared.intent } },
    },
    dsh_set_intent: {
      name: 'dsh_set_intent',
      description: '写入/更新共享用户意图（如「用户要 X，请双方围绕 X 配合」）。text 必填，by 标识写入方',
      properties: {
        text: { type: 'string', description: '意图内容（≤2000 字）' },
        by: { type: 'string', description: '写入方标识，默认 MCP 客户端' },
      },
      required: ['text'],
      async execute(args) {
        shared.intent = {
          text: String(args.text).slice(0, 2000),
          by: typeof args.by === 'string' && args.by.trim() ? args.by.slice(0, 50) : 'mcp-client',
          at: new Date().toISOString(),
        }
        notify('notifications/dsh/intent', shared.intent)
        return { ok: true, intent: shared.intent }
      },
    },
    dsh_lock_acquire: {
      name: 'dsh_lock_acquire',
      description: '获取地板锁：持锁期间 DSH 的写入工具（write/edit/git）会被拒绝，实现单位时间单智能体动工作区',
      properties: {
        owner: { type: 'string', description: '持锁方标识，如 MCP 客户端 或 dsh' },
        ttlMs: { type: 'number', description: '锁有效期（毫秒），默认 300000' },
      },
      required: ['owner'],
      async execute(args) {
        // H4 修复：owner 消毒——缺省/空串直接报错，避免变成字符串 "undefined" 导致释放比对 mismatch
        const ownerRaw = args && typeof args.owner === 'string' ? args.owner.trim() : ''
        if (!ownerRaw) throw new Error('dsh_lock_acquire: owner 必填（如 MCP 客户端 或 dsh）')
        const owner = ownerRaw.slice(0, 50)
        if (lockValid() && shared.lock.owner !== owner) {
          return { ok: false, reason: `工作区已被 ${shared.lock.owner} 锁定`, lock: shared.lock }
        }
        shared.lock = {
          owner,
          at: new Date().toISOString(),
          expiresAt: Date.now() + (Number(args.ttlMs) > 0 ? Number(args.ttlMs) : lockTtlMs),
        }
        notify('notifications/dsh/lock', shared.lock)
        return { ok: true, lock: shared.lock }
      },
    },
    dsh_lock_release: {
      name: 'dsh_lock_release',
      description: '释放地板锁（仅持锁方自己可释放；锁有过期时间兜底）',
      properties: {
        owner: { type: 'string', description: '持锁方标识' },
      },
      required: ['owner'],
      async execute(args) {
        const ownerRaw = args && typeof args.owner === 'string' ? args.owner.trim() : ''
        if (!ownerRaw) throw new Error('dsh_lock_release: owner 必填')
        const owner = ownerRaw.slice(0, 50)
        if (!lockValid()) return { ok: false, reason: '锁未被持有（可能已过期）' }
        if (shared.lock.owner !== owner) {
          return { ok: false, reason: `只有持锁方 ${shared.lock.owner} 能释放` }
        }
        shared.lock = null
        notify('notifications/dsh/lock', null)
        return { ok: true }
      },
    },
    dsh_lock_status: {
      name: 'dsh_lock_status',
      description: '查看地板锁当前状态',
      properties: {},
      required: [],
      async execute() { return { held: lockValid(), lock: shared.lock } },
    },
    dsh_inject_alert: {
      name: 'dsh_inject_alert',
      description: '向 DSH 当前正在进行的这一轮注入提醒（经 pre-step 瀑布插进消息流）。若注入被禁用则写入收件箱',
      properties: {
        message: { type: 'string', description: '提醒内容（≤1000 字）' },
        severity: { type: 'string', enum: ['info', 'warning', 'error'], description: '级别，默认 info' },
      },
      required: ['message'],
      async execute(args) {
        const message = String(args.message).slice(0, 1000)
        const severity = args.severity || 'info'
        // 幂等：同 message+severity 已在未消费队列则跳过，避免同一提醒反复刷屏
        // （呼应 8/22 复盘「不要重复投递同一 alert」）
        const existing = shared.alerts.find((a) => a.message === message && a.severity === severity)
        if (existing) {
          notify('notifications/dsh/alert-queued', existing)
          return { ok: true, alert: existing, queued: shared.alerts.length, deduplicated: true }
        }
        const alert = {
          id: randomUUID(), // 全局唯一，跨重启不撞历史 id，根治 alert-1 撞车
          message,
          severity,
          at: new Date().toISOString(),
        }
        shared.alerts.push(alert)
        notify('notifications/dsh/alert-queued', alert)
        if (typeof writeInboxAlert === 'function') writeInboxAlert(alert)
        return { ok: true, alert, queued: shared.alerts.length }
      },
    },
    dsh_review_request: {
      name: 'dsh_review_request',
      description: '委托审查：写入收件箱（inbox/<id>.json），DSH 的 wb_inbox 工具会在下一轮领走并按 standards 审查 targets，结果回写 inbox/done/',
      properties: {
        id: { type: 'string', description: '任务编号（可选，缺省自动生成）' },
        title: { type: 'string', description: '审查标题（必填）' },
        targets: { type: 'array', items: { type: 'string' }, description: '要审查的文件路径列表' },
        standards: { type: 'array', items: { type: 'string' }, description: '审查标准列表' },
        testCmd: { type: 'string', description: '建议测试命令（DSH 不替你执行）' },
      },
      required: ['title'],
      async execute(args) {
        const manifest = writeReviewManifest(args)
        return { ok: true, manifest }
      },
    },
  }
}

export async function createMcpBridge(handlers, opts = {}, onReady) {
  const { port = 51630, host = '127.0.0.1', token = '' } = opts

  const sessions = new Map() // sessionId -> { server, transport }

  const buildServer = () => {
    const server = new Server(
      { name: 'dsh-mcp-bridge', version: '0.1.1' },
      { capabilities: { tools: {} } },
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Object.values(handlers.tools).map((t) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: {
          type: 'object',
          properties: t.properties || {},
          required: t.required || [],
        },
      })),
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = handlers.tools[request.params.name]
      if (!tool) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`)
      try {
        const result = await tool.execute(request.params.arguments ?? {})
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        return { content: [{ type: 'text', text }] }
      } catch (error) {
        return {
          content: [{ type: 'text', text: `错误: ${String(error?.message ?? error)}` }],
          isError: true,
        }
      }
    })
    return server
  }

  const httpServer = createServer(async (req, res) => {
    if (token) {
      const auth = req.headers.authorization || ''
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
    }

    const sessionId = req.headers['mcp-session-id']
    const method = (req.method || '').toUpperCase()

    // 已有会话 → 复用其 transport（POST/GET/DELETE 统一走这里）
    if (sessionId && sessions.has(sessionId)) {
      sessions.get(sessionId).transport.handleRequest(req, res).catch((error) => {
        console.error(`[dsh-mcp-bridge] 请求处理失败: ${String(error?.message ?? error)}`)
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain' })
          res.end('internal error')
        }
      })
      return
    }

    // 新会话：仅允许通过 POST 的 initialize 建立 → 新建独立 Server + transport
    if (!sessionId && method === 'POST') {
      const server = buildServer()
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => sessions.set(sid, { server, transport }),
      })
      transport.onclose = () => { sessions.delete(transport.sessionId) }
      await server.connect(transport)
      transport.handleRequest(req, res).catch((error) => {
        console.error(`[dsh-mcp-bridge] 新会话处理失败: ${String(error?.message ?? error)}`)
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain' })
          res.end('internal error')
        }
      })
      return
    }

    // 无会话且无 initialize → 拒绝
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: unknown or missing Mcp-Session-Id' },
      id: null,
    }))
  })

  await new Promise((resolveListen, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, host, resolveListen)
  })

  const bridge = {
    url: `http://${host}:${port}/mcp`,
    notify(method, params) {
      for (const { server } of sessions.values()) {
        try { server.notification({ method, params }) } catch { /* 该会话已无流时忽略 */ }
      }
    },
    async close() {
      for (const { transport } of sessions.values()) {
        try { await transport.close() } catch { /* 已关闭 */ }
      }
      await new Promise((r) => httpServer.close(r))
    },
  }
  if (typeof onReady === 'function') onReady(bridge)
  return bridge
}

// ---- 独立自测模式：node dsh/mcp.js [port] ----
const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  const port = Number(process.argv[2] || 51999)
  const shared = {
    status: 'working', current: '演示模式', turn: 0, lastTool: null,
    problems: [], intent: null, lock: null, alerts: [], seq: 0,
  }
  let emit = () => {}
  const tools = buildBridgeTools(shared, {
    notify: (m, p) => emit(m, p),
    writeInboxAlert: (alert) => { console.log(`[demo] 提醒入队: ${alert.message}`) },
    writeReviewManifest: (args) => ({ ...args, id: args.id || 'demo-review', note: 'demo 模式不落盘' }),
  })
  createMcpBridge({ tools }, { port, host: '127.0.0.1' }, (b) => {
    emit = b.notify
    console.log(`[demo] MCP bridge 就绪: ${b.url}`)
    console.log(`[demo] 用 node dsh/mcp-test.js ${b.url} 自测`)
  }).catch((error) => {
    console.error('启动失败:', error)
    process.exit(1)
  })
}
