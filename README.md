# dsh-mcp-bridge

**Exposes DSH as an MCP server**, so any MCP client can watch what the agent is doing and steer it mid-flight.

Two agents on one workspace normally means two agents overwriting each other. This bridge gives them a shared protocol instead: what the other side is thinking, what it's touching, who owns the floor, and a way to interrupt.

## What the other client gets

| Capability | Mechanism |
|---|---|
| **See the agent think** | LLM stream deltas → `notifications/dsh/thinking` (200 ms throttle) |
| **See what it touches** | tool calls → `notifications/dsh/tool`; `write`/`edit` targets → `notifications/dsh/file` |
| **Share intent** | `dsh_set_intent` / `dsh_get_intent`, auto-injected into DSH's system prompt every turn |
| **One writer at a time** | `dsh_lock_acquire` / `dsh_lock_release` floor lock — while held, DSH's `write`/`edit`/`git` are **physically denied** |
| **Interrupt the current turn** | `dsh_inject_alert` → injected through `agent/pre-step` into the running step |
| **Delegate a review** | `dsh_review_request` → inbox on disk (`inbox/<id>.json`), result written back to `inbox/done/` |

## The 8 MCP tools

`dsh_get_status` · `dsh_get_intent` · `dsh_set_intent` · `dsh_lock_acquire` · `dsh_lock_release` · `dsh_lock_status` · `dsh_inject_alert` · `dsh_review_request`

## Notifications (server → client, SSE)

`notifications/dsh/status` · `thinking` · `tool` · `file` · `intent` · `lock` · `alert-queued` · `review`

## Install

```sh
dsh plugin --profile web add dsh-mcp-bridge
```

Then **add the bridge to your MCP client** — any client speaking Streamable HTTP works (WorkBuddy, Claude Desktop with an MCP-HTTP adapter, Cursor, Cline, …):

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

Restart DSH. The log should show `[dsh-mcp-bridge] MCP server 就绪: http://127.0.0.1:51630/mcp`.

## Self-test without installing

```sh
# terminal A — start a demo server on 51999
node dsh/mcp.js 51999

# terminal B — handshake, all 8 tools, floor lock, SSE stream
node dsh/mcp-test.js http://127.0.0.1:51999/mcp
```

Expected: 13 checks pass, ending with `全部通过 ✅`.

There is also a unit-level regression suite that runs with no server:

```sh
node dsh/bridge-regression.test.mjs   # 13 pass / 0 fail
```

## Configuration

`~/.dsh-mcp-bridge/config.json` (all optional):

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

`inboxRoot` defaults to `~/.dsh-mcp-bridge/inbox`.

## Honest boundaries

- **Loopback only by default.** Binds `127.0.0.1`; a `token` is supported but empty by default. Do not expose the port.
- **The lock is enforced on the DSH side only.** While held, DSH's `write`/`edit`/`git` are denied at `tools/pre-execute`. The remote client is trusted to honour the lock by convention — this is a coordination primitive, not a security boundary between mutually hostile parties.
- **Alert injection is best-effort.** It goes through `agent/pre-step`. If the current step cannot be injected, the alert stays queued and lands on the next step.
- **One Server + transport per client.** That is an MCP SDK constraint; multiple clients (a recorder and an agent, say) each get their own. A reconnecting client must use a new `sessionId`.
- **The thinking stream forwards text deltas only**, and tool arguments are truncated to their first 120 characters — this is a visibility channel, not a full transcript tap.

## License

MIT
