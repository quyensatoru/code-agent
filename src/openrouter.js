const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TIMEOUT_MS = 600000;

export class OpenRouterClient {
    #keyCursor = 0;

    constructor({
        apiKey = process.env.OPENROUTER_API_KEY,
        apiKeys,
        model = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5',
        baseUrl = process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL,
        referer = process.env.OPENROUTER_HTTP_REFERER,
        title = process.env.OPENROUTER_TITLE || 'OpenRouter Code Agent',
        timeoutMs = numberFromEnv(process.env.OPENROUTER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    } = {}) {
        // Rotate across a pool of keys (from multiple accounts) to spread load
        // and dodge per-key rate limits. Keys may be supplied as an array, a
        // comma/newline-separated string, or via OPENROUTER_API_KEYS in the env.
        this.apiKeys = parseKeys(apiKeys, apiKey, process.env.OPENROUTER_API_KEYS);
        this.apiKey = this.apiKeys[0]; // back-compat: first key
        this.model = model;
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.referer = referer;
        this.title = title;
        this.timeoutMs = Number(timeoutMs) || DEFAULT_TIMEOUT_MS;
    }

    // Round-robin: each call advances the shared cursor so consecutive requests
    // (and retries within one request) land on different keys.
    #nextKey() {
        if (!this.apiKeys.length) return undefined;
        const key = this.apiKeys[this.#keyCursor % this.apiKeys.length];
        this.#keyCursor += 1;
        return key;
    }

    // Errors worth retrying on the next key: rate limit, auth/credit, and
    // transient upstream failures.
    #canRotate(status) {
        return [401, 402, 403, 408, 409, 425, 429].includes(status) || status >= 500;
    }

