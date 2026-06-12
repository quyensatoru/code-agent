// Hook runner mirroring the SDK's hook contract (practical subset).
//
// options.hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>
//   HookCallbackMatcher = { matcher?: string; hooks: HookCallback[] }
//   HookCallback = (input, toolUseID, { signal }) => Promise<HookJSONOutput>
//
// Hook callbacks receive an SDK-shaped payload:
//   PreToolUse       { hook_event_name, tool_name, tool_input }
//   PostToolUse      { hook_event_name, tool_name, tool_input, tool_response }
//   UserPromptSubmit { hook_event_name, prompt }
//   Stop / SessionStart / SessionEnd { hook_event_name }
//
// A PreToolUse hook may block the call or rewrite tool input via
// hookSpecificOutput.{permissionDecision, updatedInput}. A Stop hook returning
// decision:"block" keeps the agent working (the reason is fed back as context).

export const HOOK_EVENTS = [
    'PreToolUse',
    'PostToolUse',
    'UserPromptSubmit',
    'Stop',
    'SessionStart',
    'SessionEnd',
];

const TOOL_SCOPED_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

export async function runHooks(event, hooks, context = {}) {
    const { toolName, input, toolResponse, prompt, signal, toolUseID } = context;
    const aggregate = {
        blocked: false,
        continue: true,
        reason: undefined,
        stopReason: undefined,
        updatedInput: undefined,
        permissionDecision: undefined,
        systemMessages: [],
    };
    const matchers = hooks?.[event];
    if (!Array.isArray(matchers) || matchers.length === 0) return aggregate;

    const payload = buildPayload(event, { toolName, input, toolResponse, prompt });

    for (const matcher of matchers) {
        if (!matcherMatches(matcher.matcher, toolName, event)) continue;
        for (const hook of matcher.hooks || []) {
            const output = await hook(payload, toolUseID, { signal });
            applyOutput(aggregate, output);
            if (aggregate.blocked) return aggregate;
        }
    }
    return aggregate;
}

function buildPayload(event, { toolName, input, toolResponse, prompt }) {
    if (event === 'PreToolUse') {
        return { hook_event_name: event, tool_name: toolName, tool_input: input ?? {} };
    }
    if (event === 'PostToolUse') {
        return {
            hook_event_name: event,
            tool_name: toolName,
            tool_input: input ?? {},
            tool_response: toolResponse,
        };
    }
    if (event === 'UserPromptSubmit') return { hook_event_name: event, prompt: prompt ?? '' };
    return { hook_event_name: event };
}

function matcherMatches(matcher, toolName, event) {
    // Only PreToolUse/PostToolUse are tool-scoped — other events always run.
    if (!TOOL_SCOPED_EVENTS.has(event)) return true;
    if (!matcher || matcher === '*') return true;
    if (!toolName) return false;
    try {
        return new RegExp(matcher).test(toolName);
    } catch {
        return matcher === toolName;
    }
}

function applyOutput(aggregate, output) {
    if (!output || typeof output !== 'object') return;

    if (output.continue === false) {
        aggregate.blocked = true;
        aggregate.continue = false;
        aggregate.stopReason = output.stopReason || output.reason;
    }
    if (output.decision === 'block') {
        aggregate.blocked = true;
        aggregate.reason = output.reason || aggregate.reason;
    }
    if (typeof output.systemMessage === 'string') {
        aggregate.systemMessages.push(output.systemMessage);
    }

    const specific = output.hookSpecificOutput;
    if (specific) {
        if (specific.permissionDecision) aggregate.permissionDecision = specific.permissionDecision;
        if (specific.permissionDecision === 'deny') {
            aggregate.blocked = true;
            aggregate.reason = specific.permissionDecisionReason || aggregate.reason;
        }
        if (specific.updatedInput) aggregate.updatedInput = specific.updatedInput;
        if (typeof specific.additionalContext === 'string') {
            aggregate.systemMessages.push(specific.additionalContext);
        }
    }
}
