# OpenRouter Code Agent

Một clone theo **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — cùng contract
`query({ prompt, options })` trả về **async generator của `SDKMessage`** — nhưng engine là
**OpenRouter Chat Completions** thay vì binary Claude Code proprietary.

Điểm đã kiểm chứng từ source/docs public:

- SDK thật export `query({ prompt, options })` (async generator) và bundle native Claude Code binary; `model` được truyền cho binary, package **không** expose provider adapter.
- Built-in tools của SDK: `Bash, Read, Write, Edit, Glob, Grep, TodoWrite, WebFetch, WebSearch, Task, NotebookEdit…`; permission modes `default | acceptEdits | bypassPermissions | plan`; hooks `PreToolUse/PostToolUse/…`; `canUseTool`.
- Repo này **không** copy binary/source proprietary. Nó clone **practical core** của public API surface (query loop, message taxonomy, Options, tool names, permission modes, hooks, reasoning) trên nền OpenRouter.

## Clone 1:1 (practical core)

| SDK | Ở đây |
|---|---|
| `query({prompt, options})` → `AsyncGenerator<SDKMessage>` | ✅ `src/query.js` |
| Messages: `system`(init) → `assistant` → `user`(tool_result) → `result`(success/error_*) + `partial_assistant` | ✅ `src/messages.js` |
| Tool names `Read/Write/Edit/Bash/Glob/Grep/TodoWrite/WebFetch/WebSearch` | ✅ `src/tools.js` |
| `permissionMode`, `canUseTool`, `PermissionResult` | ✅ `src/permissions.js` |
| `hooks` (PreToolUse/PostToolUse/UserPromptSubmit/Stop) | ✅ `src/hooks.js` |
| Reasoning: `maxThinkingTokens` / `effort` / `thinking` → OpenRouter `reasoning` | ✅ `src/options.js` |
| Sessions (`resume`, persist) | ✅ `src/session.js` |

**Out of scope** (nêu rõ để khỏi nhầm với SDK đầy đủ): Query control methods (`interrupt`/`setModel`/…), plugins, real MCP transport, full 30+ message taxonomy, `settingSources`. Có sẵn factory `tool()` / `createSdkMcpServer()` cho parity về shape nhưng chưa route execution.

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
import { query } from "openrouter-code-agent";

for await (const message of query({
  prompt: "list the files and summarize the structure",
  options: {
    model: "anthropic/claude-sonnet-4.5",
    permissionMode: "plan",          // default | acceptEdits | bypassPermissions | plan
    allowedTools: ["Read", "Glob", "Grep"],
    effort: "high",                  // -> OpenRouter reasoning.effort
    includePartialMessages: true,    // stream partial_assistant deltas
    canUseTool: async (name, input) => ({ behavior: "allow" }),
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [async (input) => ({ /* block/allow/modify */ }) ] }],
    },
  },
})) {
  if (message.type === "assistant") { /* message.message.content blocks */ }
  if (message.type === "result") console.log(message.result);
}
```

`prompt` nhận `string` hoặc `AsyncIterable<SDKUserMessage>`. Mỗi `query()` yield lần lượt:
`{type:"system",subtype:"init"}` → `{type:"assistant"}` → `{type:"user"}` (tool_result) →
`{type:"result"}` (`success` | `error_max_turns` | `error_during_execution`).

## CLI (deployment đầu tiên)

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

Link global:

```sh
npm link
oragent "review code trong src" --permission-mode plan
```

Permission modes (SDK names; alias cũ vẫn nhận):

- `default`: read chạy thẳng; edit/bash hỏi qua `canUseTool` (TTY); ngoài TTY thì deny.
- `plan` (alias `read-only`): chỉ tool read-only (Read/Glob/Grep/Web*); deny mọi edit/bash.
- `acceptEdits` (alias `accept-edits`): tự cho phép Write/Edit; Bash vẫn hỏi.
- `bypassPermissions` (alias `bypass`): cho phép tất cả; bắt buộc `--allow-dangerously-skip-permissions`.

## Express API

```sh
npm run serve -- --port 3333

curl -s http://127.0.0.1:3333/health
curl -s http://127.0.0.1:3333/v1/tools
curl -s -X POST http://127.0.0.1:3333/v1/query \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"List files","permissionMode":"plan"}'
```

`/v1/query` chạy `query()` và trả `{ result, sessionId, messages }` (mảng SDKMessage). Server
mặc định `plan` (read-only) vì không có TTY để xác nhận permission.

## Built-in tools (SDK names)

`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `TodoWrite`, `WebFetch`, `WebSearch`
(+ extras không thuộc SDK: `list_files`, `print_tree`, `TodoRead`).

