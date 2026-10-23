# dsh-as-mcp-server

[English](README.md) | 中文

**把 DSH 变成一个 MCP server**，让任何 MCP 客户端都能看见 agent 正在做什么，并在过程中干预它。

两个 agent 共用一份工作区，通常的结局是互相覆盖。这个桥给它们一套共享协议：对方在想什么、正在动哪个文件、谁占着工作区，以及怎么打断。

## 连上来之后对方能拿到什么

| 能力 | 机制 |
|---|---|
| **看见 agent 在想什么** | LLM 流式增量 → `notifications/dsh/thinking`（200 ms 节流） |
| **看见它在动什么** | 工具调用 → `notifications/dsh/tool`；`write`/`edit` 目标 → `notifications/dsh/file` |
| **共享意图** | `dsh_set_intent` / `dsh_get_intent`，每轮自动注入 DSH 的 system prompt |
| **同一时间只许一个写** | `dsh_lock_acquire` / `dsh_lock_release` 地板锁——持锁期间 DSH 的 `write`/`edit`/`git` 被**物理拒绝** |
| **打断当前这一轮** | `dsh_inject_alert` → 经 `agent/pre-step` 插进正在执行的步骤 |
| **委托一次审查** | `dsh_review_request` → 落盘到收件箱（`inbox/<id>.json`），结果回写 `inbox/done/` |

## 8 个 MCP 工具

`dsh_get_status` · `dsh_get_intent` · `dsh_set_intent` · `dsh_lock_acquire` · `dsh_lock_release` · `dsh_lock_status` · `dsh_inject_alert` · `dsh_review_request`

## 通知事件（server → client，SSE）

`notifications/dsh/status` · `thinking` · `tool` · `file` · `intent` · `lock` · `alert-queued` · `review`

## 安装

```sh
dsh plugin --profile web add dsh-as-mcp-server
```

然后在**你的 MCP 客户端里**加上这个桥——任何支持 Streamable HTTP 的客户端都行（WorkBuddy、Claude Desktop 配 MCP-HTTP 适配器、Cursor、Cline……）：

```jsonc
{
  "mcpServers": {
    "dsh-bridge": {
      "type": "streamableHttp",
      "url": "http://127.0.0.1:51630/mcp",
      "timeout": 60000
    }
  }
}
```

重启 DSH。日志里应该出现：

```
[dsh-as-mcp-server] MCP server 就绪: http://127.0.0.1:51630/mcp
```

> 日志前缀是 `[dsh-mcp-bridge]`（内部标识，历史原因），和包名不一致，但确实是这一行。

## 不装也能先自测

```sh
# 终端 A —— 起一个演示服务（51999 端口）
node dsh/mcp.js 51999

# 终端 B —— 握手、8 个工具、地板锁、SSE 通知流
node dsh/mcp-test.js http://127.0.0.1:51999/mcp
```

预期：13 项检查全过，最后一行是 `全部通过 ✅`。

另有一套不需要起服务的单元回归：

```sh
node dsh/bridge-regression.test.mjs   # 13 通过 / 0 失败
```

## 配置

`~/.dsh-mcp-bridge/config.json`（全部可选）：

```json
{
  "port": 51630,
  "host": "127.0.0.1",
  "token": "",
  "lockTtlMs": 300000,
  "denyTools": ["write", "edit", "git"],
  "alertInjection": true,
  "inboxRoot": ""
}
```

`inboxRoot` 默认 `~/.dsh-mcp-bridge/inbox`。

## 诚实边界

- **默认只监听 loopback。** 绑 `127.0.0.1`；支持 `token` 但默认为空。**不要把这个端口暴露到公网。**
- **锁只在 DSH 一侧被强制执行。** 持锁期间，DSH 的 `write`/`edit`/`git` 在 `tools/pre-execute` 被拒绝。远端客户端是靠**约定**守锁的——这是一个协作原语，不是防恶意对手的安全边界。
- **提醒注入是尽力而为。** 走 `agent/pre-step`。如果当轮插不进去，提醒留在队列里，下一轮必达。
- **每个客户端一套 Server + transport。** 这是 MCP SDK 的限制；多个客户端（比如一个记录器加一个 agent）各拿各的。**重连必须换新 `sessionId`**（旧 id 会 400 死循环）。
- **思维流只转发文本增量**，工具参数截断到前 120 字符——这是可见性通道，不是完整对话录制。

## 许可

MIT
