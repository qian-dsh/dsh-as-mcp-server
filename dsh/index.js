// dsh-mcp-bridge —— DSH ↔ MCP 实时会诊桥（MCP server 版）
//
// 会诊室机制：
//   思维流    llm/stream 瀑布 → notifications/dsh/thinking   （他实时看到你在想什么）
//   动作流    tools/result 事件 → notifications/dsh/tool      （在做什么）
//   文件流    write/edit 工具结果 → notifications/dsh/file    （在对什么进行改动）
//   状态流    agent/status / agent/error → notifications/dsh/status
//   共享意图  dsh_get_intent / dsh_set_intent；每轮 system prompt 自动注入 DSH 侧
//   地板锁    dsh_lock_acquire / release；tools/pre-execute 门禁拒绝持锁方的写入工具
//   中断提醒  dsh_inject_alert → agent/pre-step 瀑布插进当前轮消息流
//   审查委托  dsh_review_request → 写入 MCP 客户端-bridge 收件箱（wb_inbox 可接），落盘后实时通知
//
// 可拆卸：所有监听 ctx.on、MCP server 生命周期由 ctx.effect 持有，卸载自动清理。
// 不冲突：工具名 dsh_* 全局唯一；不替换任何既有能力。
// 安全：默认只监听 127.0.0.1；token 可选；不执行外部传入的命令；锁有过期兜底。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createMcpBridge, buildBridgeTools } from './mcp.js'

export const name = 'dsh-mcp-bridge'
export const inject = ['tools']

const STORE_PATH = join(homedir(), '.dsh-mcp-bridge', 'config.json')

function defaults() {
  return {
    port: 51630,
    host: '127.0.0.1',
    token: '',
    lockTtlMs: 300000,
    denyTools: ['write', 'edit', 'git'],
    alertInjection: true,
    inboxRoot: '',
  }
}

function loadState(patchConfig) {
  const state = Object.assign(defaults(), patchConfig || {})
  try {
    // 兼容编辑器写入的 UTF-8 BOM
    const saved = JSON.parse(readFileSync(STORE_PATH, 'utf8').replace(/^\uFEFF/, ''))
    if (saved && typeof saved === 'object') Object.assign(state, saved)
  } catch {
    // 无落盘覆盖
  }
  return state
}

