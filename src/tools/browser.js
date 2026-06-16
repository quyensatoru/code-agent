import { promises as fs } from 'node:fs';
import path from 'node:path';

// BrowserSnapshot: load a URL in a real headless browser and return what a
// text-only model can act on — console errors, page errors, failed network
// requests, the page title, and the rendered visible text — plus a screenshot
// saved under .oragent/snapshots/ for the human (or a follow-up run with
// --image, which routes it through the perception model).
//
// Requires playwright or puppeteer to be installed in the project; the import
// is lazy so the harness has no hard dependency on either.

const SNAPSHOT_DIR = path.join('.oragent', 'snapshots');
const MAX_TEXT_CHARS = 8000;
const MAX_LOG_ENTRIES = 40;

export const browserToolDefinitions = [
    {
        type: 'function',
        function: {
            name: 'BrowserSnapshot',
            description:
                'Open a URL in a headless browser and return runtime diagnostics: console errors/warnings, uncaught page errors, failed network requests, page title, and the rendered visible text. Also saves a screenshot under .oragent/snapshots/ (tell the user the path — rerun with --image <path> to let the perception model read it). Use this to debug web UI issues that WebFetch (raw HTML) cannot see, e.g. blank pages, JS errors, broken layouts.',
            parameters: {
                type: 'object',
                required: ['url'],
                properties: {
                    url: { type: 'string', description: 'http(s) URL, e.g. a local dev server.' },
                    wait_ms: {
                        type: 'integer',
                        minimum: 0,
                        maximum: 30000,
                        default: 1000,
                        description: 'Extra settle time after load, for client-side rendering.',
                    },
                    viewport_width: { type: 'integer', minimum: 320, maximum: 3840, default: 1280 },
                    viewport_height: { type: 'integer', minimum: 240, maximum: 2160, default: 800 },
                    full_page: { type: 'boolean', default: true },
                    selector: {
                        type: 'string',
                        description: 'Optional CSS selector — also return the matching element’s text/HTML.',
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

async function snapshot(
    root,
    {
        url,
        wait_ms: waitMs = 1000,
        viewport_width: width = 1280,
        viewport_height: height = 800,
        full_page: fullPage = true,
        selector,
    }
) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Only http/https URLs are supported');
    }

    const { kind, browser } = await launchBrowser();
    const consoleLogs = [];
    const pageErrors = [];
    const failedRequests = [];

    try {
        const page = await browser.newPage();
        if (kind === 'playwright') await page.setViewportSize({ width, height });
        else await page.setViewport({ width, height });

        page.on('console', (msg) => {
            const type = msg.type();
            if (consoleLogs.length < MAX_LOG_ENTRIES && ['error', 'warning', 'warn'].includes(type)) {
                consoleLogs.push(`[${type}] ${msg.text()}`);
            }
        });
        page.on('pageerror', (error) => {
            if (pageErrors.length < MAX_LOG_ENTRIES) pageErrors.push(String(error?.message || error));
        });
        page.on('requestfailed', (request) => {
            if (failedRequests.length < MAX_LOG_ENTRIES) {
                const failure =
                    kind === 'playwright' ? request.failure()?.errorText : request.failure()?.errorText;
                failedRequests.push(`${request.method()} ${request.url()} — ${failure || 'failed'}`);
            }
        });
        page.on('response', (response) => {
            if (failedRequests.length < MAX_LOG_ENTRIES && response.status() >= 400) {
                failedRequests.push(`${response.status()} ${response.url()}`);
            }
        });

        await page.goto(parsed.toString(), {
            waitUntil: kind === 'playwright' ? 'networkidle' : 'networkidle2',
            timeout: 30000,
        });
        if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));

        const title = await page.title();
        const bodyText = await page.evaluate(() => document.body?.innerText || '');

        let selected;
        if (selector) {
            selected = await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (!el) return null;
                return { text: el.innerText || '', html: el.outerHTML.slice(0, 4000) };
            }, selector);
        }

        const dir = path.join(root, SNAPSHOT_DIR);
        await fs.mkdir(dir, { recursive: true });
        const screenshotPath = path.join(
            dir,
            `${new Date().toISOString().replace(/[:.]/g, '-')}.png`
        );
        await page.screenshot({ path: screenshotPath, fullPage });

        return {
            url: parsed.toString(),
            engine: kind,
            title,
            screenshot: path.relative(root, screenshotPath),
            console_errors: consoleLogs,
            page_errors: pageErrors,
            failed_requests: failedRequests,
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
