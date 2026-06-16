import { query } from '../core/query.js';
import { SHOPIFY_SUPPORT_PROMPT } from './prompt.js';

// runSupport — the Shopify support agent orchestrator. It runs the diagnosis
// agent (Shopify support prompt + the read-only evidence toolset) over a
// forwarded issue, captures the structured ReportDiagnosis, and — when the
// cause is a code bug — hands off to the existing coding/fix flow (the default
// query() agent) end to end.
//
// Returns { diagnosis, summary, sessionId, fix }. `fix` is null unless a
// code_fix handoff ran.
export async function runSupport({ issue, options = {} } = {}) {
    if (!issue) throw new Error('issue is required');

    let diagnosis = null;
    const baseOnEvent = options.onEvent || (() => {});
    const onEvent = (event) => {
        // ReportDiagnosis' input IS the diagnosis — capture it as it's called.
        if (event.type === 'tool_start' && event.name === 'ReportDiagnosis') diagnosis = event.input;
        baseOnEvent(event);
    };

    const { autoFix = true, ...sdk } = options;

    const diag = await drive(issue, { ...sdk, systemPrompt: SHOPIFY_SUPPORT_PROMPT, onEvent });

    let fix = null;
    if (diagnosis?.route === 'code_fix' && autoFix) {
        baseOnEvent({ type: 'support_handoff', layer: diagnosis.layer, target: diagnosis.fix_target });
        fix = await drive(buildFixPrompt(diagnosis), { ...sdk, onEvent: baseOnEvent });
    }

    return { diagnosis, summary: diag.result, sessionId: diag.sessionId, fix };
}

async function drive(prompt, options) {
    let sessionId;
    let result = '';
    for await (const message of query({ prompt, options })) {
        if (message.type === 'system' && message.subtype === 'init') sessionId = message.session_id;
        else if (message.type === 'result') {
            result =
                message.subtype === 'success' ? message.result : (message.errors || []).join('; ');
        }
    }
    return { sessionId, result };
}

function buildFixPrompt(diagnosis) {
    const lines = [
        'A Shopify embedded app support diagnosis concluded this is a code bug. Investigate and fix it following the standard workflow (hypothesize, locate, change, verify).',
        `Layer: ${diagnosis.layer}`,
        `Root cause: ${diagnosis.root_cause}`,
    ];
    if (diagnosis.evidence?.length) lines.push(`Evidence: ${diagnosis.evidence.join('; ')}`);
    if (diagnosis.fix_target) lines.push(`Likely area: ${diagnosis.fix_target}`);
    if (diagnosis.recommended_action) lines.push(`Suggested fix: ${diagnosis.recommended_action}`);
    return lines.join('\n');
}
