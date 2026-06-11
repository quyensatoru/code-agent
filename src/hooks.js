// Minimal hook runner mirroring the SDK's hook contract (practical subset).
//
// options.hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>
//   HookCallbackMatcher = { matcher?: string; hooks: HookCallback[] }
//   HookCallback = (input, toolUseID, { signal }) => Promise<HookJSONOutput>
//
// Supported events: PreToolUse, PostToolUse, UserPromptSubmit, Stop.
// A PreToolUse hook may block the call or rewrite tool input via
// hookSpecificOutput.{permissionDecision, updatedInput}.

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'];

export async function runHooks(event, hooks, { toolName, input, signal, toolUseID } = {}) {
    const matchers = hooks?.[event];
    const aggregate = {
        blocked: false,
        continue: true,
        reason: undefined,
        stopReason: undefined,
        updatedInput: undefined,
        permissionDecision: undefined,
        systemMessages: [],
    };
    if (!Array.isArray(matchers) || matchers.length === 0) return aggregate;

    for (const matcher of matchers) {
        if (!matcherMatches(matcher.matcher, toolName, event)) continue;
        for (const hook of matcher.hooks || []) {
            const output = await hook(input ?? {}, toolUseID, { signal });
            applyOutput(aggregate, output);
            if (aggregate.blocked) return aggregate;
        }
    }
    return aggregate;
}

function matcherMatches(matcher, toolName, event) {
    // UserPromptSubmit / Stop are not tool-scoped — always run.
    if (event === 'UserPromptSubmit' || event === 'Stop') return true;
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
