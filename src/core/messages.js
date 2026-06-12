import { randomUUID } from 'node:crypto';

// Builders + translators for the SDK message taxonomy.
//
// We mirror the practical core of @anthropic-ai/claude-agent-sdk:
//   system(init) -> assistant -> user(tool_result) -> result(success|error_*)
// plus partial_assistant when includePartialMessages is set.
//
// The OpenRouter engine speaks the OpenAI chat shape, so these helpers also
// translate an OpenAI-style assistant message into Anthropic content blocks
// (text / thinking / tool_use), matching the shape SDK consumers expect on
// `message.content`.

export function newUuid() {
    return randomUUID();
}

let toolCounter = 0;
export function newToolUseId() {
    toolCounter += 1;
    return `toolu_${Date.now().toString(36)}_${toolCounter}`;
}

export function systemInit({
    sessionId,
    model,
    cwd,
    tools = [],
    mcpServers = [],
    permissionMode = 'default',
    apiKeySource = 'env',
    extra = {},
}) {
    return {
        type: 'system',
        subtype: 'init',
        uuid: newUuid(),
        session_id: sessionId,
        cwd,
        model,
        permissionMode,
        apiKeySource,
        tools,
        mcp_servers: mcpServers,
        ...extra,
    };
}

// Translate an OpenAI-shape assistant message into Anthropic content blocks.
export function toContentBlocks(openaiMessage = {}) {
    const blocks = [];
    const reasoning = extractReasoning(openaiMessage);
    if (reasoning) blocks.push({ type: 'thinking', thinking: reasoning });
    if (openaiMessage.content) {
        blocks.push({ type: 'text', text: openaiMessage.content });
    }
    for (const call of openaiMessage.tool_calls || []) {
        blocks.push({
            type: 'tool_use',
            id: call.id,
            name: call.function?.name,
            input: parseToolArguments(call.function?.arguments),
        });
    }
    return blocks;
}

export function assistantMessage({
    sessionId,
    model,
    openaiMessage = {},
    usage,
    stopReason = null,
    parentToolUseId = null,
}) {
    return {
        type: 'assistant',
        uuid: newUuid(),
        session_id: sessionId,
        parent_tool_use_id: parentToolUseId,
        message: {
            id: openaiMessage.id || `msg_${newUuid()}`,
            type: 'message',
            role: 'assistant',
            model,
            content: toContentBlocks(openaiMessage),
            stop_reason: stopReason,
            stop_sequence: null,
            usage: usage || undefined,
        },
    };
}

export function userToolResult({ sessionId, results = [], parentToolUseId = null }) {
    return {
        type: 'user',
        uuid: newUuid(),
        session_id: sessionId,
        parent_tool_use_id: parentToolUseId,
        message: {
            role: 'user',
            content: results.map((result) => ({
                type: 'tool_result',
                tool_use_id: result.tool_use_id,
                content: result.content,
                is_error: result.is_error || undefined,
            })),
        },
    };
}

// Emitted when the engine auto-compacts the conversation (mirrors the SDK's
// system/compact_boundary message).
export function compactBoundary({ sessionId, preTokens = 0, postTokens = 0, trigger = 'auto' }) {
    return {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: newUuid(),
        session_id: sessionId,
        compact_metadata: { trigger, pre_tokens: preTokens, post_tokens: postTokens },
    };
}

export function partialAssistant({ sessionId, partial }) {
    return {
        type: 'partial_assistant',
        uuid: newUuid(),
        session_id: sessionId,
        partial,
    };
}

export function resultMessage({
    subtype = 'success',
    sessionId,
    result = '',
    numTurns = 0,
    usage = emptyUsage(),
    modelUsage = {},
    durationMs = 0,
    durationApiMs = 0,
    totalCostUsd = 0,
    stopReason = null,
    permissionDenials = [],
    errors,
}) {
    const base = {
        type: 'result',
        subtype,
        uuid: newUuid(),
        session_id: sessionId,
        duration_ms: durationMs,
        duration_api_ms: durationApiMs,
        is_error: subtype !== 'success',
        num_turns: numTurns,
        stop_reason: stopReason,
        total_cost_usd: totalCostUsd,
        usage,
        modelUsage,
        permission_denials: permissionDenials,
    };
    if (subtype === 'success') return { ...base, result };
    return { ...base, errors: errors || [] };
}

export function emptyUsage() {
    return {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
    };
}

// Normalize OpenRouter/OpenAI usage into the SDK usage shape and accumulate.
export function accumulateUsage(target, raw) {
    if (!raw) return target;
    const usage = target || emptyUsage();
    usage.input_tokens += raw.prompt_tokens ?? raw.input_tokens ?? 0;
    usage.output_tokens += raw.completion_tokens ?? raw.output_tokens ?? 0;
    const cacheRead = raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens ?? 0;
    usage.cache_read_input_tokens += cacheRead;
    return usage;
}

export function parseToolArguments(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return { raw };
    }
}

export function extractReasoning(message) {
    if (!message) return '';
    if (typeof message.reasoning === 'string') return message.reasoning;
    if (Array.isArray(message.reasoning_details)) {
        return message.reasoning_details
            .map((item) => item.text || item.content || '')
            .filter(Boolean)
            .join('\n');
    }
    return '';
}
