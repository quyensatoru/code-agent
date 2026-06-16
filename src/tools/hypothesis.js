// Hypothesize — make root-cause prediction a first-class step, not a vibe.
// Before searching, the agent records 2-4 candidate causes; for each: the
// suspected cause, what it would observe if that cause were true (the
// prediction), and how to confirm or refute it. Same philosophy as TodoWrite:
// externalize the reasoning so search becomes hypothesis-driven and bounded.

export const hypothesisToolDefinitions = [
    {
        type: 'function',
        function: {
            name: 'Hypothesize',
            description:
                'Record 1-4 candidate root causes for the issue BEFORE searching. For each: the suspected cause, what you would observe if it were true (prediction), and the single check that confirms or refutes it. Then test the most likely one and stop once it is confirmed.',
            parameters: {
                type: 'object',
                required: ['hypotheses'],
                properties: {
                    hypotheses: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['cause', 'check'],
                            properties: {
                                cause: { type: 'string', description: 'Suspected root cause.' },
                                predicts: {
                                    type: 'string',
                                    description: 'What you would observe if this cause is real.',
                                },
                                check: {
                                    type: 'string',
                                    description: 'The single Grep/TraceCalls/Read/RunCode that confirms or refutes it.',
                                },
                            },
                        },
                    },
                },
            },
        },
    },
];

export function createHypothesisHandlers() {
    let current = [];
    return {
        Hypothesize: ({ hypotheses = [] }) => {
            current = hypotheses.map((h, index) => ({
                id: index + 1,
                cause: String(h.cause || ''),
                predicts: String(h.predicts || ''),
                check: String(h.check || ''),
                status: 'open',
            }));
            return {
                recorded: current.length,
                hypotheses: current,
                directive:
                    'Test the most likely hypothesis first with its single check. Confirm or refute with concrete evidence, then fix the confirmed cause. Do not keep searching once a cause is confirmed.',
            };
        },
    };
}
