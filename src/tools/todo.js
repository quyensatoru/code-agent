// Per-run todo list. Replaced wholesale on each TodoWrite, like the SDK's
// TodoWrite tool. Enforces at most one `in_progress` item so the plan stays
// readable for the user and the model.

export const todoToolDefinitions = [
    {
        type: 'function',
        function: {
            name: 'TodoWrite',
            description:
                'Replace the current task todo list. Useful for multi-step coding work. Keep exactly one item in_progress at a time.',
            parameters: {
                type: 'object',
                required: ['todos'],
                properties: {
                    todos: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['content', 'status'],
                            properties: {
                                content: { type: 'string' },
                                status: {
                                    type: 'string',
                                    enum: ['pending', 'in_progress', 'completed'],
                                },
                            },
                        },
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'TodoRead',
            description: 'Read the current task todo list.',
            parameters: { type: 'object', properties: {} },
        },
    },
];

export function createTodoHandlers() {
    let todos = [];

    return {
        TodoWrite: (args) => writeTodos(args.todos || []),
        TodoRead: () => ({ todos }),
    };

    function writeTodos(nextTodos) {
        const oldTodos = todos;
        let note;
        let sawInProgress = false;
        todos = nextTodos.map((todo) => {
            let status = ['pending', 'in_progress', 'completed'].includes(todo.status)
                ? todo.status
                : 'pending';
            if (status === 'in_progress') {
                if (sawInProgress) {
                    status = 'pending';
                    note = 'only one todo may be in_progress at a time — extras were set to pending';
                }
                sawInProgress = true;
            }
            return { content: String(todo.content || ''), status };
        });
        return { oldTodos, newTodos: todos, ...(note ? { note } : {}) };
    }
}
