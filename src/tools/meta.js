// Permission classification for each built-in tool. `read` tools never
// prompt; `edit` and `bash` tools are gated by src/permissions before the
// runtime executes them. Kept in its own module so the permission layer can
// import it without pulling in tool implementations (avoids import cycles).
export const TOOL_META = {
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
    Write: { readOnly: false, permission: 'edit' },
    Edit: { readOnly: false, permission: 'edit' },
    Bash: { readOnly: false, permission: 'bash' },
};
