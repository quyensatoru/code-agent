export const MAX_TOOL_OUTPUT = 24000;
export const USER_AGENT = 'OpenRouterCodeAgent/0.2 (+https://openrouter.ai)';

export function formatResult(value) {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export function truncate(text, max) {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

export function removeUndefined(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
