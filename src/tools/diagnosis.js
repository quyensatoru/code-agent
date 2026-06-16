// ReportDiagnosis — the structured conclusion of the support agent: which layer
// of the Shopify embedded app the issue lives in, the root cause, the evidence
// that proves it, and where to route it. Read-only (records the conclusion);
// the orchestrator (src/support) reads it and, when route is "code_fix", hands
// off to the coding/fix flow.

export const DIAGNOSIS_LAYERS = [
    'theme_app_extension', // app embed/block off or misconfigured — storefront doesn't render
    'storefront_script', // storefront JS / app proxy behaving wrong
    'admin_embedded_ui', // embedded admin (App Bridge) UI error
    'app_backend', // app server error (5xx, exceptions)
    'app_infra', // overload/down: DB / Redis / queue saturation
    'shopify_platform', // install / scopes / webhooks / billing or Shopify-side incident
    'unknown',
];

export const DIAGNOSIS_ROUTES = [
    'code_fix', // a bug in the app's code — hand off to the fix flow
    'merchant_action', // merchant must do something (e.g. enable the app embed)
    'infra', // ops/infra action (scale, restart, unclog a queue)
    'shopify_platform', // Shopify-side / billing / reinstall
    'needs_more_info', // not enough evidence to conclude
];

export const diagnosisToolDefinitions = [
    {
        type: 'function',
        function: {
            name: 'ReportDiagnosis',
            description:
                'Record the final diagnosis of a Shopify embedded app issue, once evidence supports it: which layer the fault is in, the root cause, the evidence, your confidence, and how to route it. Call this exactly once at the end. If route is "code_fix" the harness hands off to the coding fix flow.',
            parameters: {
                type: 'object',
                required: ['layer', 'root_cause', 'route', 'confidence'],
                properties: {
                    layer: { type: 'string', enum: DIAGNOSIS_LAYERS },
                    root_cause: { type: 'string', description: 'The concrete cause, in one or two sentences.' },
                    evidence: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Observations that prove it (tool results, status codes, queue depth, missing block, …).',
                    },
                    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
                    route: { type: 'string', enum: DIAGNOSIS_ROUTES },
                    recommended_action: { type: 'string', description: 'What to do next — the fix, the merchant instruction, or the ops action.' },
                    fix_target: { type: 'string', description: 'For code_fix: the file/area/symbol to start from, if known.' },
                },
            },
        },
    },
];

export function createDiagnosisHandlers() {
    return {
        ReportDiagnosis: (args) => ({
            recorded: true,
            diagnosis: args,
            directive:
                args.route === 'code_fix'
                    ? 'Diagnosis recorded. The harness will hand this off to the coding fix flow.'
                    : 'Diagnosis recorded. This is not a code bug — report the recommended action to the supporter.',
        }),
    };
}