function safeStr(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

export function apply(ctx, config = {}) {
  const state = loadState(config)
  const inboxRoot = (state.inboxRoot && String(state.inboxRoot).trim()) || join(homedir(), '.dsh-mcp-bridge', 'inbox')

  // ---- 共享状态（MCP 工具 + 事件共同读写） ----
  const shared = {
    status: 'idle',
    current: '',
    turn: 0,
    lastTool: null,
    problems: [],
    intent: null,
    lock: null,
    alerts: [],
    seq: 0,
  }

  let bridge = null
  const notify = (method, params) => {
    if (bridge) bridge.notify(method, params)
  }

  // ---- 收件箱写入（审查委托 / 提醒兜底） ----
  const ensureInbox = () => mkdirSync(inboxRoot, { recursive: true })
  const safeId = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_')

  const writeInboxAlert = (alert) => {
    try {
      ensureInbox()
      // 按内容幂等：同 severity+message 只落盘一个文件，避免 UUID 每次都新导致收件箱堆积
      const key = safeId(`${alert.severity}:${alert.message}`)
      const path = join(inboxRoot, `alert-${key}.json`)
      if (existsSync(path)) return
      writeFileSync(path, `${JSON.stringify({
        id: `alert-${key}`,
        from: 'mcp-client',
        type: 'alert',
        title: `[${alert.severity}] ${alert.message}`,
        createdAt: alert.at,
        standards: ['阅读此提醒并酌情处理'],
      }, null, 2)}\n`)
    } catch (error) {
      console.error(`[dsh-mcp-bridge] 提醒落盘失败: ${String(error?.message ?? error)}`)
    }
  }

  const writeReviewManifest = (args) => {
    const id = typeof args.id === 'string' && args.id.trim() ? safeId(args.id) : `review-${Date.now().toString(36)}`
    const manifest = {
      id,
      from: 'mcp-client',
      type: 'review',
      title: safeStr(args.title, 300),
      createdAt: new Date().toISOString(),
    }
    if (Array.isArray(args.targets)) manifest.targets = args.targets.map((t) => String(t)).slice(0, 50)
    if (Array.isArray(args.standards)) manifest.standards = args.standards.map((s) => String(s)).slice(0, 20)
    if (typeof args.testCmd === 'string' && args.testCmd.trim()) manifest.testCmd = args.testCmd.trim().slice(0, 500)
    ensureInbox()
    writeFileSync(join(inboxRoot, `${id}.json`), `${JSON.stringify(manifest, null, 2)}\n`)
    // H6 修复：实时通知 MCP 客户端「有新审查任务」，无需轮询文件
    notify('notifications/dsh/review', manifest)
    return manifest
  }

  // ---- MCP 工具 ----
  const tools = buildBridgeTools(shared, { notify, writeInboxAlert, writeReviewManifest }, { lockTtlMs: state.lockTtlMs })

  // ---- 事件监听（全部防御式：异常不外抛，只取叶子字段） ----
  ctx.on('agent/status', (payload) => {
    try {
      const p = payload || {}
      if (typeof p.status === 'string') {
        shared.status = p.status === 'running' ? 'working' : 'idle'
        if (shared.status === 'idle') shared.current = ''
        notify('notifications/dsh/status', {
          status: shared.status, current: shared.current, turn: shared.turn,
        })
      }
    } catch (error) {
      console.error(`[dsh-mcp-bridge] agent/status: ${String(error?.message ?? error)}`)
    }
  })

  ctx.on('agent/error', (payload) => {
    try {
      const p = payload || {}
      shared.problems.unshift({
        at: new Date().toISOString(),
        message: `第 ${p.turn ?? '?'} 轮出错: ${safeStr(String(p.error ?? 'unknown'), 300)}`,
      })
      if (shared.problems.length > 20) shared.problems.length = 20
      notify('notifications/dsh/status', {
        status: shared.status, current: shared.current, turn: shared.turn,
        problems: shared.problems.slice(-3),
      })
    } catch (error) {
      console.error(`[dsh-mcp-bridge] agent/error: ${String(error?.message ?? error)}`)
    }
  })

  ctx.on('tools/result', (exec, result) => {
    try {
      if (!exec || typeof exec.name !== 'string') return
      const argHint = (() => {
        try { return JSON.stringify(exec.arguments ?? null).slice(0, 120) } catch { return '' }
      })()
      shared.lastTool = { name: exec.name, argHint }
      shared.turn += 1
      const isError = !!(result && result.isError)
      // 文件改动流：write/edit 这类工具结果即"正在改动的目标"
      if (exec.name === 'write' || exec.name === 'edit') {
        notify('notifications/dsh/file', { action: exec.name, argHint, at: new Date().toISOString() })
      }
      notify('notifications/dsh/tool', { name: exec.name, argHint, isError, turn: shared.turn })
      if (isError) {
        shared.problems.unshift({ at: new Date().toISOString(), message: `工具 ${exec.name} 失败` })
        if (shared.problems.length > 20) shared.problems.length = 20
      }
    } catch (error) {
      console.error(`[dsh-mcp-bridge] tools/result: ${String(error?.message ?? error)}`)
    }
  })

  // 思维流：截获每个流式 chunk，节流转发（绝不阻塞/改写原流）
  // 注意：llm/stream 事件的中间件必须直接返回 async iterable，不能是 async 函数返回 Promise<AsyncGenerator>，
  // 否则 DSH 内部 yield* 会报 "(intermediate value) is not async iterable"。
  ctx.on('llm/stream', (options, next) => {
    return (async function* forwardStream() {
      const inner = await next()
      let buf = ''
      let lastFlush = Date.now()
      const flush = () => {
        if (!buf) return
        const text = buf
        buf = ''
        lastFlush = Date.now()
        try { notify('notifications/dsh/thinking', { text, at: new Date().toISOString() }) } catch { /* 忽略 */ }
      }
      try {
        for await (const chunk of inner) {
          let t = ''
          if (chunk && typeof chunk === 'object') {
            if (typeof chunk.text === 'string') t = chunk.text
            else if (typeof chunk.delta === 'string') t = chunk.delta
            else if (typeof chunk.content === 'string') t = chunk.content
            else if (chunk.content && Array.isArray(chunk.content)) {
              t = chunk.content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('')
            }
          } else if (typeof chunk === 'string') {
            t = chunk
          }
          if (t) {
            buf += t
            if (Date.now() - lastFlush >= 200) flush()
          }
          yield chunk
        }
      } finally {
        flush()
      }
    })()
  })

  // 地板锁门禁：MCP 客户端持锁期间，拒绝 DSH 的写入工具
  const denySet = new Set(state.denyTools)
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const locked = shared.lock !== null && shared.lock.expiresAt > Date.now()
      if (locked && shared.lock.owner !== 'dsh' && exec && typeof exec.name === 'string' && denySet.has(exec.name)) {
        return {
          kind: 'deny',
          reason: `工作区正被 ${shared.lock.owner} 锁定（地板锁），写入工具 ${exec.name} 被拒绝。请等锁释放，或请对方用 dsh_lock_release 释放。`,
        }
      }
    } catch (error) {
      console.error(`[dsh-mcp-bridge] tools/pre-execute: ${String(error?.message ?? error)}`)
    }
    return next()
  })

  // 中断提醒注入：MCP 客户端 的提醒在下一模型步进入当前轮
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision && decision.kind === 'enter' && shared.alerts.length && Array.isArray(decision.messages)) {
        const alert = shared.alerts.shift()
        // 伪装成标准用户消息，避免前端渲染层对 source.kind!=='user' 的消息缺渲染分支而白屏
        const msg = {
          id: alert.id, // 直接用 UUID（绝对唯一），去掉 `||` 短路，避免回退到可碰撞的固定 id
          role: 'user',
          content: [{ type: 'text', text: `[${alert.severity}] MCP 客户端 实时提醒：${alert.message}` }],
          source: { kind: 'user', plugin: 'dsh-mcp-bridge', clientTimeZone: 'Asia/Shanghai' },
        }
        return { ...decision, messages: [...decision.messages, msg] }
      }
    } catch (error) {
      console.error(`[dsh-mcp-bridge] agent/pre-step: ${String(error?.message ?? error)}`)
      if (shared.alerts.length) shared.alerts.unshift(shared.alerts.pop())
    }
    return decision
  })

  // ---- 启动 MCP server（effect 持有生命周期） ----
  let closed = false
  ctx.effect(() => {
    createMcpBridge({ tools }, { port: state.port, host: state.host, token: state.token })
      .then((b) => {
        if (closed) {
          b.close().catch(() => {})
          return
        }
        bridge = b
        console.log(`[dsh-mcp-bridge] MCP server 就绪: ${b.url}（在此接入 MCP 客户端）`)
        notify('notifications/dsh/status', {
          status: shared.status, current: '桥已就绪', turn: shared.turn, bridgeUrl: b.url,
        })
      })
      .catch((error) => {
        console.error(`[dsh-mcp-bridge] MCP server 启动失败: ${String(error?.message ?? error)}`)
      })
    return () => {
      closed = true
      const b = bridge
      bridge = null
      if (b) b.close().catch(() => {})
    }
  })

  // ---- 引导段 + 共享意图注入（每轮 system prompt 自动带上，DSH 侧"听得见开会"） ----
  const sp = ctx.get('systemPrompt')
  if (sp !== undefined) {
    ctx.effect(() => sp.section({
      name: 'tool:dsh-mcp-bridge',
      order: 103,
      text: 'MCP 客户端正实时旁观你（MCP 桥）：思考/工具调用/文件改动都会流式可见。'
        + '若 write/edit/git 被拒绝，说明 MCP 客户端正持地板锁操作工作区——等锁释放或请对方释放后再写。'
        + 'MCP 客户端的实时提醒会以用户消息直接插进当前轮；审查委托走收件箱（wb_inbox 查收）。',
    }))
    // 共享意图注入：每轮 system prompt 自动带上 MCP 客户端 写入的意图（DSH 侧"听得见开会"）
    ctx.effect(() => sp.variable('bridge_intent', () => {
      try {
        if (shared.intent && shared.intent.text) {
          return `当前共享用户意图（MCP 会诊室）：${shared.intent.text}（by ${shared.intent.by}）`
        }
      } catch { /* 忽略 */ }
      return undefined
    }))
  }
}
