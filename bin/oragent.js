#!/usr/bin/env node
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { query } from "../src/core/query.js";
import { loadDotEnv } from "../src/utils/env.js";
import { OpenRouterClient } from "../src/providers/openrouter.js";
import { listSessions } from "../src/sessions/index.js";
import { startServer } from "../src/server/index.js";
import { toolDefinitions, TOOL_META } from "../src/tools/index.js";

// Flags that may be passed multiple times accumulate into an array.
const REPEATABLE = new Set(["image", "doc", "file", "pdf", "audio", "video"]);

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv(process.cwd());
loadDotEnv(packageRoot);

const { command, options, rest } = parseArgs(process.argv.slice(2));

try {
  if (options.help || command === "help") printHelp();
  else if (command === "tools") printTools();
  else if (command === "models") await printModels(options);
  else if (command === "sessions") await printSessions(options);
  else if (command === "serve") await serve(options);
  else if (command === "chat") await chat(options);
  else await run(rest.join(" "), options);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}

async function run(prompt, options) {
  if (!prompt && !hasAttachments(options)) return printHelp();
  const sessionId = await drive(prompt || "Describe and use the attached context.", buildOptions(options));
  console.log(`\nSession: ${sessionId}`);
}

async function chat(options) {
  const rl = readline.createInterface({ input, output });
  let sessionId = options.session;
  console.log("OpenRouter Code Agent chat (query loop). Type /exit to quit.");
  while (true) {
    const prompt = (await rl.question("> ")).trim();
    if (!prompt) continue;
    if (prompt === "/exit" || prompt === "/quit") break;
    sessionId = await drive(prompt, buildOptions({ ...options, session: sessionId }, rl));
    console.log(`\nSession: ${sessionId}`);
  }
  rl.close();
}

// Drive query() and render the SDK message stream. Returns the session id.
async function drive(prompt, sdkOptions) {
  const toolNames = new Map(); // tool_use_id -> name, for tool_result labels
  const streaming = Boolean(sdkOptions.includePartialMessages);
  let sessionId;

  for await (const message of query({ prompt, options: sdkOptions })) {
    if (message.type === "system" && message.subtype === "init") {
      sessionId = message.session_id;
      console.error(
        `[init] model=${message.model} mode=${message.permissionMode} tools=${message.tools.length} cwd=${message.cwd}`,
      );
    } else if (message.type === "partial_assistant") {
      if (message.partial.type === "text") process.stdout.write(message.partial.text);
    } else if (message.type === "assistant") {
      for (const block of message.message.content || []) {
        if (block.type === "thinking" && block.thinking) {
          console.error(`\n[thinking] ${truncate(block.thinking, 500)}`);
        } else if (block.type === "text" && block.text && !streaming) {
          console.log(`\n${block.text}`);
        } else if (block.type === "tool_use") {
          toolNames.set(block.id, block.name);
          console.error(`[tool] ${block.name} ${truncate(JSON.stringify(block.input), 300)}`);
        }
      }
    } else if (message.type === "user") {
      for (const block of message.message.content || []) {
        if (block.type === "tool_result") {
          const name = toolNames.get(block.tool_use_id) || "tool";
          console.error(`[tool] ${name} ${block.is_error ? "failed" : "ok"}`);
        }
      }
    } else if (message.type === "result") {
      sessionId = message.session_id;
      if (message.subtype === "success") {
        if (streaming) process.stdout.write("\n");
        else console.log(`\n${message.result}`);
      } else {
        console.error(`\n[${message.subtype}] ${(message.errors || []).join("; ")}`);
      }
      const u = message.usage || {};
      console.error(
        `[result] turns=${message.num_turns} in=${u.input_tokens || 0} out=${u.output_tokens || 0}` +
          (message.total_cost_usd ? ` cost=$${message.total_cost_usd.toFixed(4)}` : "") +
          (message.permission_denials.length ? ` denials=${message.permission_denials.length}` : ""),
      );
    }
  }
  return sessionId;
}

async function serve(options) {
  const port = Number(options.port || process.env.PORT || 3333);
  const host = options.host || process.env.HOST || "127.0.0.1";
  const { url } = await startServer({ ...buildOptions(options), port, host });
  console.log(`OpenRouter Code Agent API listening on ${url}`);
}

