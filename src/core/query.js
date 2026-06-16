import { OpenRouterClient } from '../providers/openrouter.js';
import { normalizeOptions } from './options.js';
import { buildSystemPrompt } from './system-prompt.js';
import {
    buildOpenRouterServerTools,
    createToolRuntime,
    mcpToolDefinitions,
} from '../tools/index.js';
import { filePlugins, resolveAttachments } from '../context/attachments.js';
import { perceive } from '../context/perception.js';
import { compact, estimateTokens, trimOldToolResults } from '../context/compaction.js';
import { evaluate } from '../permissions/index.js';
import { EXPLORATION_TOOLS } from '../tools/meta.js';
import { searchBudgetNudge } from './search-budget.js';
import { runHooks } from '../hooks/index.js';
import { loadSession, newSessionId, saveSession } from '../sessions/index.js';
import {
    accumulateUsage,
    assistantMessage,
    compactBoundary,
    emptyUsage,
    parseToolArguments,
    partialAssistant,
    resultMessage,
    systemInit,
    userToolResult,
} from './messages.js';

// query({ prompt, options }) -> async generator of SDKMessage.
//
// This is the 1:1-shaped entrypoint that mirrors @anthropic-ai/claude-agent-sdk
// (practical core), backed by the OpenRouter chat-completions loop instead of
// the Claude Code binary. It owns option normalization, the system-init emit,
// the turn loop (model call -> assistant -> permission/hook-gated tool exec ->
// tool_result), context compaction, session persistence, and the terminal
// result message.
//
// Like the SDK's Query object, the returned generator carries control methods:
//   .interrupt()       abort the run; history so far is persisted, so the
//                      session can be continued later via options.resume
//   .abortController   the underlying controller (caller-supplied or created)
export function query({ prompt, options = {} } = {}) {
    const abortController = options.abortController || new AbortController();
    const generator = runQuery({ prompt, options: { ...options, abortController } });
    generator.interrupt = () => abortController.abort();
    generator.abortController = abortController;
    return generator;
}

