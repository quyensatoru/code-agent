// Public library surface — mirrors @anthropic-ai/claude-agent-sdk (practical
// core) but backed by OpenRouter. The canonical entrypoint is `query()`.
export { query } from './core/query.js';
export { SYSTEM_PROMPT, normalizeOptions } from './core/options.js';
export { buildSystemPrompt, PROJECT_DOC_FILES } from './core/system-prompt.js';
export { toolDefinitions, TOOL_META, createToolRuntime } from './tools/index.js';
export { classifyTool, evaluate } from './permissions/index.js';
export { parseRules, isReadOnlyBash } from './permissions/rules.js';
export { HOOK_EVENTS, runHooks } from './hooks/index.js';
export { estimateTokens } from './context/compaction.js';
export { MEMORY_DIR, loadMemoryIndex } from './memory/index.js';
export { listSessions } from './sessions/index.js';
export { createServer, startServer } from './server/index.js';
export { runAgent } from './legacy.js';

export const VERSION = '0.2.0';

// Thrown when a query is aborted via options.abortController.
export class AbortError extends Error {
    constructor(message = 'Operation aborted') {
        super(message);
        this.name = 'AbortError';
    }
}

// Define an in-process tool. The handler receives parsed args and returns a
// CallToolResult-shaped object ({ content: [{type:'text',text}] }) or any
// JSON-able value. Register via createSdkMcpServer() + options.mcpServers —
// the engine routes execution and exposes it as mcp__<server>__<name>.
export function tool(name, description, inputSchema, handler, extras = {}) {
    return { name, description, inputSchema, handler, annotations: extras.annotations };
}

// Build an in-process MCP server config (SDK parity). Pass the result in
// options.mcpServers: { myServer: createSdkMcpServer({ name: 'myServer', tools: [...] }) }
export function createSdkMcpServer({ name, version = '1.0.0', tools = [] } = {}) {
    return { type: 'sdk', name, instance: { name, version, tools } };
}