async function printModels(options) {
  const client = new OpenRouterClient(buildOptions(options));
  const models = await client.listModels();
  for (const model of models.slice(0, Number(options.limit || 100))) {
    const context = model.context_length ? ` context=${model.context_length}` : "";
    console.log(`${model.id}${context}`);
  }
}

async function printSessions(options) {
  const sessions = await listSessions(options.cwd || process.cwd());
  for (const session of sessions) {
    console.log(`${session.sessionId}\t${session.updatedAt || ""}\t${session.model || ""}`);
  }
}

function printTools() {
  console.log("Built-in tools (SDK names):");
  for (const tool of toolDefinitions) {
    const meta = TOOL_META[tool.function.name];
    const tag = meta ? `[${meta.permission}]` : "[extra]";
    console.log(`  ${tool.function.name}\t${tag}\t${tool.function.description}`);
  }
  console.log("\nOpenRouter server tools (enabled by default):");
  console.log("  openrouter:web_search\tServer-side web search.");
  console.log("  openrouter:web_fetch\tServer-side URL fetch.");
}

// Map CLI flags -> SDK Options (query()). Old flag names are kept as aliases.
function buildOptions(options, rl) {
  const permissionMode = mapPermissionMode(
    options.permissionMode || options["permission-mode"] || "default",
  );
  if (permissionMode === "bypassPermissions" && !options.allowDangerouslySkipPermissions) {
    throw new Error("permissionMode=bypassPermissions requires --allow-dangerously-skip-permissions");
  }

  return {
    apiKey: options.apiKey || options["api-key"] || process.env.OPENROUTER_API_KEY,
    model: options.model || process.env.OPENROUTER_MODEL,
    fallbackModel: options.fallbackModel || options["fallback-model"] || process.env.OPENROUTER_FALLBACK_MODEL,
    baseUrl: options.baseUrl || options["base-url"] || process.env.OPENROUTER_BASE_URL,
    timeoutMs: numberOption(options.timeoutMs || process.env.OPENROUTER_TIMEOUT_MS),
    cwd: options.cwd || process.cwd(),
    additionalDirectories: splitList(options.addDir || options["add-dir"]),
    maxTurns: Number(options.maxTurns || options["max-turns"] || 100),
    temperature: Number(options.temperature ?? 0.2),
    maxTokens:
      options.maxTokens || options["max-tokens"]
        ? Number(options.maxTokens || options["max-tokens"])
        : undefined,
    // reasoning controls -> mapped to OpenRouter `reasoning` by options.js
    effort: options.effort || options.reasoningEffort || process.env.OPENROUTER_REASONING_EFFORT,
    maxThinkingTokens: numberOption(
      options.maxThinkingTokens || options.reasoningMaxTokens || process.env.OPENROUTER_REASONING_MAX_TOKENS,
    ),
    includeReasoning: boolFlag(options.includeReasoning, process.env.OPENROUTER_INCLUDE_REASONING),
    excludeReasoning: boolFlag(options.excludeReasoning, process.env.OPENROUTER_EXCLUDE_REASONING),
    verbosity: options.verbosity || process.env.OPENROUTER_VERBOSITY,
    includePartialMessages: Boolean(options.stream),
    allowedTools: splitList(options.allowedTools || options["allowed-tools"]),
    disallowedTools: splitList(options.disallowedTools || options["disallowed-tools"]),
    openRouterWebSearch: enabledByDefault(
      options.webSearch,
      options.noWebSearch,
      process.env.OPENROUTER_WEB_SEARCH,
      process.env.OPENROUTER_DISABLE_WEB_SEARCH,
    ),
    openRouterWebFetch: enabledByDefault(
      options.webFetch,
      options.noWebFetch,
      process.env.OPENROUTER_WEB_FETCH,
      process.env.OPENROUTER_DISABLE_WEB_FETCH,
    ),
    webSearchEngine: options.webSearchEngine || process.env.OPENROUTER_WEB_SEARCH_ENGINE,
    webSearchMaxResults: numberOption(options.webSearchMaxResults || process.env.OPENROUTER_WEB_SEARCH_MAX_RESULTS),
    webFetchEngine: options.webFetchEngine || process.env.OPENROUTER_WEB_FETCH_ENGINE,
    webFetchMaxContentTokens: numberOption(
      options.webFetchMaxContentTokens || process.env.OPENROUTER_WEB_FETCH_MAX_CONTENT_TOKENS,
    ),
    permissionMode,
    allowDangerouslySkipPermissions: Boolean(options.allowDangerouslySkipPermissions),
    allowOutsideCwd: Boolean(options.allowOutsideCwd),
    // Context management + harness context sections.
    maxContextTokens: numberOption(options.maxContextTokens || process.env.OPENROUTER_MAX_CONTEXT_TOKENS),
    autoCompact: options.noAutoCompact ? false : undefined,
    loadProjectContext: options.noProjectContext ? false : undefined,
    memory: options.noMemory ? false : undefined,
    resume: options.session,
    canUseTool: createCanUseTool(rl),
    // External context attachments: images, PDFs, docs, audio, video.
    attachments: buildAttachments(options),
    pdfEngine: options.pdfEngine || options["pdf-engine"],
    // Two-stage perception (omni model -> planner). --no-perception attaches
    // raw media directly to the main model instead.
    perception: options.noPerception ? false : undefined,
    perceptionModel: options.visionModel || options["vision-model"],
    onEvent: logEngineEvent,
  };
}

