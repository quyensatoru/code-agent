// Permission classification for each built-in tool. `read` tools never
// prompt; `edit` and `bash` tools are gated by src/permissions before the
// runtime executes them. Kept in its own module so the permission layer can
// import it without pulling in tool implementations (avoids import cycles).
export const TOOL_META = {
    TriageIssue: { readOnly: true, permission: 'read' },
    CodebaseMap: { readOnly: true, permission: 'read' },
    TraceDeps: { readOnly: true, permission: 'read' },
    TraceCalls: { readOnly: true, permission: 'read' },
    Hypothesize: { readOnly: true, permission: 'read' },
    Read: { readOnly: true, permission: 'read' },
    Glob: { readOnly: true, permission: 'read' },
    Grep: { readOnly: true, permission: 'read' },
    list_files: { readOnly: true, permission: 'read' },
    print_tree: { readOnly: true, permission: 'read' },
    TodoWrite: { readOnly: true, permission: 'read' },
    TodoRead: { readOnly: true, permission: 'read' },
    WebFetch: { readOnly: true, permission: 'read' },
    WebSearch: { readOnly: true, permission: 'read' },
    // The Agent subagent always runs in plan (read-only) mode, so launching it
    // is itself a read-class action.
    Agent: { readOnly: true, permission: 'read' },
    // Git is restricted to read-only subcommands and runs via execFile (no shell).
    Git: { readOnly: true, permission: 'read' },
    // BrowserSnapshot only loads a URL and observes — same class as WebFetch.
    BrowserSnapshot: { readOnly: true, permission: 'read' },
    // HttpProbe is restricted to idempotent methods (GET/HEAD/OPTIONS).
    HttpProbe: { readOnly: true, permission: 'read' },
    // Datastore inspection tools enforce read-only access internally.
    DataSources: { readOnly: true, permission: 'read' },
    SqlQuery: { readOnly: true, permission: 'read' },
    RedisCommand: { readOnly: true, permission: 'read' },
    MongoQuery: { readOnly: true, permission: 'read' },
    // RabbitMQ peeks via AMQP and requeues — never consumes (read-only).
    RabbitMQ: { readOnly: true, permission: 'read' },
    Write: { readOnly: false, permission: 'edit' },
    Edit: { readOnly: false, permission: 'edit' },
    Bash: { readOnly: false, permission: 'bash' },
    // RunCode executes arbitrary code — gated exactly like shell commands.
    RunCode: { readOnly: false, permission: 'bash' },
};

// Read-only exploration tools. The query loop counts consecutive calls to
// these to apply convergence pressure (see core/search-budget.js): the agent
// can't grep/read forever without forming a hypothesis or making a change.
export const EXPLORATION_TOOLS = new Set([
    'CodebaseMap',
    'TraceDeps',
    'TraceCalls',
    'Glob',
    'Grep',
    'Read',
    'list_files',
    'print_tree',
]);
