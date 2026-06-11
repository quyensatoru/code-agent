import { query } from './query.js';
import { SYSTEM_PROMPT } from './options.js';

// Back-compat re-export: callers previously imported SYSTEM_PROMPT from here.
export { SYSTEM_PROMPT };

// Thin wrapper preserving the legacy runAgent({...}) -> { result, sessionId,
// usage, messages } shape and the legacy onEvent stream. New code should use
// query() directly. This adapts the SDK message stream back to the old events
// (turn/tool_start/tool_end already flow through options.onEvent; here we add
// assistant/reasoning/final).
export async function runAgent({ prompt, onEvent = () => {}, ...rest } = {}) {
    if (!prompt) throw new Error('Prompt is required');

    const collected = [];
    let result = '';
    let sessionId;
    let usage = null;

    for await (const message of query({ prompt, options: { ...rest, onEvent } })) {
        collected.push(message);

        if (message.type === 'system' && message.subtype === 'init') {
            sessionId = message.session_id;
        } else if (message.type === 'assistant') {
            for (const block of message.message.content || []) {
                if (block.type === 'thinking' && block.thinking) {
                    onEvent({ type: 'reasoning', content: block.thinking });
                }
                if (block.type === 'text' && block.text) {
                    onEvent({ type: 'assistant', content: block.text });
                }
            }
        } else if (message.type === 'result') {
            sessionId = message.session_id;
            usage = message.usage;
            result = message.subtype === 'success' ? message.result : (message.errors || []).join('\n');
            onEvent({ type: 'final', result, sessionId, usage });
        }
    }

    return { result, sessionId, usage, messages: collected };
}