function logEngineEvent(event) {
  if (event.type === "perception_start") {
    console.error(`[perception] ${event.model} reading ${event.attachments} attachment(s)…`);
  } else if (event.type === "perception_end") {
    console.error(`[perception] extracted ${event.chars} chars of context`);
  } else if (event.type === "perception_error") {
    console.error(`[perception] failed: ${event.error}`);
  } else if (event.type === "retry") {
    console.error(`[retry ${event.attempt}] ${event.reason} — retrying on ${event.model}`);
  } else if (event.type === "compaction_start") {
    console.error(`[compact] context ~${event.estimatedTokens} tokens — summarizing older turns…`);
  } else if (event.type === "compaction_end") {
    console.error(`[compact] done — context now ~${event.estimatedTokens} tokens`);
  } else if (event.type === "compaction_error") {
    console.error(`[compact] failed (${event.error}) — trimmed old tool output instead`);
  } else if (event.subagent && event.type === "tool_start") {
    console.error(`  [subagent tool] ${event.name}`);
  }
}

function buildAttachments(options) {
  const asArray = (value) => (Array.isArray(value) ? value : value && value !== true ? [value] : []);
  return [
    ...asArray(options.image).map((ref) => ({ kind: "image", ref })),
    ...asArray(options.pdf).map((ref) => ({ kind: "pdf", ref })),
    ...asArray(options.audio).map((ref) => ({ kind: "audio", ref })),
    ...asArray(options.video).map((ref) => ({ kind: "video", ref })),
    ...asArray(options.doc).map((ref) => ({ kind: "doc", ref })),
    ...asArray(options.file).map((ref) => ({ kind: "doc", ref })),
  ];
}

function hasAttachments(options) {
  return Boolean(
    options.image || options.doc || options.file || options.pdf || options.audio || options.video,
  );
}

function mapPermissionMode(mode) {
  const aliases = {
    bypass: "bypassPermissions",
    "accept-edits": "acceptEdits",
    "read-only": "plan",
  };
  return aliases[mode] || mode;
}

// Default canUseTool: prompt on a TTY, deny otherwise (matches a headless run).
// Answering "a" (always) remembers the grant for the rest of the run — for
// Bash the grant is scoped to the command's first word (e.g. all `npm …`).
function createCanUseTool(existingRl) {
  const grants = new Set();
  return async (toolName, toolInput) => {
    const grantKey =
      toolName === "Bash"
        ? `Bash:${String(toolInput.command || "").trim().split(/\s+/)[0]}`
        : toolName;
    if (grants.has(grantKey)) return { behavior: "allow" };
    if (!process.stdin.isTTY) {
      return { behavior: "deny", message: `${toolName} denied (no TTY to confirm)` };
    }
    const rl = existingRl || readline.createInterface({ input, output });
    const summary = truncate(JSON.stringify(toolInput), 200);
    const answer = (
      await rl.question(`[permission] ${toolName} ${summary}\nAllow? (y = yes / a = always / N = no) `)
    )
      .trim()
      .toLowerCase();
    if (!existingRl) rl.close();
    if (answer === "a") {
      grants.add(grantKey);
      return { behavior: "allow" };
    }
    return answer === "y"
      ? { behavior: "allow" }
      : { behavior: "deny", message: `${toolName} denied by user` };
  };
}