    async chat({
        messages,
        tools,
        model = this.model,
        temperature = 0.2,
        maxTokens,
        reasoning,
        reasoningEffort,
        verbosity,
        plugins,
        extraArgs,
        stream = false,
        onDelta,
        signal,
    }) {
        if (!this.apiKeys.length) {
            throw new Error('Missing OPENROUTER_API_KEY. Set it in .env or pass --api-key.');
        }

        const body = removeUndefined({
            model,
            messages,
            tools,
            tool_choice: tools?.length ? 'auto' : undefined,
            temperature,
            max_tokens: maxTokens,
            reasoning,
            reasoning_effort: reasoningEffort,
            verbosity,
            plugins,
            ...(extraArgs || {}),
        });

        if (stream) return this.#streamChat(body, onDelta, signal);

        return this.#request('/chat/completions', {
            method: 'POST',
            body: JSON.stringify(body),
            signal,
        });
    }

    // Streaming chat: parses SSE deltas, invokes onDelta for live output, and
    // reassembles a non-streaming-shaped { choices: [{ message }], usage }.
    async #streamChat(body, onDelta = () => {}, signal) {
        const payload = JSON.stringify({
            ...body,
            stream: true,
            stream_options: { include_usage: true },
        });
        const attempts = Math.max(this.apiKeys.length, 1);

        // Rotate keys for the initial connection; once a key returns a streaming
        // body we commit to it (deltas can't be replayed mid-stream).
        let response;
        let controller;
        let timeout;
        let didTimeout = false;
        let lastError;

        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const apiKey = this.#nextKey();
            controller = new AbortController();
            didTimeout = false;
            timeout = setTimeout(() => {
                didTimeout = true;
                controller.abort();
            }, this.timeoutMs);
            const combinedSignal = combineSignals(signal, controller.signal);

            let candidate;
            try {
                candidate = await fetch(`${this.baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: this.#headers(apiKey),
                    body: payload,
                    signal: combinedSignal,
                });
            } catch (error) {
                clearTimeout(timeout);
                if (isAbortError(error)) {
                    if (didTimeout) {
                        throw new Error(
                            `OpenRouter request timed out after ${this.timeoutMs}ms. ` +
                                'Increase --timeout-ms / OPENROUTER_TIMEOUT_MS or choose a faster model.'
                        );
                    }
                    throw new Error('OpenRouter request was aborted by the caller.');
                }
                if (attempt < attempts - 1) {
                    lastError = error;
                    continue;
                }
                throw error;
            }

            if (!candidate.ok || !candidate.body) {
                const text = await candidate.text();
                const data = text ? safeJson(text) : {};
                const message = data?.error?.message || data?.message || text || candidate.statusText;
                clearTimeout(timeout);
                if (this.#canRotate(candidate.status) && attempt < attempts - 1) {
                    lastError = new Error(`OpenRouter ${candidate.status}: ${message}`);
                    continue; // try the next key
                }
                throw new Error(`OpenRouter ${candidate.status}: ${message}`);
            }

            response = candidate;
            break; // committed; `timeout` stays armed and is cleared in finally
        }

        if (!response) throw lastError || new Error('OpenRouter request failed');

        try {
            const message = { role: 'assistant', content: '', reasoning: '', tool_calls: [] };
            let usage;
            let finishReason = null;

            for await (const event of parseSseStream(response.body)) {
                if (event === '[DONE]') break;
                const chunk = safeJson(event);
                if (chunk?.usage) usage = chunk.usage;
                const choice = chunk?.choices?.[0];
                if (!choice) continue;
                if (choice.finish_reason) finishReason = choice.finish_reason;
                const delta = choice.delta || {};

                if (delta.content) {
                    message.content += delta.content;
                    onDelta({ type: 'text', text: delta.content });
                }
                if (typeof delta.reasoning === 'string' && delta.reasoning) {
                    message.reasoning += delta.reasoning;
                    onDelta({ type: 'reasoning', text: delta.reasoning });
                }
                for (const call of delta.tool_calls || []) {
                    const slot = (message.tool_calls[call.index] ||= {
                        id: call.id,
                        type: 'function',
                        function: { name: '', arguments: '' },
                    });
                    if (call.id) slot.id = call.id;
                    if (call.function?.name) slot.function.name += call.function.name;
                    if (call.function?.arguments) slot.function.arguments += call.function.arguments;
                }
            }

            if (!message.reasoning) delete message.reasoning;
            if (!message.tool_calls.length) delete message.tool_calls;

            return { choices: [{ message, finish_reason: finishReason }], usage };
        } catch (error) {
            if (isAbortError(error)) {
                if (didTimeout) {
                    throw new Error(
                        `OpenRouter request timed out after ${this.timeoutMs}ms. ` +
                            'Increase --timeout-ms / OPENROUTER_TIMEOUT_MS or choose a faster model.'
                    );
                }
                throw new Error('OpenRouter request was aborted by the caller.');
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    #headers(apiKey, authOptional = false) {
        const headers = {
            'Content-Type': 'application/json',
            'X-OpenRouter-Title': this.title,
        };
        if (this.referer) headers['HTTP-Referer'] = this.referer;
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        if (!apiKey && !authOptional) {
            throw new Error('Missing OPENROUTER_API_KEY. Set it in .env or pass --api-key.');
        }
        return headers;
    }

    async listModels({ signal } = {}) {
        const data = await this.#request('/models', {
            method: 'GET',
            signal,
            authOptional: true,
        });
        return data.data || [];
    }

    async #request(path, { method, body, signal, authOptional = false }) {
        const attempts = Math.max(this.apiKeys.length, 1);
        let lastError;

        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const apiKey = this.#nextKey();
            const controller = new AbortController();
            let didTimeout = false;
            const timeout = setTimeout(() => {
                didTimeout = true;
                controller.abort();
            }, this.timeoutMs);
            const combinedSignal = combineSignals(signal, controller.signal);

            try {
                const response = await fetch(`${this.baseUrl}${path}`, {
                    method,
                    headers: this.#headers(apiKey, authOptional),
                    body,
                    signal: combinedSignal,
                });

                const text = await response.text();
                const data = text ? safeJson(text) : {};
                if (!response.ok) {
                    const message =
                        data?.error?.message || data?.message || text || response.statusText;
                    if (this.#canRotate(response.status) && attempt < attempts - 1) {
                        lastError = new Error(`OpenRouter ${response.status}: ${message}`);
                        continue; // try the next key
                    }
                    throw new Error(`OpenRouter ${response.status}: ${message}`);
                }
                // OpenRouter sometimes returns HTTP 200 with a provider error in
                // the body and no choices — treat it as a rotatable failure.
                if (data?.error && !data.choices?.length) {
                    const status = Number(data.error.status || data.error.code) || 502;
                    const message = data.error.message || 'provider error';
                    if (this.#canRotate(status) && attempt < attempts - 1) {
                        lastError = new Error(`OpenRouter ${status}: ${message}`);
                        continue; // try the next key
                    }
                    throw new Error(`OpenRouter ${status}: ${message}`);
                }
                return data;
            } catch (error) {
                if (isAbortError(error)) {
                    if (didTimeout) {
                        throw new Error(
                            `OpenRouter request timed out after ${this.timeoutMs}ms. ` +
                                'Increase --timeout-ms / OPENROUTER_TIMEOUT_MS, choose a faster model, or disable server web tools with --no-web-search --no-web-fetch.'
                        );
                    }
                    throw new Error('OpenRouter request was aborted by the caller.');
                }
                // Network/transport failure: try the next key if any remain.
                if (attempt < attempts - 1) {
                    lastError = error;
                    continue;
                }
                throw error;
            } finally {
                clearTimeout(timeout);
            }
        }

        throw lastError || new Error('OpenRouter request failed');
    }
}

// Parse an SSE response body into a stream of `data:` payload strings.
async function* parseSseStream(body) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (line.startsWith('data:')) yield line.slice(5).trim();
        }
    }
    const tail = buffer.trim();
    if (tail.startsWith('data:')) yield tail.slice(5).trim();
}

function safeJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return { raw: text };
    }
}

function removeUndefined(value) {
    if (Array.isArray(value)) return value.map(removeUndefined);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .map(([key, item]) => [key, removeUndefined(item)])
    );
}

function combineSignals(...signals) {
    const validSignals = signals.filter(Boolean);
    if (validSignals.length === 0) return undefined;
    if (validSignals.length === 1) return validSignals[0];
    if (AbortSignal.any) return AbortSignal.any(validSignals);

    const controller = new AbortController();
    for (const signal of validSignals) {
        if (signal.aborted) {
            controller.abort();
            break;
        }
        signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    return controller.signal;
}

function isAbortError(error) {
    return (
        error?.name === 'AbortError' ||
        error?.code === 'ABORT_ERR' ||
        error?.message === 'This operation was aborted'
    );
}

function numberFromEnv(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

// Collect API keys from arrays and/or comma/newline-separated strings, trim,
// drop blanks, and dedupe (preserving order).
function parseKeys(...sources) {
    const keys = [];
    const seen = new Set();
    const add = (raw) => {
        const key = String(raw).trim();
        if (key && !seen.has(key)) {
            seen.add(key);
            keys.push(key);
        }
    };
    for (const source of sources) {
        if (!source) continue;
        if (Array.isArray(source)) source.forEach(add);
        else String(source).split(/[\n,]/).forEach(add);
    }
    return keys;
}
