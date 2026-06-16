import { promises as fs } from 'node:fs';
import path from 'node:path';

// BrowserSnapshot — the "open DevTools and look" evidence tool. It loads a URL
// in a real headless browser, optionally injects credentials and replays a few
// interactions, then returns what a text-only model can act on:
//   - network log: every request (method/url/status/type/ms) + XHR/fetch
//     response bodies (DevTools Network tab)
//   - console errors/warnings and uncaught page errors
//   - page title, rendered visible text, an optional selector's text/HTML
//   - a screenshot saved under .oragent/snapshots/ (rerun with --image to let
//     the perception model read it)
//
// Requires playwright or puppeteer in the project; imported lazily so the
// harness has no hard dependency on either.

const SNAPSHOT_DIR = path.join('.oragent', 'snapshots');
const MAX_TEXT_CHARS = 8000;
const MAX_LOG_ENTRIES = 60;
const MAX_NETWORK_ENTRIES = 120;
const MAX_BODY_CHARS = 4000;

export const browserToolDefinitions = [
    {
        type: 'function',
        function: {
            name: 'BrowserSnapshot',
            description:
                'Open a URL in a headless browser and capture runtime evidence: a network log (requests + status + XHR/fetch response bodies), console errors/warnings, uncaught page errors, page title, and rendered visible text. Replays optional actions (click/type/wait) to reach a state first, and can inject headers/cookies/localStorage for authed targets. Saves a screenshot under .oragent/snapshots/ (tell the user the path — rerun with --image <path> to read it). Use this for web/UI issues that raw HTML (WebFetch) cannot see: blank pages, JS errors, broken data loads, missing elements.',
            parameters: {
                type: 'object',
                required: ['url'],
                properties: {
                    url: { type: 'string', description: 'http(s) URL, e.g. a local dev server or live page.' },
                    wait_ms: {
                        type: 'integer',
                        minimum: 0,
                        maximum: 30000,
                        default: 1000,
                        description: 'Extra settle time after load/actions, for client-side rendering.',
                    },
                    viewport_width: { type: 'integer', minimum: 320, maximum: 3840, default: 1280 },
                    viewport_height: { type: 'integer', minimum: 240, maximum: 2160, default: 800 },
                    full_page: { type: 'boolean', default: true },
                    selector: {
                        type: 'string',
                        description: 'Optional CSS selector — also return the matching element’s text/HTML (e.g. check the heatmap canvas exists).',
                    },
                    actions: {
                        type: 'array',
                        description: 'Ordered interactions to replay BEFORE capturing, to reproduce a multi-step state.',
                        items: {
                            type: 'object',
                            required: ['type'],
                            properties: {
                                type: { type: 'string', enum: ['click', 'type', 'wait_for', 'goto', 'scroll'] },
                                selector: { type: 'string', description: 'CSS selector for click/type/wait_for.' },
                                text: { type: 'string', description: 'Text to type (type action).' },
                                url: { type: 'string', description: 'URL for a goto action.' },
                                ms: { type: 'integer', minimum: 0, maximum: 30000, description: 'Delay for a wait_for action.' },
                            },
                        },
                    },
                    network_filter: {
                        type: 'string',
                        description: 'Only capture response bodies for request URLs containing this substring (e.g. "/api/").',
                    },
                    headers: {
                        type: 'object',
                        description: 'Extra HTTP headers for every request, e.g. { "Authorization": "Bearer ..." }.',
                    },
                    cookies: {
                        type: 'array',
                        description: 'Cookies to set before loading, for authed targets.',
                        items: {
                            type: 'object',
                            required: ['name', 'value'],
                            properties: {
                                name: { type: 'string' },
                                value: { type: 'string' },
                                domain: { type: 'string' },
                                path: { type: 'string' },
                            },
                        },
                    },
                    local_storage: {
                        type: 'object',
                        description: 'localStorage key/value pairs to seed before loading (e.g. an auth token).',
                    },
                },
            },
        },
    },
];

export function createBrowserHandlers({ root }) {
    return {
        BrowserSnapshot: (args) => snapshot(root, args),
    };
}

