// Context window management for long-running sessions. Two layers:
//
// 1. trimOldToolResults — cheap "microcompaction": large tool outputs that are
//    older than the recent tail get truncated in place (the model has already
//    acted on them; keeping 24kB of old grep output buys nothing).
// 2. compact — real compaction: when the estimated context size crosses the
//    threshold, everything before the recent tail is summarized by the model
//    into a single system message and replaced, mirroring the SDK's
//    auto-compaction / compact_boundary behavior.
//
// Token counts are estimated at ~4 chars/token; this is intentionally rough —
// the thresholds are soft limits, not billing math.

const CHARS_PER_TOKEN = 4;

export function estimateTokens(messages = []) {
    let chars = 0;
    for (const message of messages) chars += messageChars(message);
    return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function messageChars(message) {
    let chars = 0;
    const content = message.content;
    if (typeof content === 'string') chars += content.length;
    else if (Array.isArray(content)) {
        for (const part of content) {
            chars += typeof part.text === 'string' ? part.text.length : 400;
        }
    }
    for (const call of message.tool_calls || []) {
        chars += (call.function?.name?.length || 0) + (call.function?.arguments?.length || 0) + 40;
    }
    return chars;
}

export function trimOldToolResults(messages, { keepTail = 12, maxChars = 2000 } = {}) {
    const cutoff = Math.max(messages.length - keepTail, 1);
    return messages.map((message, index) => {
        if (index === 0 || index >= cutoff) return message;
        if (message.role !== 'tool' || typeof message.content !== 'string') return message;
        if (message.content.length <= maxChars) return message;
        return {
            ...message,
            content: `${message.content.slice(0, maxChars)}\n[older tool output trimmed: ${
                message.content.length - maxChars
            } chars]`,
        };
    });
}

// Pick the index where the kept tail starts. Never split an assistant
// tool-call from its tool results: if the boundary lands on a `tool` message,
// walk back until the owning assistant message is inside the tail.
export function findCompactBoundary(messages, keepRecent = 12) {
    let start = Math.max(messages.length - keepRecent, 1);
    while (start > 1 && messages[start]?.role === 'tool') start -= 1;
    return start;
}

const SUMMARY_PROMPT = `You summarize an in-progress coding-agent session so the agent can continue with much less context. Produce a dense, factual summary capturing:
1. The user's task(s), requirements, and constraints.
2. Work completed so far: files read/created/modified (with paths), commands run and their outcomes.
3. Key findings, decisions, and the reasons behind them.
4. Current state and what remains to be done (including open todos).
5. Errors hit and how they were (or weren't) resolved.
Use markdown lists. Be specific with file paths and identifiers. Never invent details that are not in the transcript.`;

export async function compact({
    client,
    model,
    messages,
    keepRecent = 12,
    maxSummaryTokens = 1500,
    signal,
}) {
    const start = findCompactBoundary(messages, keepRecent);
    const old = messages.slice(1, start);
    if (old.length < 6) return null; // not enough history to be worth a model call

    const transcript = old.map(serializeForSummary).join('\n\n');
    const response = await client.chat({
        model,
        messages: [
            { role: 'system', content: SUMMARY_PROMPT },
            { role: 'user', content: truncateMiddle(transcript, 240000) },
        ],
        temperature: 0.1,
        maxTokens: maxSummaryTokens,
        signal,
    });
    const summary = response?.choices?.[0]?.message?.content?.trim();
    if (!summary) throw new Error('compaction model returned no summary');

    const summaryMessage = {
        role: 'system',
        content: `[Context auto-compacted. Summary of the earlier conversation]\n${summary}`,
    };
    return {
        messages: [messages[0], summaryMessage, ...messages.slice(start)],
        summary,
    };
}

function serializeForSummary(message) {
    let text =
        typeof message.content === 'string'
            ? message.content
            : Array.isArray(message.content)
              ? message.content.map((part) => part.text || '').join('\n')
              : '';
    if (message.tool_calls?.length) {
        text += `\n${message.tool_calls
            .map(
                (call) =>
                    `[tool_call ${call.function?.name} ${clip(call.function?.arguments || '', 300)}]`
            )
            .join('\n')}`;
    }
    return `${String(message.role || '').toUpperCase()}: ${clip(text, 4000)}`;
}

function clip(text, max) {
    return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function truncateMiddle(text, max) {
    if (text.length <= max) return text;
    const half = Math.floor(max / 2);
    return `${text.slice(0, half)}\n[... middle of transcript omitted ...]\n${text.slice(-half)}`;
}
