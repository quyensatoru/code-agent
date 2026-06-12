import { TOOL_META } from '../tools/meta.js';
import { isReadOnlyBash, matchesAny } from './rules.js';

// Map a tool name to a permission class. Read-class tools never prompt.
// Unknown tools (e.g. MCP/custom) are treated as `other` -> gated like edits.
export function classifyTool(name) {
    if (TOOL_META[name]) return TOOL_META[name].permission;
    if (typeof name === 'string' && name.startsWith('openrouter:')) return 'read';
    return 'other';
}

// Evaluate a tool call against deny/allow rules, the permission mode, and the
// optional canUseTool callback. Returns an SDK-shaped PermissionResult:
//   { behavior: "allow", updatedInput? } | { behavior: "deny", message }
//
// Order: deny rules -> read class -> bypass -> plan -> allow rules ->
// acceptEdits -> safe read-only Bash -> canUseTool.
export async function evaluate({
    mode = 'default',
    name,
    input = {},
    canUseTool,
    allowDangerouslySkip = false,
    allowRules = [],
    denyRules = [],
    signal,
    toolUseID,
}) {
    const klass = classifyTool(name);

    if (matchesAny(denyRules, name, input)) {
        return { behavior: 'deny', message: `${name} denied by disallowedTools rule` };
    }

    if (klass === 'read') return { behavior: 'allow' };
    if (mode === 'bypassPermissions' || allowDangerouslySkip) return { behavior: 'allow' };

    if (mode === 'plan') {
        if (name === 'Bash' && isReadOnlyBash(input.command)) return { behavior: 'allow' };
        return {
            behavior: 'deny',
            message: `plan mode: ${name} is not permitted (read-only exploration). Present a plan instead.`,
        };
    }

    if (matchesAny(allowRules, name, input)) return { behavior: 'allow' };
    if (mode === 'acceptEdits' && klass === 'edit') return { behavior: 'allow' };
    if (name === 'Bash' && isReadOnlyBash(input.command)) return { behavior: 'allow' };

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
