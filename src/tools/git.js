import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Structured, read-only git inspection. Unlike Bash, this runs git via
// execFile (no shell, no injection surface) and is restricted to read-only
// subcommands, so it is classified `read` and never prompts — including in
// plan mode.

const SUBCOMMANDS = ['status', 'diff', 'log', 'show', 'branch', 'remote', 'blame', 'stash'];

export const gitToolDefinitions = [
    {
        type: 'function',
        function: {
            name: 'Git',
            description:
                'Read-only git inspection in the workspace: status, diff, log, show, branch, remote, blame, stash list. Never prompts for permission. Use Bash for git commands that modify state (add/commit/checkout/...).',
            parameters: {
                type: 'object',
                required: ['subcommand'],
                properties: {
                    subcommand: {
                        type: 'string',
                        enum: SUBCOMMANDS,
                    },
                    args: {
                        type: 'string',
                        description:
                            'Extra arguments, e.g. "--oneline -10", "HEAD~1 -- src/app.js", "abc123 --stat". Whitespace-separated.',
                    },
                },
            },
        },
    },
];

export function createGitHandlers({ root }) {
    return {
        Git: ({ subcommand, args = '' }) => runGit(subcommand, args),
    };

    async function runGit(subcommand, args) {
        if (!SUBCOMMANDS.includes(subcommand)) {
            throw new Error(`Unsupported git subcommand "${subcommand}". Allowed: ${SUBCOMMANDS.join(', ')}`);
        }
        const extra = String(args || '')
            .split(/\s+/)
            .filter(Boolean);
        // `stash` is only safe to read: restrict to `stash list`.
        if (subcommand === 'stash' && extra[0] !== 'list') {
            throw new Error('Only "stash list" is allowed; use Bash for stash mutations.');
        }
        try {
            const { stdout, stderr } = await execFileAsync(
                'git',
                ['--no-pager', subcommand, ...extra],
                { cwd: root, timeout: 15000, maxBuffer: 1024 * 1024 * 8 }
            );
            return { command: `git ${subcommand} ${extra.join(' ')}`.trim(), stdout, stderr };
        } catch (error) {
            return {
                command: `git ${subcommand} ${extra.join(' ')}`.trim(),
                exit_code: typeof error.code === 'number' ? error.code : 1,
                stdout: error.stdout || '',
                stderr: error.stderr || error.message,
            };
        }
    }
}