async function* runQuery({ prompt, options = {} } = {}) {
    if (prompt === undefined || prompt === null) throw new Error('prompt is required');

    const opts = normalizeOptions(options);
    const startedAt = Date.now();
    const sessionId = opts.resume || opts.sessionId || newSessionId();
    const signal = opts.abortController?.signal;

    const client = new OpenRouterClient({
        apiKey: opts.apiKey,
        model: opts.model,
        baseUrl: opts.baseUrl,
        timeoutMs: opts.timeoutMs,
    });
    const runtime = createToolRuntime({
        cwd: opts.cwd,
        additionalDirectories: opts.additionalDirectories,
        allowOutsideCwd: opts.allowOutsideCwd,
        onEvent: opts.onEvent,
        mcpServers: opts.mcpServers,
        queryOptions: opts,
    });
    const mcpDefinitions = mcpToolDefinitions(opts.mcpServers);
    const tools = [
        ...opts.builtinTools,
        ...mcpDefinitions,
        ...buildOpenRouterServerTools({
            openRouterWebSearch: opts.openRouterWebSearch,
            openRouterWebFetch: opts.openRouterWebFetch,
            webSearchEngine: opts.webSearchEngine,
            webSearchMaxResults: opts.webSearchMaxResults,
            webSearchMaxTotalResults: opts.webSearchMaxTotalResults,
            webSearchContextSize: opts.webSearchContextSize,
            webFetchEngine: opts.webFetchEngine,
            webFetchMaxUses: opts.webFetchMaxUses,
            webFetchMaxContentTokens: opts.webFetchMaxContentTokens,
        }),
    ];
    const toolNames = [...opts.builtinTools, ...mcpDefinitions]
        .map((tool) => tool.function?.name)
        .filter(Boolean);

    const history = await loadSession(opts.cwd, opts.resume).catch((error) => {
        throw new Error(`Cannot load session ${opts.resume}: ${error.message}`);
    });

    yield systemInit({
        sessionId,
        model: client.model,
        cwd: opts.cwd,
        tools: toolNames,
        mcpServers: Object.keys(opts.mcpServers),
        permissionMode: opts.permissionMode,
        apiKeySource: client.apiKeys.length ? 'env' : 'none',
        extra: { api_key_count: client.apiKeys.length },
    });

    // System prompt: base + env info + project doc + memory index (only when
    // using the default/preset prompt).
    const systemText = opts.enrichSystemPrompt
        ? await buildSystemPrompt({
              base: opts.systemPromptBase,
              cwd: opts.cwd,
              includeEnvInfo: opts.includeEnvInfo,
              loadProjectContext: opts.loadProjectContext,
              memory: opts.memory,
          })
        : opts.systemPromptBase;

    let messages = [{ role: 'system', content: systemText }, ...history];

    const sessionStart = await runHooks('SessionStart', opts.hooks, { signal });
    for (const note of sessionStart.systemMessages) {
        messages.push({ role: 'system', content: note });
    }

    // Resolve external context (images / PDFs / docs / audio / video) into
    // OpenRouter content parts.
    const attachment = await resolveAttachments(opts.attachments, opts.cwd);
    let plugins = filePlugins(attachment.hasFile, opts.pdfEngine);

    // Stage 1 (perception): a dedicated omni model turns media into text so the
    // text-only planner (this loop) can reason over it. Disabled via
    // perception:false, which instead attaches raw media to the main model.
    let perceived = null;
    if (attachment.parts.length && opts.perception && opts.perceptionModel) {
        opts.onEvent({
            type: 'perception_start',
            model: opts.perceptionModel,
            attachments: opts.attachments.length,
        });
        try {
            perceived = await perceive({
                client,
                model: opts.perceptionModel,
                parts: attachment.parts,
                plugins,
                signal,
            });
            opts.onEvent({ type: 'perception_end', chars: perceived.length });
        } catch (error) {
            perceived = `[perception step failed: ${error.message}]`;
            opts.onEvent({ type: 'perception_error', error: error.message });
        }
        plugins = undefined; // planner is text-only now
    }

    // Resolve the prompt (string or AsyncIterable<SDKUserMessage>) into user turns.
    const userTurns = await collectUserTurns(prompt);
    for (let i = 0; i < userTurns.length; i += 1) {
        const text = userTurns[i];
        const submit = await runHooks('UserPromptSubmit', opts.hooks, { prompt: text, signal });
        if (submit.blocked) {
            yield finalResult('error_during_execution', {
                errors: [submit.reason || 'Blocked by UserPromptSubmit hook'],
            });
            return;
        }
        for (const note of submit.systemMessages) messages.push({ role: 'system', content: note });

        const isLast = i === userTurns.length - 1;
        let content = text;
        if (isLast && perceived != null) {
            content = `${text}\n\n--- Perceived context (via ${opts.perceptionModel}) ---\n${perceived}`;
        } else if (isLast && attachment.parts.length) {
            content = [{ type: 'text', text }, ...attachment.parts];
        }
        messages.push({ role: 'user', content });
    }

    let usage = emptyUsage();
    let totalCostUsd = 0;
    let numTurns = 0;
    const permissionDenials = [];
    const compactAtTokens = Math.floor(opts.maxContextTokens * 0.8);
    // Convergence pressure: consecutive exploration calls since the last edit/
    // run/hypothesis (see core/search-budget.js).
    let searchStreak = 0;
    let lastSearchWarnAt = 0;

    try {
        for (let turn = 1; turn <= opts.maxTurns; turn += 1) {
            if (signal?.aborted) {
                // Persist before bailing so the interrupted session can be
                // resumed with options.resume / --session.
                await persist().catch(() => {});
                yield finalResult('error_during_execution', {
                    errors: ['Interrupted by user'],
                });
                return;
            }
            numTurns = turn;
            opts.onEvent({ type: 'turn', turn, maxTurns: opts.maxTurns, model: client.model });

            // Context window management: summarize-and-replace when near the
            // limit, cheap trimming of stale tool output before that.
            if (opts.autoCompact) {
                const estimated = estimateTokens(messages);
                if (estimated > compactAtTokens) {
                    opts.onEvent({ type: 'compaction_start', estimatedTokens: estimated });
                    try {
                        const compacted = await compact({
                            client,
                            model: client.model,
                            messages,
                            keepRecent: opts.keepRecentMessages,
                            signal,
                        });
                        if (compacted) {
                            messages = compacted.messages;
                            const postTokens = estimateTokens(messages);
                            opts.onEvent({ type: 'compaction_end', estimatedTokens: postTokens });
                            yield compactBoundary({
                                sessionId,
                                preTokens: estimated,
                                postTokens,
                                trigger: 'auto',
                            });
                        }
                    } catch (error) {
                        opts.onEvent({ type: 'compaction_error', error: error.message });
                        messages = trimOldToolResults(messages, {
                            keepTail: opts.keepRecentMessages,
                        });
                    }
                } else if (estimated > compactAtTokens * 0.6) {
                    messages = trimOldToolResults(messages, { keepTail: opts.keepRecentMessages });
                }
            }

            const response = yield* runModel(turn);
            usage = accumulateUsage(usage, response?.usage) || usage;
            totalCostUsd += Number(response?.usage?.cost || 0);

            const choice = response?.choices?.[0];
            const assistant = choice?.message;
            if (!assistant) {
                throw new Error(
                    'OpenRouter returned no assistant message after retries ' +
                        '(empty choices / provider error). Try a different --model/--fallback-model or lower the context size.'
                );
            }

            const toolCalls = assistant.tool_calls || [];
            messages.push({
                role: 'assistant',
                content: assistant.content || '',
                tool_calls: toolCalls.length ? toolCalls : undefined,
            });

            yield assistantMessage({
                sessionId,
                model: client.model,
                openaiMessage: assistant,
                usage: response.usage,
                stopReason: choice?.finish_reason || (toolCalls.length ? 'tool_use' : 'end_turn'),
            });

            if (!toolCalls.length) {
                // Stop hooks may keep the agent working (decision: "block").
                const stop = await runHooks('Stop', opts.hooks, { signal });
                for (const note of stop.systemMessages) {
                    messages.push({ role: 'system', content: note });
                }
                if (stop.blocked && stop.continue !== false) {
                    messages.push({
                        role: 'system',
                        content: `Stop hook: ${stop.reason || 'continue working — the task is not finished yet'}`,
                    });
                    continue;
                }
                await persist();
                await runHooks('SessionEnd', opts.hooks, { signal });
                yield finalResult('success', { result: assistant.content || '' });
                return;
            }

            const results = [];
            for (const call of toolCalls) {
                const result = await handleToolCall(call);
                results.push(result);
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    name: call.function?.name,
                    content: result.content,
                });
                if (EXPLORATION_TOOLS.has(call.function?.name)) searchStreak += 1;
                else {
                    searchStreak = 0;
                    lastSearchWarnAt = 0;
                }
            }

            // Apply stopping pressure once search runs on without converging.
            const nudge = searchBudgetNudge(searchStreak, lastSearchWarnAt, opts.maxSearchSteps);
            if (nudge) {
                lastSearchWarnAt = nudge.warnAt;
                messages.push({ role: 'system', content: nudge.message });
                opts.onEvent({ type: 'search_budget', streak: searchStreak });
            }

            yield userToolResult({ sessionId, results });
        }

        await persist();
        await runHooks('SessionEnd', opts.hooks, { signal });
        yield finalResult('error_max_turns', {
            errors: [`Stopped after maxTurns=${opts.maxTurns}.`],
        });
    } catch (error) {
        await persist().catch(() => {});
        yield finalResult('error_during_execution', {
            errors: [signal?.aborted ? 'Interrupted by user' : error.message],
        });
    }

    // --- turn helpers (closures over the loop state) ---

    async function* runModel(turn) {
        // Free models occasionally return HTTP 200 with empty choices / no
        // assistant message (provider hiccup, large context). Retry the turn a
        // few times with backoff — and switch to fallbackModel after the first
        // empty — instead of crashing the whole run.
        const MAX_EMPTY_RETRIES = 3;
        let response;

        for (let attempt = 0; attempt <= MAX_EMPTY_RETRIES; attempt += 1) {
            if (signal?.aborted) break;
            const retryModel = attempt > 0 && opts.fallbackModel ? opts.fallbackModel : undefined;
            const params = {
                messages,
                tools,
                temperature: opts.temperature,
                maxTokens: opts.maxTokens,
                reasoning: opts.reasoning,
                verbosity: opts.verbosity,
                plugins,
                extraArgs: opts.extraArgs,
                signal,
                ...(retryModel ? { model: retryModel } : {}),
            };

            if (!opts.includePartialMessages) {
                response = await client.chat(params);
            } else {
                // Bridge SSE deltas into yielded partial_assistant messages.
                const queue = createDeltaQueue();
                const done = client
                    .chat({ ...params, stream: true, onDelta: (delta) => queue.push(delta) })
                    .then(
                        (res) => queue.close(res),
                        (err) => queue.fail(err)
                    );
                for await (const delta of queue) {
                    yield partialAssistant({ sessionId, partial: deltaToBlock(delta) });
                }
                await done;
                response = queue.value;
            }

            if (response?.choices?.[0]?.message) return response;

            if (attempt < MAX_EMPTY_RETRIES) {
                opts.onEvent({
                    type: 'retry',
                    reason: 'empty_response',
                    attempt: attempt + 1,
                    model: retryModel || client.model,
                });
                await sleep(400 * (attempt + 1), signal);
            }
        }

        return response;
    }

    async function handleToolCall(call) {
        const name = call.function?.name;
        let input = parseToolArguments(call.function?.arguments);

        const pre = await runHooks('PreToolUse', opts.hooks, {
            toolName: name,
            input,
            signal,
            toolUseID: call.id,
        });
        if (pre.blocked) {
            return {
                tool_use_id: call.id,
                content: `BLOCKED: ${pre.reason || 'PreToolUse hook'}`,
                is_error: true,
            };
        }
        if (pre.updatedInput) input = pre.updatedInput;

        if (pre.permissionDecision !== 'allow') {
            const decision = await evaluate({
                mode: opts.permissionMode,
                name,
                input,
                canUseTool: opts.canUseTool,
                allowDangerouslySkip: opts.allowDangerouslySkipPermissions,
                allowRules: opts.allowRules,
                denyRules: opts.denyRules,
                signal,
                toolUseID: call.id,
            });
            if (decision.behavior === 'deny') {
                permissionDenials.push({
                    tool_name: name,
                    tool_use_id: call.id,
                    tool_input: input,
                });
                return {
                    tool_use_id: call.id,
                    content: `DENIED: ${decision.message}`,
                    is_error: true,
                };
            }
            if (decision.updatedInput) input = decision.updatedInput;
        }

        const { content, is_error } = await runtime.execute(name, input);

        const post = await runHooks('PostToolUse', opts.hooks, {
            toolName: name,
            input,
            toolResponse: { content, is_error },
            signal,
            toolUseID: call.id,
        });
        for (const note of post.systemMessages) messages.push({ role: 'system', content: note });

        return { tool_use_id: call.id, content, is_error };
    }

    function finalResult(subtype, extra = {}) {
        return resultMessage({
            subtype,
            sessionId,
            numTurns,
            usage,
            modelUsage: {
                [client.model]: {
                    input_tokens: usage.input_tokens,
                    output_tokens: usage.output_tokens,
                    cost_usd: totalCostUsd,
                },
            },
            durationMs: Date.now() - startedAt,
            totalCostUsd,
            permissionDenials,
            ...extra,
        });
    }

    async function persist() {
        await saveSession(opts.cwd, sessionId, messages.slice(1), { model: client.model });
    }
}

