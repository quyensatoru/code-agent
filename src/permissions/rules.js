// Permission rules in the SDK's `Tool` / `Tool(spec)` syntax.
//
//   "Bash"            -> matches every Bash call
//   "Bash(npm *)"     -> matches Bash calls whose command matches the glob
//   "Edit(src/**)"    -> matches Edit calls whose path matches the glob
//
// allowedTools entries become allow rules (auto-approved, no prompt);
// disallowedTools entries become deny rules (always refused).

export function parseRule(spec) {
    if (typeof spec !== 'string' || !spec.trim()) return null;
    const trimmed = spec.trim();
    const open = trimmed.indexOf('(');
    if (open === -1 || !trimmed.endsWith(')')) return { tool: trimmed, pattern: null };
    return { tool: trimmed.slice(0, open).trim(), pattern: trimmed.slice(open + 1, -1) };
}

export function parseRules(specs = []) {
    return (specs || []).map(parseRule).filter(Boolean);
}

export function ruleMatches(rule, name, input = {}) {
    if (!rule || rule.tool !== name) return false;
    if (rule.pattern == null) return true;
    const target = ruleTarget(name, input);
    if (!target) return false;
    return globMatch(rule.pattern, target);
}

export function matchesAny(rules = [], name, input = {}) {
    return rules.some((rule) => ruleMatches(rule, name, input));
}

// The input field a rule's pattern is matched against, per tool.
function ruleTarget(name, input) {
    if (name === 'Bash') return String(input.command || '');
    if (name === 'WebFetch') return String(input.url || '');
    if (name === 'WebSearch') return String(input.query || '');
    return String(input.path || input.file_path || '');
}

// Minimal glob: `*` matches anything (including separators); everything else
// is literal. Matches the whole target.
export function globMatch(pattern, value) {
    const source = `^${pattern.split('*').map(escapeRegExp).join('.*')}$`;
    return new RegExp(source, 's').test(value);
}

// Commands that are safe to run without prompting: read-only inspection with
// no shell metacharacters (so a safe prefix can't smuggle a second command).
const SAFE_BASH_PREFIXES = [
    'git status',
    'git log',
    'git diff',
    'git show',
    'git branch',
    'git remote -v',
    'ls',
    'dir',
    'pwd',
    'cat',
    'type',
    'head',
    'tail',
    'wc',
    'grep',
    'rg',
    'find',
    'which',
    'where',
    'echo',
    'node -v',
    'node --version',
    'npm -v',
    'npm --version',
    'npm ls',
    'python --version',
    'python3 --version',
];

export function isReadOnlyBash(command) {
    const cmd = String(command || '').trim();
    if (!cmd || /[;&|><`$\n\r]/.test(cmd)) return false;
    return SAFE_BASH_PREFIXES.some((prefix) => cmd === prefix || cmd.startsWith(`${prefix} `));
}

function escapeRegExp(value) {
    return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}
