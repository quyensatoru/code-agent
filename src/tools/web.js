import { USER_AGENT, truncate } from './shared.js';

// Local web tools: WebFetch (HTML -> text extraction) and WebSearch (Tavily
// when TAVILY_API_KEY is set, DuckDuckGo HTML best-effort otherwise).

export const webToolDefinitions = [
    {
        type: 'function',
        function: {
            name: 'WebFetch',
            description:
                'Fetch a URL and return extracted text. Use for docs, issues, and web pages.',
            parameters: {
                type: 'object',
                required: ['url'],
                properties: {
                    url: { type: 'string' },
                    max_chars: {
                        type: 'integer',
                        minimum: 1000,
                        maximum: 60000,
                        default: 16000,
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'WebSearch',
            description:
                'Search the web. Uses Tavily when TAVILY_API_KEY is set, otherwise DuckDuckGo HTML best-effort.',
            parameters: {
                type: 'object',
                required: ['query'],
                properties: {
                    query: { type: 'string' },
                    allowed_domains: { type: 'array', items: { type: 'string' } },
                    blocked_domains: { type: 'array', items: { type: 'string' } },
                    max_results: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
                },
            },
        },
    },
];

export function createWebHandlers() {
    return { WebFetch: webFetch, WebSearch: webSearch };
}

async function webFetch({ url, max_chars: maxChars = 16000 }) {
    const target = parseHttpUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
        const response = await fetch(target, {
            signal: controller.signal,
            headers: {
                'user-agent': USER_AGENT,
                accept: 'text/html,text/plain,application/json,*/*',
            },
        });
        const contentType = response.headers.get('content-type') || '';
        const raw = await response.text();
        const text = contentType.includes('html') ? htmlToText(raw) : raw;
        const title = contentType.includes('html') ? extractTitle(raw) : undefined;
        return {
            url: target,
            status: response.status,
            ok: response.ok,
            content_type: contentType,
            title,
            content: truncate(text.trim(), maxChars),
            truncated: text.trim().length > maxChars,
        };
    } finally {
        clearTimeout(timeout);
    }
}

async function webSearch({
    query,
    allowed_domains: allowedDomains = [],
    blocked_domains: blockedDomains = [],
    max_results: maxResults = 5,
}) {
    if (!query) throw new Error('query is required');
    const limit = Math.min(Math.max(Number(maxResults) || 5, 1), 20);
    const results = process.env.TAVILY_API_KEY
        ? await tavilySearch(query, limit, allowedDomains, blockedDomains)
        : await duckDuckGoSearch(query, limit);
    const filtered = results
        .filter((result) => domainAllowed(result.url, allowedDomains, blockedDomains))
        .slice(0, limit);
    return {
        query,
        provider: process.env.TAVILY_API_KEY ? 'tavily' : 'duckduckgo-html',
        results: filtered,
    };
}

async function tavilySearch(query, limit, allowedDomains = [], blockedDomains = []) {
    const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
            'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
            query,
            max_results: limit,
            search_depth: process.env.TAVILY_SEARCH_DEPTH || 'basic',
            include_answer: false,
            include_raw_content: false,
            include_domains: allowedDomains,
            exclude_domains: blockedDomains,
        }),
    });
    const data = await response.json();
    if (!response.ok)
        throw new Error(
            `Tavily Search ${response.status}: ${
                data?.detail?.error || data?.detail || data?.error || response.statusText
            }`
        );
    return (data.results || []).map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.content,
        score: item.score,
    }));
}

async function duckDuckGoSearch(query, limit) {
    const url = new URL('https://duckduckgo.com/html/');
    url.searchParams.set('q', query);
    const response = await fetch(url, {
        headers: {
            accept: 'text/html',
            'user-agent': USER_AGENT,
        },
    });
    const html = await response.text();
    if (!response.ok) throw new Error(`DuckDuckGo ${response.status}: ${response.statusText}`);
    return parseDuckDuckGoHtml(html).slice(0, limit);
}

function parseDuckDuckGoHtml(html) {
    const results = [];
    const blocks = html.split(/<div class="result results_links[^"]*"/i).slice(1);
    for (const block of blocks) {
        const linkMatch = block.match(
            /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i
        );
        if (!linkMatch) continue;
        const snippetMatch = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
        results.push({
            title: htmlDecode(stripTags(linkMatch[2])).trim(),
            url: unwrapDuckDuckGoUrl(htmlDecode(linkMatch[1])),
            snippet: htmlDecode(stripTags(snippetMatch?.[1] || '')).trim(),
        });
    }
    return results;
}

function unwrapDuckDuckGoUrl(value) {
    try {
        const url = value.startsWith('//') ? new URL(`https:${value}`) : new URL(value);
        const uddg = url.searchParams.get('uddg');
        return uddg || value;
    } catch {
        return value;
    }
}

function parseHttpUrl(url) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol))
        throw new Error('Only http/https URLs are supported');
    return parsed.toString();
}

function domainAllowed(url, allowedDomains, blockedDomains) {
    let host;
    try {
        host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return false;
    }
    const allowed = allowedDomains.map((domain) => domain.replace(/^www\./, ''));
    const blocked = blockedDomains.map((domain) => domain.replace(/^www\./, ''));
    if (allowed.length && !allowed.some((domain) => host === domain || host.endsWith(`.${domain}`)))
        return false;
    return !blocked.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function extractTitle(html) {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return match ? htmlDecode(stripTags(match[1])).trim() : undefined;
}

export function htmlToText(html) {
    return htmlDecode(
        html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/[ \t]{2,}/g, ' ')
    );
}

function stripTags(value) {
    return value.replace(/<[^>]+>/g, ' ');
}

function htmlDecode(value) {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&nbsp;/g, ' ');
}