async function collectUserTurns(prompt) {
    if (typeof prompt === 'string') return [prompt];
    if (prompt && typeof prompt[Symbol.asyncIterator] === 'function') {
        const turns = [];
        for await (const message of prompt) {
            turns.push(messageParamToText(message?.message ?? message));
        }
        return turns.filter(Boolean);
    }
    return [String(prompt)];
}

function messageParamToText(message) {
    if (!message) return '';
    if (typeof message === 'string') return message;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((block) => (typeof block === 'string' ? block : block.text || ''))
            .filter(Boolean)
            .join('\n');
    }
    return '';
}

function deltaToBlock(delta) {
    if (delta.type === 'reasoning') return { type: 'thinking', thinking: delta.text };
    return { type: 'text', text: delta.text };
}

function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true }
        );
    });
}

// Minimal single-consumer async queue used to bridge streaming deltas into the
// generator. close(value) ends iteration and stashes the final return value.
function createDeltaQueue() {
    const items = [];
    let resolveNext;
    let finished = false;
    let error;
    const queue = {
        value: undefined,
        push(item) {
            items.push(item);
            resolveNext?.();
        },
        close(value) {
            queue.value = value;
            finished = true;
            resolveNext?.();
        },
        fail(err) {
            error = err;
            finished = true;
            resolveNext?.();
        },
        async *[Symbol.asyncIterator]() {
            while (true) {
                if (error) throw error;
                if (items.length) {
                    yield items.shift();
                    continue;
                }
                if (finished) return;
                await new Promise((resolve) => {
                    resolveNext = resolve;
                });
                resolveNext = undefined;
            }
        },
    };
    return queue;
}