async function snapshot(root, args) {
    const {
        url,
        wait_ms: waitMs = 1000,
        viewport_width: width = 1280,
        viewport_height: height = 800,
        full_page: fullPage = true,
        selector,
        actions = [],
        network_filter: networkFilter,
        headers,
        cookies = [],
        local_storage: localStorage,
    } = args;

    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Only http/https URLs are supported');
    }

    const { kind, browser } = await launchBrowser();
    const console_errors = [];
    const page_errors = [];
    const network = [];

    try {
        const page = await browser.newPage();
        if (kind === 'playwright') await page.setViewportSize({ width, height });
        else await page.setViewport({ width, height });

        if (headers && Object.keys(headers).length) await page.setExtraHTTPHeaders(headers);
        if (cookies.length) await setCookies(kind, browser, page, cookies, parsed);

        page.on('console', (msg) => {
            const type = msg.type();
            if (console_errors.length < MAX_LOG_ENTRIES && ['error', 'warning', 'warn'].includes(type)) {
                console_errors.push(`[${type}] ${msg.text()}`);
            }
        });
        page.on('pageerror', (error) => {
            if (page_errors.length < MAX_LOG_ENTRIES) page_errors.push(String(error?.message || error));
        });
        captureNetwork(kind, page, network, networkFilter);

        if (localStorage && Object.keys(localStorage).length) {
            await seedLocalStorage(page, parsed.origin, localStorage);
        }

        await page.goto(parsed.toString(), {
            waitUntil: kind === 'playwright' ? 'networkidle' : 'networkidle2',
            timeout: 30000,
        });
        const actionLog = await runActions(page, actions);
        if (waitMs) await sleep(waitMs);

        const title = await page.title();
        const bodyText = await page.evaluate(() => document.body?.innerText || '');
        let selected;
        if (selector) {
            selected = await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                return el ? { text: el.innerText || '', html: el.outerHTML.slice(0, 4000) } : null;
            }, selector);
        }

        const dir = path.join(root, SNAPSHOT_DIR);
        await fs.mkdir(dir, { recursive: true });
        const screenshotPath = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
        await page.screenshot({ path: screenshotPath, fullPage });

        return {
            url: parsed.toString(),
            engine: kind,
            title,
            screenshot: path.relative(root, screenshotPath),
            actions: actionLog,
            console_errors,
            page_errors,
            network: network.slice(0, MAX_NETWORK_ENTRIES),
            network_truncated: network.length > MAX_NETWORK_ENTRIES,
            ...(selector ? { selector, selected: selected || 'no element matched' } : {}),
            visible_text:
                bodyText.length > MAX_TEXT_CHARS
                    ? `${bodyText.slice(0, MAX_TEXT_CHARS)}\n[truncated ${bodyText.length - MAX_TEXT_CHARS} chars]`
                    : bodyText,
        };
    } finally {
        await browser.close().catch(() => {});
    }
}

// Record every request's outcome; for XHR/fetch responses, also capture the
// (filtered, truncated) body — the part that usually reveals a data-load bug.
function captureNetwork(kind, page, network, filter) {
    const want = (url) => !filter || url.includes(filter);
    page.on('requestfailed', (request) => {
        if (network.length < MAX_NETWORK_ENTRIES) {
            network.push({
                method: request.method(),
                url: request.url(),
                status: 'failed',
                error: request.failure()?.errorText || 'failed',
            });
        }
    });
    page.on('response', async (response) => {
        if (network.length >= MAX_NETWORK_ENTRIES) return;
        const request = response.request();
        const type = request.resourceType();
        const entry = { method: request.method(), url: response.url(), status: response.status(), type };
        if (['xhr', 'fetch'].includes(type) && want(response.url())) {
            try {
                entry.body = (await response.text()).slice(0, MAX_BODY_CHARS);
            } catch {
                // body not available (opaque/streamed) — keep the status line
            }
        }
        network.push(entry);
    });
}

async function runActions(page, actions) {
    const log = [];
    for (const action of actions) {
        try {
            if (action.type === 'goto') await page.goto(action.url, { timeout: 30000 });
            else if (action.type === 'click') await page.click(action.selector);
            else if (action.type === 'type') await page.type(action.selector, action.text || '');
            else if (action.type === 'scroll') {
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            } else if (action.type === 'wait_for') {
                if (action.selector) await page.waitForSelector(action.selector, { timeout: 15000 });
                else await sleep(action.ms ?? 1000);
            }
            log.push(`ok: ${describeAction(action)}`);
        } catch (error) {
            log.push(`FAILED: ${describeAction(action)} — ${error.message}`);
            break; // a broken step makes later ones meaningless
        }
    }
    return log;
}

function describeAction(action) {
    return [action.type, action.selector, action.url, action.text && JSON.stringify(action.text)]
        .filter(Boolean)
        .join(' ');
}

async function setCookies(kind, browser, page, cookies, parsed) {
    const withDefaults = cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain || parsed.hostname,
        path: c.path || '/',
    }));
    if (kind === 'playwright') await browser.contexts?.()?.[0]?.addCookies?.(withDefaults);
    else await page.setCookie(...withDefaults);
}

async function seedLocalStorage(page, origin, entries) {
    // Navigate to the origin first so localStorage is writable, then seed it.
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.evaluate((kv) => {
        for (const [key, value] of Object.entries(kv)) window.localStorage.setItem(key, String(value));
    }, entries);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function launchBrowser() {
    try {
        const playwright = await import('playwright');
        return { kind: 'playwright', browser: await playwright.chromium.launch() };
    } catch (error) {
        if (!isModuleNotFound(error)) throw error;
    }
    try {
        const puppeteer = await import('puppeteer');
        return { kind: 'puppeteer', browser: await puppeteer.default.launch() };
    } catch (error) {
        if (!isModuleNotFound(error)) throw error;
    }
    throw new Error(
        'BrowserSnapshot requires a headless browser package. Install one of:\n' +
            '  npm i -D playwright && npx playwright install chromium\n' +
            '  npm i -D puppeteer'
    );
}

function isModuleNotFound(error) {
    return error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND';
}
