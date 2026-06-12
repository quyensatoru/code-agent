# OpenRouter Code Agent

Một **agent harness** theo hình mẫu **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — cùng contract
`query({ prompt, options })` trả về **async generator của `SDKMessage`** — nhưng engine là
**OpenRouter Chat Completions** thay vì binary Claude Code proprietary.

Repo này **không** copy binary/source proprietary. Nó clone **practical core** của public API surface
(query loop, message taxonomy, Options, tool names, permission modes, hooks, reasoning) và bổ sung
các thành phần harness thực thụ: **memory, context compaction, permission rules, subagent, custom tools**.

## Cấu trúc repo (harness pattern)

```
bin/oragent.js          CLI (run / chat / serve / models / tools / sessions)
scripts/check.js        Syntax check toàn bộ source (cross-platform)
tests/                  Unit tests (node --test)
src/
  index.js              Public surface (query, tool, createSdkMcpServer, …)
  legacy.js             runAgent() back-compat shim
  core/                 Vòng lặp agent
    query.js              query(): turn loop, gating, compaction, persist
    options.js            Normalize SDK Options + SYSTEM_PROMPT
    system-prompt.js      Lắp system prompt: env info + project doc + memory
    messages.js           SDK message taxonomy builders/translators
  providers/
    openrouter.js         OpenRouter client: key rotation, SSE streaming, retry
  tools/                 Tool registry + implementations
    index.js              Registry, runtime dispatch, validation, MCP routing
    meta.js               TOOL_META (permission class per tool)
    validate.js           JSON-schema validation + coercion cho tool args
    search.js             Glob/Grep/list_files/print_tree (.gitignore-aware)
    fs.js                 Read/Write/Edit
    shell.js              Bash
    web.js                WebFetch/WebSearch (Tavily/DuckDuckGo)
    todo.js               TodoWrite/TodoRead
    agent.js              Agent — subagent (Task) tool
    shared.js             Truncation + helpers chung
  permissions/
    index.js              evaluate(): deny/allow rules + mode + canUseTool
    rules.js              `Tool(spec)` rules, safe read-only Bash detection
  hooks/index.js         PreToolUse/PostToolUse/UserPromptSubmit/Stop/Session*
  context/
    attachments.js        Image/PDF/doc/audio/video -> content parts
    perception.js         Stage-1 omni model (media -> text)
    compaction.js         Token estimate, trim tool output cũ, auto-compact
  memory/index.js        Persistent memory (.oragent/memory/MEMORY.md)
  sessions/index.js      Session persist/resume (.oragent/sessions)
  server/index.js        Express API
  utils/env.js           .env loader
```

## Các thành phần harness

| Thành phần | Cơ chế |
|---|---|
| **Agent loop** | `query()` → system init → assistant → tool_result → … → result |
| **Tool calling** | Schema validation + coercion trước khi chạy; lỗi trả về dạng model tự sửa được; Edit bắt buộc search text unique (hoặc `replace_all`) |
| **Permissions** | 4 mode (`default/plan/acceptEdits/bypassPermissions`) + rules `Tool(spec)`: `allowedTools:["Bash(npm *)"]` auto-allow, `disallowedTools:["Bash(rm *)"]` luôn deny; Bash read-only (git status/log/diff, ls, cat…) không cần hỏi |
| **Hooks** | `PreToolUse` (block/rewrite input), `PostToolUse` (nhận `tool_response`), `UserPromptSubmit`, `Stop` (block = bắt agent làm tiếp), `SessionStart/End` |
| **Memory** | `.oragent/memory/MEMORY.md` index nạp vào system prompt mỗi session; agent tự Write/Edit memory files |
| **Project context** | Tự nạp `ORAGENT.md` / `AGENTS.md` / `CLAUDE.md` + env info (cwd, OS, date, git branch/dirty) vào system prompt |
| **Context compaction** | Ước lượng token (~4 chars/token); >60% budget → trim tool output cũ; >80% → model tự tóm tắt history thành 1 system message, emit `system/compact_boundary` |
| **Subagent** | Tool `Agent`: chạy `query()` lồng, plan-mode (read-only), context riêng, trả về câu trả lời cuối — giữ context cha sạch |
| **Custom tools** | `tool()` + `createSdkMcpServer()` + `options.mcpServers` → execution được route thật, tên `mcp__<server>__<tool>` |
| **Sessions** | Persist + `resume` qua `.oragent/sessions/<id>.json` |
| **Multimodal** | Perception 2-stage: omni model đọc media → text cho planner |

