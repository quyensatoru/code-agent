// TriageIssue — the issue-intake step that was missing before Hypothesize.
// A raw customer report ("can't see the heatmap") has no shape: which URL,
// expected vs actual, repro, and — crucially — what facts are still unknown.
// This records a structured brief so the agent gathers evidence (BrowserSnapshot
// /HttpProbe) to resolve the unknowns BEFORE forming hypotheses. Same forcing-
// function philosophy as Hypothesize; read-only, never prompts.

export const triageToolDefinitions = [
    {
        type: 'function',
        function: {
            name: 'TriageIssue',
            description:
                'Turn a raw issue report into a structured brief BEFORE hypothesizing. Capture the symptom, where it happens (url/domain), expected vs actual behavior, how to reproduce, the environment, and — most importantly — the list of unknowns: facts you must still observe (via BrowserSnapshot/HttpProbe/Read) to diagnose. Resolve every unknown with evidence before calling Hypothesize.',
            parameters: {
                type: 'object',
                required: ['symptom', 'unknowns'],
                properties: {
                    symptom: { type: 'string', description: 'What the user cannot do or sees, in concrete terms.' },
                    url: { type: 'string', description: 'Affected URL/domain or page, if known.' },
                    expected: { type: 'string', description: 'Expected behavior.' },
                    actual: { type: 'string', description: 'Actual observed behavior.' },
                    repro: { type: 'string', description: 'Steps, conditions, user/data state that trigger it.' },
                    environment: { type: 'string', description: 'Browser, device, OS, locale — if known.' },
                    unknowns: {
                        type: 'array',
                        description: 'Facts still needed to diagnose; each becomes an evidence-gathering target.',
                        items: { type: 'string' },
                    },
                },
            },
        },
    },
];

export function createTriageHandlers() {
    let brief = null;
    return {
        TriageIssue: (args) => {
            brief = {
                symptom: String(args.symptom || ''),
                url: args.url || undefined,
                expected: args.expected || undefined,
                actual: args.actual || undefined,
                repro: args.repro || undefined,
                environment: args.environment || undefined,
                unknowns: (args.unknowns || []).map(String),
            };
            return {
                brief,
                directive:
                    'Resolve each unknown with concrete evidence before hypothesizing: for a live page use BrowserSnapshot (network + console + screenshot); for an endpoint/asset use HttpProbe; for code use Read/Grep/TraceCalls. Only call Hypothesize once the unknowns are answered.',
            };
        },
    };
}