function boolFlag(value, fallback) {
  const actual = value ?? fallback;
  if (actual === undefined) return false;
  if (typeof actual === "boolean") return actual;
  return ["1", "true", "yes", "on"].includes(String(actual).toLowerCase());
}

function enabledByDefault(enable, disable, envEnable, envDisable) {
  if (disable === true) return false;
  if (enable === true) return true;
  if (envDisable !== undefined && boolFlag(envDisable)) return false;
  if (envEnable !== undefined) return boolFlag(envEnable);
  return true;
}

function splitList(value) {
  if (!value || value === true) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function numberOption(value) {
  if (value === undefined || value === true || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function truncate(text, max) {
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function parseArgs(argv) {
  const commands = new Set(["help", "tools", "models", "sessions", "serve", "chat"]);
  let command = "run";
  const rest = [];
  const options = {};
  let index = 0;

  if (argv[0] && commands.has(argv[0])) {
    command = argv[0];
    index = 1;
  }

  const assign = (key, value) => {
    if (REPEATABLE.has(key)) (options[key] ||= []).push(value);
    else options[key] = value;
  };

  while (index < argv.length) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
      const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      const next = argv[index + 1];
      if (inlineValue !== undefined) assign(key, inlineValue);
      else if (!next || next.startsWith("--")) options[key] = true;
      else {
        assign(key, next);
        index += 1;
      }
    } else {
      rest.push(arg);
    }
    index += 1;
  }

  return { command, options, rest };
}

function printHelp() {
  console.log(`OpenRouter Code Agent — Claude Agent SDK-shaped query() over OpenRouter

Usage:
  oragent "fix the bug in src/app.js"
  oragent chat
  oragent serve --port 3333
  oragent models --limit 20
  oragent tools
  oragent sessions

Options (mapped to SDK query() Options):
  --model <id>                       OpenRouter model slug (planner)
  --fallback-model <id>              Model to retry on when a turn returns empty
  --api-key <key>                    OpenRouter API key
  --cwd <path>                       Workspace directory
  --add-dir <a,b>                    Extra readable/writable directories
  --session <id>                     Resume a local .oragent session
  --max-turns <n>                    Agent loop limit, default 100
  --permission-mode <mode>           default | acceptEdits | bypassPermissions | plan
                                     (aliases: accept-edits, bypass, read-only)
  --allow-dangerously-skip-permissions  Required with bypassPermissions
  --allowed-tools <a,b>              Restrict to these tool names
  --disallowed-tools <a,b>           Remove these tool names
  --temperature <n>                  Default 0.2
  --max-tokens <n>                   Optional model output cap
  --timeout-ms <n>                   Per-request timeout, default 600000
  --effort <level>                   xhigh | high | medium | low | minimal | none
  --max-thinking-tokens <n>          reasoning.max_tokens
  --include-reasoning                Request reasoning details when supported
  --stream                           Stream partial_assistant deltas live
  --image <path|url>                 Attach an image/screenshot (repeatable)
  --doc <path|url>                   Attach a research doc; text inlined, .pdf parsed (repeatable)
  --pdf <path|url>                   Attach a PDF explicitly (repeatable)
  --audio <path>                     Attach a local audio file (repeatable)
  --video <path|url>                 Attach a video (repeatable)
  --pdf-engine <engine>              native | cloudflare-ai | mistral-ocr
  --vision-model <slug>              Perception/omni model (default nvidia/nemotron-3-nano-omni…)
  --no-perception                    Skip perception; attach raw media to the main model
  --verbosity <level>                low | medium | high | xhigh | max
  --no-web-search                    Disable OpenRouter server web search
  --no-web-fetch                     Disable OpenRouter server web fetch
  --max-context-tokens <n>           Estimated context budget before auto-compaction (default 100000)
  --no-auto-compact                  Disable context auto-compaction
  --no-project-context               Skip loading ORAGENT.md / AGENTS.md / CLAUDE.md
  --no-memory                        Skip loading the persistent memory index

Environment:
  OPENROUTER_API_KEY, OPENROUTER_MODEL, OPENROUTER_BASE_URL, OPENROUTER_TIMEOUT_MS
  OPENROUTER_REASONING_EFFORT, OPENROUTER_REASONING_MAX_TOKENS
  OPENROUTER_WEB_SEARCH, OPENROUTER_WEB_FETCH
`);
}