**Out of scope** (so với SDK đầy đủ): Query control methods (`interrupt`/`setModel`/…), plugins,
external MCP transport (stdio/SSE), full 30+ message taxonomy, `settingSources`, slash commands.

## Cài đặt

```sh
npm install
cp .env.example .env
```

Sửa `.env`:

```sh
OPENROUTER_API_KEY=sk-or-v1-your-key
OPENROUTER_MODEL=anthropic/claude-sonnet-4.5
OPENROUTER_TIMEOUT_MS=600000
```

## Library API — `query()`

```js
import { query, tool, createSdkMcpServer } from "openrouter-code-agent";

for await (const message of query({
  prompt: "list the files and summarize the structure",
  options: {
    model: "anthropic/claude-sonnet-4.5",
    permissionMode: "plan",          // default | acceptEdits | bypassPermissions | plan
    allowedTools: ["Read", "Glob", "Grep", "Bash(npm test*)"], // Tool(spec) = auto-allow rule
    disallowedTools: ["Bash(rm *)"],                            // luôn deny
    effort: "high",                  // -> OpenRouter reasoning.effort
    includePartialMessages: true,    // stream partial_assistant deltas
    maxContextTokens: 100000,        // auto-compact ở ~80%
    canUseTool: async (name, input) => ({ behavior: "allow" }),
    hooks: {
      PostToolUse: [{ matcher: "Write|Edit", hooks: [async (p) => {
        // p = { hook_event_name, tool_name, tool_input, tool_response }
        return {};
      }] }],
      Stop: [{ hooks: [async () => ({ decision: "block", reason: "run tests first" })] }],
    },
    mcpServers: {
      calc: createSdkMcpServer({
        name: "calc",
        tools: [tool("add", "Add numbers", {
          type: "object", required: ["a","b"],
          properties: { a: { type: "number" }, b: { type: "number" } },
        }, async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }))],
      }),
    },
  },
})) {
  if (message.type === "assistant") { /* message.message.content blocks */ }
  if (message.type === "system" && message.subtype === "compact_boundary") { /* context đã được nén */ }
  if (message.type === "result") console.log(message.result);
}
```

`prompt` nhận `string` hoặc `AsyncIterable<SDKUserMessage>`. Mỗi `query()` yield lần lượt:
`{type:"system",subtype:"init"}` → `{type:"assistant"}` → `{type:"user"}` (tool_result) →
(`{type:"system",subtype:"compact_boundary"}` khi nén context) → `{type:"result"}`
(`success` | `error_max_turns` | `error_during_execution`).

## CLI

```sh
npm start -- "liệt kê file trong project và giải thích cấu trúc" --permission-mode plan
npm start -- "tạo file hello.js in ra hello" --permission-mode acceptEdits
npm start -- "sửa bug concurrency" --effort high --max-tokens 12000
npm start -- "research docs mới nhất" --stream
npm start -- chat
npm start -- models --limit 20
npm start -- tools
npm start -- sessions
```

Link global: `npm link` rồi `oragent "review code trong src" --permission-mode plan`.

Permission modes (SDK names; alias cũ vẫn nhận):

- `default`: read + Bash read-only chạy thẳng; edit/bash khác hỏi qua `canUseTool` (TTY: trả lời `y`/`a` = always/`N`); ngoài TTY thì deny.
- `plan` (alias `read-only`): chỉ tool read-only (Read/Glob/Grep/Web*/Agent) + Bash read-only; deny mọi edit.
- `acceptEdits` (alias `accept-edits`): tự cho phép Write/Edit; Bash vẫn hỏi.
- `bypassPermissions` (alias `bypass`): cho phép tất cả; bắt buộc `--allow-dangerously-skip-permissions`. `disallowedTools` rules vẫn được tôn trọng.

Flags harness mới:

