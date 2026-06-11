// Public library surface — mirrors @anthropic-ai/claude-agent-sdk (practical
// core) but backed by OpenRouter. The canonical entrypoint is `query()`.
export { query } from './query.js';
export { SYSTEM_PROMPT, normalizeOptions } from './options.js';
export { toolDefinitions, TOOL_META } from './tools.js';
export { classifyTool } from './permissions.js';
export { HOOK_EVENTS } from './hooks.js';

export const VERSION = '0.1.0';

// Thrown when a query is aborted via options.abortController.
export class AbortError extends Error {
    constructor(message = 'Operation aborted') {
        super(message);
        this.name = 'AbortError';
    }
}

// Define an in-process tool (SDK parity helper). The handler receives parsed
// args and returns a CallToolResult-shaped object.
export function tool(name, description, inputSchema, handler, extras = {}) {
    return { name, description, inputSchema, handler, annotations: extras.annotations };
}

// Build an in-process MCP server config (SDK parity). Note: practical-core
// query() does not yet route MCP tool execution — this provides the shape.
export function createSdkMcpServer({ name, version = '1.0.0', tools = [] } = {}) {
    return { type: 'sdk', name, instance: { name, version, tools } };
}
