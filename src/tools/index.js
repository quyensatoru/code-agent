import path from 'node:path';
import { MAX_TOOL_OUTPUT, formatResult, removeUndefined, truncate } from './shared.js';
import { validateInput } from './validate.js';
import { searchToolDefinitions, createSearchHandlers, loadGitIgnoreMatcher } from './search.js';
import { fsToolDefinitions, createFsHandlers } from './fs.js';
import { shellToolDefinitions, createShellHandlers } from './shell.js';
import { todoToolDefinitions, createTodoHandlers } from './todo.js';
import { webToolDefinitions, createWebHandlers } from './web.js';
import { agentToolDefinitions, createAgentHandlers } from './agent.js';
import { gitToolDefinitions, createGitHandlers } from './git.js';
import { sandboxToolDefinitions, createSandboxHandlers } from './sandbox.js';
import { browserToolDefinitions, createBrowserHandlers } from './browser.js';
import { dataToolDefinitions, createDataHandlers } from './data.js';
import { codebaseToolDefinitions, createCodebaseHandlers } from './codebase.js';
import { triageToolDefinitions, createTriageHandlers } from './triage.js';
import { hypothesisToolDefinitions, createHypothesisHandlers } from './hypothesis.js';

export { TOOL_META } from './meta.js';

// All built-in tool definitions, in the order the model sees them. The
// investigation tools come first in protocol order — triage the issue, map the
// codebase, then hypothesize — so the model orients before it greps.
export const toolDefinitions = [
    ...triageToolDefinitions,
    ...codebaseToolDefinitions,
    ...hypothesisToolDefinitions,
    ...searchToolDefinitions,
    ...fsToolDefinitions,
    ...shellToolDefinitions,
    ...gitToolDefinitions,
    ...sandboxToolDefinitions,
    ...browserToolDefinitions,
    ...dataToolDefinitions,
    ...todoToolDefinitions,
    ...webToolDefinitions,
    ...agentToolDefinitions,
];

export function buildToolDefinitions(options = {}) {
    return [...toolDefinitions, ...buildOpenRouterServerTools(options)];
}

// OpenRouter server-side tools (executed by OpenRouter, not locally).
export function buildOpenRouterServerTools({
    openRouterWebSearch = true,
    openRouterWebFetch = true,
    webSearchEngine,
    webSearchMaxResults,
    webSearchMaxTotalResults,
    webSearchContextSize,
    webFetchEngine,
    webFetchMaxUses,
    webFetchMaxContentTokens,
} = {}) {
    const tools = [];
    if (openRouterWebSearch) {
        tools.push({
            type: 'openrouter:web_search',
            parameters: removeUndefined({
                engine: webSearchEngine,
                max_results: webSearchMaxResults,
                max_total_results: webSearchMaxTotalResults,
                search_context_size: webSearchContextSize,
            }),
        });
    }
    if (openRouterWebFetch) {
        tools.push({
            type: 'openrouter:web_fetch',
            parameters: removeUndefined({
                engine: webFetchEngine,
                max_uses: webFetchMaxUses,
                max_content_tokens: webFetchMaxContentTokens,
            }),
        });
    }
    return tools;
}

// Definitions for in-process custom tools registered via createSdkMcpServer()
// (options.mcpServers entries with type "sdk"). Tool names follow the SDK's
// mcp__<server>__<tool> convention.
export function mcpToolDefinitions(mcpServers = {}) {
    const definitions = [];
    for (const [serverName, config] of Object.entries(mcpServers)) {
        if (config?.type !== 'sdk') continue; // external MCP transports not supported
        for (const tool of config.instance?.tools || []) {
            const schema =
                tool.inputSchema && typeof tool.inputSchema === 'object' && tool.inputSchema.type
                    ? tool.inputSchema
                    : { type: 'object', properties: {} };
            definitions.push({
                type: 'function',
                function: {
                    name: `mcp__${serverName}__${tool.name}`,
                    description: tool.description || '',
                    parameters: schema,
                },
            });
        }
    }
    return definitions;
}

