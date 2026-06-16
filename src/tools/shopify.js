import { USER_AGENT, truncate } from './shared.js';

// ShopifyAdminGraphQL — read-only window into a merchant's shop via the Admin
// GraphQL API: app installation, granted scopes, theme app extension / app
// embed status, webhook subscriptions, billing, etc. Mutations are rejected.
//
// The per-shop access token is the app's offline token for that merchant. The
// agent usually reads it from the app's own DB first (SqlQuery/MongoQuery on a
// shops/stores table) and passes it here as access_token; SHOPIFY_ACCESS_TOKEN
// /SHOPIFY_SHOP serve as a single-shop fallback for local testing.

const DEFAULT_API_VERSION = '2025-01';

export const shopifyToolDefinitions = [
    {
        type: 'function',
        function: {
            name: 'ShopifyAdminGraphQL',
            description:
                "Run a READ-ONLY Shopify Admin GraphQL query for one shop and return data. Use it to check app/shop state behind an issue: app installation & granted scopes (currentAppInstallation), theme app extension / app embed status, webhookSubscriptions, billing, products/orders. Mutations are rejected. Get the shop's access_token from the app DB first (SqlQuery/MongoQuery on the shops table), then pass shop + access_token.",
            parameters: {
                type: 'object',
                required: ['query'],
                properties: {
                    query: { type: 'string', description: 'A GraphQL query (not a mutation).' },
                    shop: { type: 'string', description: 'Shop domain, e.g. my-store.myshopify.com (or just my-store). Falls back to SHOPIFY_SHOP.' },
                    access_token: { type: 'string', description: "The shop's Admin API access token. Falls back to SHOPIFY_ACCESS_TOKEN." },
                    variables: { type: 'object', description: 'GraphQL variables.' },
                    api_version: { type: 'string', description: `Admin API version. Default ${DEFAULT_API_VERSION}.` },
                },
            },
        },
    },
];

export function createShopifyHandlers() {
    return { ShopifyAdminGraphQL: shopifyAdminGraphQL };
}

export function normalizeShopDomain(shop) {
    const host = String(shop || '')
        .trim()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '');
    if (!host) throw new Error('shop is required (e.g. my-store.myshopify.com)');
    return host.includes('.') ? host : `${host}.myshopify.com`;
}

export function assertReadOnlyGraphQL(query) {
    const text = String(query || '').trim();
    if (!text) throw new Error('Empty GraphQL query');
    const stripped = text.replace(/#[^\n]*/g, ' '); // drop GraphQL comments
    if (/\b(mutation|subscription)\b/i.test(stripped)) {
        throw new Error('Only read-only GraphQL queries are allowed (mutation/subscription rejected)');
    }
    return text;
}

async function shopifyAdminGraphQL({
    query,
    shop = process.env.SHOPIFY_SHOP,
    access_token: accessToken = process.env.SHOPIFY_ACCESS_TOKEN,
    variables,
    api_version: apiVersion = process.env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION,
}) {
    const host = normalizeShopDomain(shop);
    if (!accessToken) {
        throw new Error(
            "No access token. Read the shop's token from the app DB (SqlQuery/MongoQuery), then pass access_token — or set SHOPIFY_ACCESS_TOKEN."
        );
    }
    const safe = assertReadOnlyGraphQL(query);
    const url = `https://${host}/admin/api/${apiVersion}/graphql.json`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
        const response = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'content-type': 'application/json',
                'x-shopify-access-token': accessToken,
                'user-agent': USER_AGENT,
            },
            body: JSON.stringify({ query: safe, variables: variables || undefined }),
        });
        const text = await response.text();
        const json = text ? safeJson(text) : {};
        return {
            shop: host,
            api_version: apiVersion,
            status: response.status,
            ok: response.ok,
            data: json.data,
            errors: json.errors,
            ...(response.ok ? {} : { body: truncate(text, 2000) }),
        };
    } finally {
        clearTimeout(timeout);
    }
}

function safeJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return { raw: text };
    }
}
