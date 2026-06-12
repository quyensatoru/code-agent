// Agent (subagent / Task) tool: spawn a nested query() with its own fresh
// context window to explore or research, returning only the final answer to
// the parent. This keeps broad searches from flooding the parent's context.
//
// Subagents always run in plan (read-only) mode and cannot spawn further
// subagents (depth 1). query() is imported lazily to break the import cycle
// tools -> agent -> core/query -> tools.

export const agentToolDefinitions = [
    {
        type: 'function',
        function: {
            name: 'Agent',
            description:
                'Launch a read-only subagent with a fresh context to explore the codebase or research a question. It can use Read/Glob/Grep/list_files/Web tools and read-only shell commands, and returns only its final answer. Use it for broad searches or research whose intermediate output would flood your context; give it a self-contained task description and say exactly what it should return.',
            parameters: {
                type: 'object',
                required: ['prompt'],
                properties: {
                    prompt: {
                        type: 'string',
                        description:
                            'Self-contained task for the subagent, including what to investigate and what to return.',
                    },
                    max_turns: { type: 'integer', minimum: 1, maximum: 30, default: 12 },
                },
            },
        },
    },
];

export function createAgentHandlers({ queryOptions, onEvent = () => {} }) {
    return {
        Agent: (args) => runSubagent(args),
    };

    async function runSubagent({ prompt, max_turns: maxTurns = 12 }) {
        const { query } = await import('../core/query.js');
        const base = queryOptions || {};

        let result = '';
        let isError = false;
        let turns = 0;

        for await (const message of query({
            prompt,
            options: {
                apiKey: base.apiKey,
                model: base.model,
                fallbackModel: base.fallbackModel,
                baseUrl: base.baseUrl,
                timeoutMs: base.timeoutMs,
                cwd: base.cwd,
                additionalDirectories: base.additionalDirectories,
                temperature: base.temperature,
                reasoning: base.reasoning,
                permissionMode: 'plan',
                disallowedTools: ['Agent'],
                maxTurns: Math.min(Number(maxTurns) || 12, 30),
                openRouterWebSearch: base.openRouterWebSearch,
                openRouterWebFetch: base.openRouterWebFetch,
                loadProjectContext: false,
                memory: false,
                onEvent: (event) => onEvent({ ...event, subagent: true }),
            },
        })) {
            if (message.type === 'result') {
                turns = message.num_turns;
                isError = message.subtype !== 'success';
                result =
                    message.subtype === 'success'
                        ? message.result
                        : (message.errors || []).join('; ');
            }
        }

        if (isError) throw new Error(`Subagent failed: ${result || 'no result'}`);
        return { turns, result };
    }
}
