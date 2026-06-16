import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// RunCode: execute a short script in an isolated scratch directory to verify
// runtime behavior (reproduce a bug, test a regex, check an API shape, …).
//
// Isolation is process-level only: a fresh temp working directory, a hard
// timeout, and an output cap. It does NOT block network or filesystem access,
// which is why the tool is classified `bash` and goes through the same
// permission gate as shell commands.

export const sandboxToolDefinitions = [
    {
        type: 'function',
        function: {
            name: 'RunCode',
            description:
                'Run a short standalone script (node or python) in an isolated temp directory and return stdout/stderr/exit code. Use it to verify runtime behavior: reproduce a bug, test a function or regex, check output shapes. The script cannot see the workspace — inline everything it needs.',
            parameters: {
                type: 'object',
                required: ['code'],
                properties: {
                    language: { type: 'string', enum: ['node', 'python'], default: 'node' },
                    code: { type: 'string', description: 'Complete script source.' },
                    timeout_ms: {
                        type: 'integer',
                        minimum: 500,
                        maximum: 120000,
                        default: 10000,
                    },
                },
            },
        },
    },
];

export function createSandboxHandlers() {
    return {
        RunCode: ({ language = 'node', code, timeout_ms: timeoutMs = 10000 }) =>
            runCode(language, code, timeoutMs),
    };
}

async function runCode(language, code, timeoutMs) {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'oragent-sandbox-'));
    const file = path.join(dir, language === 'python' ? 'main.py' : 'main.mjs');
    await fs.writeFile(file, code ?? '', 'utf8');

    const exe = language === 'python' ? pythonExecutable() : process.execPath;
    const startedAt = Date.now();
    try {
        const { stdout, stderr } = await execFileAsync(exe, [file], {
            cwd: dir,
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024 * 4,
            env: process.env,
        });
        return { language, exit_code: 0, duration_ms: Date.now() - startedAt, stdout, stderr };
    } catch (error) {
        return {
            language,
            exit_code: typeof error.code === 'number' ? error.code : 1,
            duration_ms: Date.now() - startedAt,
            stdout: error.stdout || '',
            stderr: error.stderr || '',
            error: error.killed ? `Timed out after ${timeoutMs}ms` : error.message,
        };
    } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

function pythonExecutable() {
    return process.platform === 'win32' ? 'python' : 'python3';
}