```
--max-context-tokens <n>   Budget context trước khi auto-compact (default 100000)
--no-auto-compact          Tắt auto-compaction
--no-project-context       Không nạp ORAGENT.md / AGENTS.md / CLAUDE.md
--no-memory                Không nạp memory index
```

## Memory & project context

- Đặt hướng dẫn dự án trong `ORAGENT.md` / `AGENTS.md` / `CLAUDE.md` ở root — tự nạp vào system prompt.
- Agent có memory bền vững tại `.oragent/memory/`: mỗi memory là một file markdown nhỏ, `MEMORY.md` là index được nạp mỗi session. Agent tự cập nhật bằng Write/Edit (cần permission edit như thường lệ).

## Express API

```sh
npm run serve -- --port 3333

curl -s http://127.0.0.1:3333/health
curl -s http://127.0.0.1:3333/v1/tools
curl -s http://127.0.0.1:3333/v1/sessions
curl -s -X POST http://127.0.0.1:3333/v1/query \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"List files","permissionMode":"plan"}'
```

`/v1/query` chạy `query()` và trả `{ result, sessionId, messages }`. Server mặc định `plan`
(read-only) vì không có TTY để xác nhận permission.

## Built-in tools (SDK names)

`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `TodoWrite`, `WebFetch`, `WebSearch`, `Agent`
(+ extras không thuộc SDK: `list_files`, `print_tree`, `TodoRead`).

- Mọi tool args được validate + coerce theo JSON schema trước khi chạy; sai schema trả về `INVALID INPUT …` để model tự sửa.
- `Glob`/`Grep`/`list_files` tôn trọng `.gitignore` ở root và thư mục con; chỉ `.git/` luôn bị bỏ qua. `Grep` hỗ trợ `case_sensitive` + `context` lines.
- `WebSearch` local dùng `TAVILY_API_KEY` nếu có, nếu không fallback DuckDuckGo HTML best-effort.
- OpenRouter server tools `openrouter:web_search` / `openrouter:web_fetch` bật mặc định; tắt bằng `--no-web-search --no-web-fetch`.

## Context ngoài text — pipeline 2 model (perception → planner)

```
Screenshot / Document / Audio / Video
        │
        ▼   Stage 1 — perception (omni)
nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free
   Extract context · OCR · Describe · Analyze  → text
        │
        ▼   Stage 2 — planner (reasoning, chỉ text)
   OPENROUTER_MODEL (vd nvidia/nemotron-3-super-120b-a12b:free)
```

```sh
oragent "lỗi UI trong ảnh này là gì? đề xuất fix" --image ./bug.png
oragent "đối chiếu code với spec" --doc ./spec.md --doc ./api-notes.txt
oragent "tóm tắt & trích dẫn paper" --pdf https://arxiv.org/pdf/1706.03762 --pdf-engine cloudflare-ai
oragent "ghi chú voice này muốn gì?" --audio ./note.mp3
oragent "bug lặp lại trong clip này" --video ./repro.mp4
```

- `--image/--doc/--pdf/--audio/--video <path|url>` (repeatable); `--pdf-engine native|cloudflare-ai|mistral-ocr`.
- `--vision-model <slug>` (hoặc `OPENROUTER_VISION_MODEL`) đổi model perception; `--no-perception` đính raw media thẳng vào main model.

Library API: `options.attachments = [{ kind: 'image'|'pdf'|'doc'|'audio'|'video', ref }]`, `options.perceptionModel`, `options.perception:false`.

## Reasoning

`--effort` và `--max-thinking-tokens` map sang OpenRouter `reasoning.effort` / `reasoning.max_tokens`.
`thinking:{type:"disabled"}` → `reasoning.exclude`.

```sh
oragent "phân tích lỗi concurrency này" --effort high --max-tokens 12000
```

## Dev

```sh
npm run check    # node --check toàn bộ source
npm test         # unit tests (permissions, validation, tools, hooks, compaction)
npm run smoke    # CLI help + tools
```

## Troubleshooting

```sh
oragent "task chậm" --timeout-ms 900000        # model free/chậm
oragent "task offline" --no-web-search --no-web-fetch
oragent "context quá dài bị lỗi" --max-context-tokens 30000   # ép compact sớm cho model context nhỏ
```
