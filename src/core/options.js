import { toolDefinitions } from '../tools/index.js';
import { parseRules } from '../permissions/rules.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TIMEOUT_MS = 600000;
const DEFAULT_MAX_CONTEXT_TOKENS = 100000;

// The default system prompt, reused as the `claude_code` preset body. The real
// SDK defers to the Claude Code binary's prompt; here we ship our own. The
// harness appends environment info, project context, and the memory index —
// see core/system-prompt.js.
export const SYSTEM_PROMPT = `You are OpenRouter Code Agent, a pragmatic coding agent running in a local workspace.

Investigation workflow — when fixing a bug or working in an unfamiliar area, do NOT grep blindly first. Work top-down:
1. Orient: on an unfamiliar codebase, run CodebaseMap once to learn its shape (languages, entry points, layout, dependencies). Skim the README/manifest.
2. Hypothesize: from the issue and symptoms, use the Hypothesize tool to record 2-3 candidate root causes — for each, your prediction and the single check that confirms or refutes it. Do this BEFORE searching, then search to test them, not to grab the first match.
3. Locate: use Grep/Glob to find suspects; TraceDeps for module imports/dependents (don't break callers); TraceCalls to trace the execution path (who calls a function up to the entry point, or what it calls).
4. Change: make the smallest edit that fixes the confirmed root cause.
5. Verify: run tests / RunCode / the app, and never claim success until a tool result confirms it.

Stop searching when you have enough: once a hypothesis is confirmed, act on it. Do not run open-ended Grep/Read indefinitely — if searching isn't converging, record hypotheses, test the likeliest, or state what evidence is missing.

Working rules:
- Inspect files with tools before making claims about the codebase.
- Use WebSearch/WebFetch when the answer depends on current external docs.
- For broad exploration whose intermediate output would flood your context, launch the Agent subagent and act on its summary.
- Keep a todo list with TodoWrite for multi-step tasks; exactly one item in_progress at a time.
- Prefer small, targeted edits. Use Edit for precise replacements and Write for new files.
- If a tool call fails with INVALID INPUT, fix the arguments to match the schema and retry once.
- Keep the final answer concise: root cause, changed files, verification, and any remaining risk.

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
    const prompt = resolveSystemPrompt(options.systemPrompt);

    return {
        apiKey: options.apiKey ?? process.env.OPENROUTER_API_KEY,
        model: options.model ?? process.env.OPENROUTER_MODEL,
        fallbackModel: options.fallbackModel,
        baseUrl: options.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL,
        timeoutMs: numberOr(
            options.timeoutMs ?? process.env.OPENROUTER_TIMEOUT_MS,
            DEFAULT_TIMEOUT_MS
        ),

        systemPromptBase: prompt.base,
        // Only the default/preset prompt gets harness sections (env, project
        // context, memory) appended; a custom string prompt is sent as-is.
        enrichSystemPrompt: prompt.enrich,
        includeEnvInfo: options.includeEnvInfo !== false,
        loadProjectContext: options.loadProjectContext !== false,
        memory: options.memory !== false,

        allowedTools: allowed,
        disallowedTools: disallowed,
        builtinTools: selectTools(allowed, disallowed),
        // SDK semantics: allowedTools entries are auto-approved (no prompt);
        // disallowedTools entries are always refused. `Tool(spec)` scoping is
        // honored — see permissions/rules.js.
        allowRules: parseRules(allowed),
        denyRules: parseRules(disallowed),

        mcpServers: options.mcpServers || {},

        permissionMode,
        allowDangerouslySkipPermissions: Boolean(options.allowDangerouslySkipPermissions),
        canUseTool: options.canUseTool,
        hooks: options.hooks || {},

        maxTurns: numberOr(options.maxTurns, 100),
        temperature: options.temperature ?? 0.2,
        maxTokens: numberOrUndefined(options.maxTokens),
        reasoning: mapReasoning(options),
        verbosity: options.verbosity ?? process.env.OPENROUTER_VERBOSITY,

        // Context window management (context/compaction.js).
        maxContextTokens: numberOr(
            options.maxContextTokens ?? process.env.OPENROUTER_MAX_CONTEXT_TOKENS,
            DEFAULT_MAX_CONTEXT_TOKENS
        ),
        autoCompact: options.autoCompact !== false,
        keepRecentMessages: numberOr(options.keepRecentMessages, 12),
        // Convergence pressure: nudge after this many consecutive exploration
        // (search/read) calls without progress. 0/false disables.
        maxSearchSteps: normalizeSearchSteps(
            options.maxSearchSteps ?? process.env.OPENROUTER_MAX_SEARCH_STEPS
        ),

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
    if (!systemPrompt) return { base: SYSTEM_PROMPT, enrich: true };
    if (typeof systemPrompt === 'string') return { base: systemPrompt, enrich: false };
    if (systemPrompt.type === 'preset' && systemPrompt.preset === 'claude_code') {
        return {
            base: systemPrompt.append
                ? `${SYSTEM_PROMPT}\n\n${systemPrompt.append}`
                : SYSTEM_PROMPT,
            enrich: true,
        };
    }
    return { base: SYSTEM_PROMPT, enrich: true };
}

// Filter the built-in tool definitions by allowed/disallowed lists.
//
// Entries WITHOUT a (spec) participate in selection: allowedTools restricts
// the definition set; disallowedTools removes tools entirely. Entries WITH a
// spec (e.g. "Bash(npm *)") are permission rules only and do not affect which
// tools the model sees.
export function selectTools(allowedTools = [], disallowedTools = []) {
    const allow = allowedTools
        .filter((spec) => typeof spec === 'string' && !spec.includes('('))
        .map((spec) => spec.trim())
        .filter(Boolean);
    const deny = new Set(
        disallowedTools
            .filter((spec) => typeof spec === 'string' && !spec.includes('('))
            .map((spec) => spec.trim())
            .filter(Boolean)
    );
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

function normalizeSearchSteps(value) {
    if (value === false || value === 0 || value === '0') return 0;
    return numberOr(value, 16);
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