- `Glob`/`Grep`/`list_files` tôn trọng `.gitignore` ở root và thư mục con; chỉ `.git/` luôn bị bỏ qua.
- `WebSearch` local dùng `TAVILY_API_KEY` nếu có, nếu không fallback DuckDuckGo HTML best-effort.
- Ngoài ra OpenRouter server tools `openrouter:web_search` / `openrouter:web_fetch` bật mặc định; tắt bằng `--no-web-search --no-web-fetch`.

## Context ngoài text — pipeline 2 model (perception → planner)

Input chỉ-text làm context nghèo → đôi khi agent sửa nhầm. Thêm context bên ngoài
(ảnh, tài liệu, audio, video) qua **2 bước**:

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

Model perception nhận đa phương thức (image/audio/video/text) và **trả về text**, nên
planner **không cần** là model vision — nó chỉ reasoning trên text đã trích xuất. Cả hai
stage dùng chung client nên **xoay tua key** vẫn áp dụng.

```sh
oragent "lỗi UI trong ảnh này là gì? đề xuất fix" --image ./bug.png
oragent "đối chiếu code với spec" --doc ./spec.md --doc ./api-notes.txt
oragent "tóm tắt & trích dẫn paper" --pdf https://arxiv.org/pdf/1706.03762 --pdf-engine cloudflare-ai
oragent "ghi chú voice này muốn gì?" --audio ./note.mp3
oragent "bug lặp lại trong clip này" --video ./repro.mp4
oragent "review theo screenshot + tài liệu" --image ./design.png --doc ./requirements.md --permission-mode plan
```

- `--image <path|url>` → ảnh (PNG/JPEG/WebP/GIF).
- `--doc <path|url>` → `.pdf` parse bằng plugin `file-parser`; doc text (`.md/.txt/.json/...`) **inline** kèm nhãn; local quá lớn bị cắt (200k chars).
- `--pdf <path|url>` → ép PDF; `--pdf-engine native|cloudflare-ai|mistral-ocr`.
- `--audio <path>` → audio **local** (base64; OpenRouter không nhận URL audio). wav/mp3/flac/m4a/ogg/aac.
- `--video <path|url>` → video (mp4/webm/mov…); URL tuỳ provider.
- `--vision-model <slug>` (hoặc `OPENROUTER_VISION_MODEL`) → đổi model perception.
- `--no-perception` → **bỏ** stage 1, đính raw media thẳng vào main model (cần main model multimodal).
- Flags lặp lại được; chạy chỉ-attachment không cần prompt text.

Library API:

```js
await query({ prompt: "what's wrong here?", options: {
  model: "nvidia/nemotron-3-super-120b-a12b:free",        // planner (text)
  perceptionModel: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", // omni
  // perception: false,                                    // -> attach raw media to model
  attachments: [
    { kind: "image", ref: "./bug.png" },
    { kind: "audio", ref: "./note.mp3" },
    { kind: "doc",   ref: "./spec.md" },
    { kind: "pdf",   ref: "https://arxiv.org/pdf/1706.03762" },
  ],
  pdfEngine: "cloudflare-ai",
}});
```

Engine dịch sang shape OpenAI-compatible mà OpenRouter nhận: `image_url`, `file` (+plugin
`file-parser`), `input_audio`, `video_url`.

## Reasoning

`--effort` (hoặc `--reasoning-effort`) và `--max-thinking-tokens` map sang OpenRouter
`reasoning.effort` / `reasoning.max_tokens`. `thinking:{type:"disabled"}` → `reasoning.exclude`.

```sh
oragent "phân tích lỗi concurrency này" --effort high --max-tokens 12000
```

`.env`:

```sh
OPENROUTER_REASONING_EFFORT=medium
OPENROUTER_REASONING_MAX_TOKENS=4096
```

Lưu ý: reasoning chỉ có tác dụng nếu model/provider trên OpenRouter hỗ trợ; không phải model
nào cũng tool-call tốt — chọn model hỗ trợ function/tool calling cho coding agent.

## Troubleshooting

```sh
oragent "task chậm" --timeout-ms 900000        # model free/chậm
oragent "task offline" --no-web-search --no-web-fetch
```
