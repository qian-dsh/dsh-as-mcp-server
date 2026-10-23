// dsh/bridge-regression.test.mjs —— 桥插件 2 个已知 bug 的回归测试
//
// 背景（复盘分锅 2026-08-22）：
//   Bug A: systemPrompt 变量名 'MCP 客户端Intent' 违反 cordis 规则 /^[a-z][a-z0-9_]*$/（驼峰）
//          → 插件加载抛错 → 51630 起不来（连接器崩）
//   Bug B: llm/stream 监听器写成 async 函数，返回 Promise<AsyncGenerator>
//          → DSH 内部 yield* 报 "(intermediate value) is not async iterable"（红字崩）
//
// 方法：mock ctx 跑真实 apply()（真实插件代码 + 真实 mcp.js/SDK，测试端口 51997）。
//   正向断言修复后的行为；负向断言旧 bug 形态确实失败（留档）。
// 运行：node dsh/bridge-regression.test.mjs   （退出码 0=全过）

import { apply } from './index.js'

const CORDIS_VAR_NAME_RULE = /^[a-z][a-z0-9_]*$/

// ---- mock ctx：捕获事件监听与 systemPrompt 注册，并模拟 cordis 变量名校验 ----
function makeMockCtx() {
  const captured = { listeners: {}, variable: null }
  const ctx = {
    on(name, fn) { captured.listeners[name] = fn },
    get(name) {
      if (name === 'systemPrompt') {
        return {
          section: () => () => {},
          variable: (vname, provider) => {
            // 模拟 cordis 规则：非法名抛错（旧版 'MCP 客户端Intent' 会在这里炸）
            if (!CORDIS_VAR_NAME_RULE.test(vname)) {
              throw new Error(`invalid variable name "${vname}" (must match ${CORDIS_VAR_NAME_RULE})`)
            }
            captured.variable = { name: vname, provider }
            return () => {}
          },
        }
      }
      return undefined
    },
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  return { ctx, captured }
}

async function* chunksOf(...items) {
  for (const it of items) yield it
}

let passed = 0
let failed = 0
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}${extra ? `（${extra}）` : ''}`) }
  else { failed++; console.log(`  ❌ ${name}${extra ? `（${extra}）` : ''}`) }
}

// ---- 单实例：一次 apply（测试端口），全部断言共用同一插件实例 ----
const { ctx, captured } = makeMockCtx()
let applyThrew = null
try {
  apply(ctx, { port: 51997, host: '127.0.0.1' })
} catch (e) {
  applyThrew = e
}

console.log('=== T1: apply() 正常加载（Bug A 正向回归）===')
ok('apply 未抛错（变量名已改 snake_case，加载不再崩）', applyThrew === null, applyThrew ? String(applyThrew) : '')
ok('注册的变量名是 bridge_intent', captured.variable?.name === 'bridge_intent', captured.variable?.name)
ok('变量名符合 cordis 规则', captured.variable ? CORDIS_VAR_NAME_RULE.test(captured.variable.name) : false)

console.log('=== T2: 旧驼峰名确实违反规则（Bug A 负向留档）===')
ok('"MCP 客户端Intent" 不匹配规则（当初崩溃的原因）', !CORDIS_VAR_NAME_RULE.test('MCP 客户端Intent'))
ok('"bridge_intent" 匹配规则', CORDIS_VAR_NAME_RULE.test('bridge_intent'))

console.log('=== T3: 意图 provider 不崩、无意图时返回 undefined ===')
let value = 'UNSET'
let providerThrew = null
try { value = captured.variable.provider() } catch (e) { providerThrew = e }
ok('provider 可调用且未抛错', providerThrew === null, providerThrew ? String(providerThrew) : '')
ok('无意图时返回 undefined', value === undefined)

console.log('=== T4: llm/stream 监听器返回可直接迭代的 async iterable（Bug B 正向回归）===')
const listener = captured.listeners['llm/stream']
ok('llm/stream 监听器已注册', typeof listener === 'function')
if (typeof listener !== 'function') process.exit(1)
const result = listener({}, () => Promise.resolve(chunksOf({ text: 'he' }, { text: 'llo' })))
ok('返回值不是 Promise（旧 bug 形态）', !(result instanceof Promise))
ok('返回值是 async iterable', result !== null && typeof result[Symbol.asyncIterator] === 'function')
const out = []
for await (const c of result) out.push(c)
ok('for await 正常消费且 chunk 原样透传', out.length === 2 && out[0]?.text === 'he' && out[1]?.text === 'llo', `透传=${out.map((c) => c.text).join('')}`)

console.log('=== T5: 旧 async 包装形态确实失败（Bug B 负向留档）===')
const oldBuggy = async (_o, next) => {
  const inner = await next()
  return (async function* () { yield* inner })() // ← 旧代码：async 函数返回 Promise<AsyncGenerator>
}
const buggyResult = oldBuggy({}, () => Promise.resolve(chunksOf({ text: 'x' })))
ok('旧形态返回的是 Promise（问题所在）', buggyResult instanceof Promise)
let iterFailed = false
try {
  for await (const _ of buggyResult) { /* 预期抛错 */ }
} catch {
  iterFailed = true
}
ok('旧形态 for await 必然失败（yield* not async iterable）', iterFailed)

console.log('\n========================================')
console.log(`回归测试：${passed} 通过 · ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
