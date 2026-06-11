import { TOOL_META } from './tools.js';

// Map a tool name to a permission class. Read-class tools never prompt.
// Unknown tools (e.g. MCP/custom) are treated as `other` -> gated like edits.
export function classifyTool(name) {
    if (TOOL_META[name]) return TOOL_META[name].permission;
    if (typeof name === 'string' && name.startsWith('openrouter:')) return 'read';
    return 'other';
}

// Evaluate a tool call against the permission mode and optional canUseTool
// callback. Returns an SDK-shaped PermissionResult:
//   { behavior: "allow", updatedInput? } | { behavior: "deny", message }
export async function evaluate({
    mode = 'default',
    name,
    input = {},
    canUseTool,
    allowDangerouslySkip = false,
    signal,
    toolUseID,
}) {
    const klass = classifyTool(name);

    if (klass === 'read') return { behavior: 'allow' };
    if (mode === 'bypassPermissions' || allowDangerouslySkip) return { behavior: 'allow' };

    if (mode === 'plan') {
        return {
            behavior: 'deny',
            message: `plan mode: ${name} is not permitted (read-only exploration). Present a plan instead.`,
        };
    }

    if (mode === 'acceptEdits' && klass === 'edit') return { behavior: 'allow' };

    // default mode (and acceptEdits for bash/other) -> ask the callback.
    if (canUseTool) {
        const result = await canUseTool(name, input, {
            signal,
            toolUseID,
            permissionMode: mode,
            toolClass: klass,
        });
        return result || { behavior: 'deny', message: `${name} denied` };
    }

    return {
        behavior: 'deny',
        message: `${name} requires permission but no canUseTool handler was provided`,
    };
}
