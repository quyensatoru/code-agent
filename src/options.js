import { toolDefinitions } from './tools.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TIMEOUT_MS = 600000;

// The default system prompt, reused as the `claude_code` preset body. The real
// SDK defers to the Claude Code binary's prompt; here we ship our own.
export const SYSTEM_PROMPT = `You are OpenRouter Code Agent, a pragmatic coding agent running in a local workspace.

Work like a CLI coding assistant:
- Inspect files with tools before making claims about the codebase.
- Use Glob/Grep to search code, and WebSearch/WebFetch when the answer depends on current external docs.
- Keep a todo list with TodoWrite for multi-step tasks.
- Prefer small, targeted edits.
- Use Edit for precise replacements and Write for new files.
- Run commands only when needed to inspect or verify.
- Never say a command or edit succeeded until the tool result confirms it.
- Keep the final answer concise: changed files, verification, and any remaining risk.

The user may choose any OpenRouter model. If the selected model is weak at tool calling, still follow the tool schemas exactly.`;

// Normalize the SDK-shaped Options into the concrete shape query.js consumes.
// Accepts SDK field names; fills defaults from env where relevant.
export function normalizeOptions(options = {}) {
    const permissionMode = options.permissionMode || 'default';
    if (
        permissionMode === 'bypassPermissions' &&
        !options.allowDangerouslySkipPermissions &&
        !envFlag(process.env.OPENROUTER_ALLOW_DANGEROUS)
    ) {
        throw new Error(
            'permissionMode "bypassPermissions" requires allowDangerouslySkipPermissions: true'
        );
    }

    const allowed = resolveAllowed(options);
    const disallowed = options.disallowedTools || [];

    return {
        apiKey: options.apiKey ?? process.env.OPENROUTER_API_KEY,
        model: options.model ?? process.env.OPENROUTER_MODEL,
        fallbackModel: options.fallbackModel,
        baseUrl: options.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL,
        timeoutMs: numberOr(
            options.timeoutMs ?? process.env.OPENROUTER_TIMEOUT_MS,
            DEFAULT_TIMEOUT_MS
        ),

        systemPrompt: resolveSystemPrompt(options.systemPrompt),
        allowedTools: allowed,
        disallowedTools: disallowed,
        builtinTools: selectTools(allowed, disallowed),

        permissionMode,
        allowDangerouslySkipPermissions: Boolean(options.allowDangerouslySkipPermissions),
        canUseTool: options.canUseTool,
        hooks: options.hooks || {},

        maxTurns: numberOr(options.maxTurns, 100),
        temperature: options.temperature ?? 0.2,
        maxTokens: numberOrUndefined(options.maxTokens),
        reasoning: mapReasoning(options),
        verbosity: options.verbosity ?? process.env.OPENROUTER_VERBOSITY,

        cwd: options.cwd || process.cwd(),
        additionalDirectories: options.additionalDirectories || [],
        allowOutsideCwd: Boolean(options.allowOutsideCwd),

        // External context: images / PDFs / docs / audio / video attached to the prompt.
        attachments: options.attachments || [],
        pdfEngine: options.pdfEngine || process.env.OPENROUTER_PDF_ENGINE,
        // Two-stage perception: a dedicated omni model turns media into text for
        // the text-only planner (this.model). Set perception:false to instead
        // attach raw media directly to the main model (needs a multimodal model).
        perception: options.perception !== false,
        perceptionModel:
            options.perceptionModel ??
            process.env.OPENROUTER_VISION_MODEL ??
            'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',

        includePartialMessages: Boolean(options.includePartialMessages),
        abortController: options.abortController,
        extraArgs: options.extraArgs || {},

        resume: options.resume,
        sessionId: options.sessionId,

        // OpenRouter server-side web tools (engine extension beyond the SDK).
        openRouterWebSearch: options.openRouterWebSearch ?? true,
        openRouterWebFetch: options.openRouterWebFetch ?? true,
        webSearchEngine: options.webSearchEngine,
        webSearchMaxResults: options.webSearchMaxResults,
        webSearchMaxTotalResults: options.webSearchMaxTotalResults,
        webSearchContextSize: options.webSearchContextSize,
        webFetchEngine: options.webFetchEngine,
        webFetchMaxUses: options.webFetchMaxUses,
        webFetchMaxContentTokens: options.webFetchMaxContentTokens,

        onEvent: options.onEvent || (() => {}),
    };
}

export function resolveSystemPrompt(systemPrompt) {
    if (!systemPrompt) return SYSTEM_PROMPT;
    if (typeof systemPrompt === 'string') return systemPrompt;
    if (systemPrompt.type === 'preset' && systemPrompt.preset === 'claude_code') {
        return systemPrompt.append ? `${SYSTEM_PROMPT}\n\n${systemPrompt.append}` : SYSTEM_PROMPT;
    }
    return SYSTEM_PROMPT;
}

// Filter the built-in tool definitions by allowed/disallowed lists. Matching is
// by tool name, supporting the SDK's `Name(...)` scoping syntax (the scope is
// ignored for definition selection; enforcement is left to canUseTool/hooks).
export function selectTools(allowedTools = [], disallowedTools = []) {
    const allow = allowedTools.map(baseToolName).filter(Boolean);
    const deny = new Set(disallowedTools.map(baseToolName).filter(Boolean));
    return toolDefinitions.filter((tool) => {
        const name = tool.function?.name;
        if (deny.has(name)) return false;
        if (allow.length && !allow.includes(name)) return false;
        return true;
    });
}

export function mapReasoning(options = {}) {
    const reasoning = { ...(options.reasoning || {}) };
    const maxThinkingTokens = numberOrUndefined(options.maxThinkingTokens);
    if (maxThinkingTokens !== undefined) reasoning.max_tokens = maxThinkingTokens;
    if (options.effort) reasoning.effort = options.effort;
    if (options.reasoningEffort && !reasoning.effort) reasoning.effort = options.reasoningEffort;

    const thinking = options.thinking;
    if (thinking?.type === 'disabled') reasoning.exclude = true;
    if (thinking?.type === 'enabled' && thinking.budget_tokens) {
        reasoning.max_tokens = thinking.budget_tokens;
    }
    if (options.excludeReasoning) reasoning.exclude = true;
    if (options.includeReasoning && !options.excludeReasoning) reasoning.exclude = false;

    return Object.keys(reasoning).length ? reasoning : undefined;
}

function resolveAllowed(options) {
    if (Array.isArray(options.allowedTools) && options.allowedTools.length) {
        return options.allowedTools;
    }
    if (Array.isArray(options.tools)) return options.tools;
    return [];
}

function baseToolName(spec) {
    if (typeof spec !== 'string') return '';
    const open = spec.indexOf('(');
    return (open === -1 ? spec : spec.slice(0, open)).trim();
}

function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function numberOrUndefined(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}

function envFlag(value) {
    if (value === undefined) return false;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}