// The tool runtime is purely mechanical: permission/hook gating happens in
// core/query.js before execute() runs. It owns path sandboxing, argument
// validation/coercion against each tool's schema, dispatch, and output
// truncation.
export function createToolRuntime({
    cwd = process.cwd(),
    additionalDirectories = [],
    allowOutsideCwd = false,
    onEvent = () => {},
    mcpServers = {},
    queryOptions,
} = {}) {
    const root = path.resolve(cwd);
    const extraRoots = additionalDirectories.map((dir) => path.resolve(root, dir));
    const ignoreMatcherPromise = loadGitIgnoreMatcher(root);

    function resolvePath(target = '.') {
        const full = path.resolve(root, target);
        if (allowOutsideCwd) return full;
        if (full === root || full.startsWith(root + path.sep)) return full;
        if (extraRoots.some((dir) => full === dir || full.startsWith(dir + path.sep))) return full;
        throw new Error(`Path escapes workspace: ${target}`);
    }

    const handlers = {
        ...createCodebaseHandlers({ root, resolvePath, getMatcher: () => ignoreMatcherPromise }),
        ...createTriageHandlers(),
        ...createHypothesisHandlers(),
        ...createSearchHandlers({ root, resolvePath, getMatcher: () => ignoreMatcherPromise }),
        ...createFsHandlers({ root, resolvePath }),
        ...createShellHandlers({ root }),
        ...createGitHandlers({ root }),
        ...createSandboxHandlers(),
        ...createBrowserHandlers({ root }),
        ...createDataHandlers(),
        ...createTodoHandlers(),
        ...createWebHandlers(),
        ...createAgentHandlers({ queryOptions, onEvent }),
        ...createMcpHandlers(mcpServers),
    };

    const schemas = new Map();
    for (const def of [...toolDefinitions, ...mcpToolDefinitions(mcpServers)]) {
        schemas.set(def.function.name, def.function.parameters);
    }

    async function execute(name, input = {}) {
        let args = input || {};
        onEvent({ type: 'tool_start', name, input: args });

        const handler = handlers[name];
        if (!handler) {
            const content = `ERROR: Unknown tool "${name}". Available tools: ${Object.keys(handlers).join(', ')}`;
            onEvent({ type: 'tool_end', name, ok: false, content });
            return { content, is_error: true };
        }

        const schema = schemas.get(name);
        if (schema) {
            const { value, errors } = validateInput(schema, args);
            if (errors.length) {
                const content = `INVALID INPUT for ${name}: ${errors.join('; ')}. Fix the arguments and retry.`;
                onEvent({ type: 'tool_end', name, ok: false, content });
                return { content, is_error: true };
            }
            args = value;
        }

        try {
            const result = await handler(args);
            const content = truncate(formatResult(result), MAX_TOOL_OUTPUT);
            onEvent({ type: 'tool_end', name, ok: true, content });
            return { content, is_error: false };
        } catch (error) {
            const content = `ERROR: ${error.message}`;
            onEvent({ type: 'tool_end', name, ok: false, content });
            return { content, is_error: true };
        }
    }

    return { root, execute, toolNames: () => Object.keys(handlers) };
}

function createMcpHandlers(mcpServers = {}) {
    const handlers = {};
    for (const [serverName, config] of Object.entries(mcpServers)) {
        if (config?.type !== 'sdk') continue;
        for (const tool of config.instance?.tools || []) {
            if (typeof tool.handler !== 'function') continue;
            handlers[`mcp__${serverName}__${tool.name}`] = async (args) =>
                normalizeMcpResult(await tool.handler(args, {}));
        }
    }
    return handlers;
}

// Accept CallToolResult ({ content: [{type:'text',text}] }), plain strings, or
// arbitrary JSON-able values from custom tool handlers.
function normalizeMcpResult(result) {
    if (result == null) return '';
    if (typeof result === 'string') return result;
    if (Array.isArray(result.content)) {
        return result.content
            .map((part) =>
                typeof part === 'string' ? part : (part.text ?? JSON.stringify(part))
            )
            .join('\n');
    }
    return result;
}
