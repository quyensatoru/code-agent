import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export const shellToolDefinitions = [
    {
        type: 'function',
        function: {
            name: 'Bash',
            description: 'Run a shell command in the workspace and return stdout/stderr.',
            parameters: {
                type: 'object',
                required: ['command'],
                properties: {
                    command: { type: 'string' },
                    timeout_ms: {
                        type: 'integer',
                        minimum: 1000,
                        maximum: 600000,
                        default: 30000,
                    },
                },
            },
        },
    },
];

export function createShellHandlers({ root }) {
    return {
        Bash: (args) => runCommand(args.command, args.timeout_ms ?? 30000),
    };

    async function runCommand(command, timeoutMs) {
        const options = {
            cwd: root,
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024 * 8,
            env: process.env,
            shell: true,
        };
        try {
            const { stdout, stderr } = await execAsync(command, options);
            return { command, exit_code: 0, stdout, stderr };
        } catch (error) {
            return {
                command,
                exit_code: typeof error.code === 'number' ? error.code : 1,
                stdout: error.stdout || '',
                stderr: error.stderr || '',
                error: error.killed ? `Command timed out after ${timeoutMs}ms` : error.message,
            };
        }
    }
}
