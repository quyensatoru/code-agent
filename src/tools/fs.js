import { promises as fs } from 'node:fs';
import path from 'node:path';

// File read/write/edit tools.

const MAX_READ_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_LINES = 2000;

export const fsToolDefinitions = [
    {
        type: 'function',
        function: {
            name: 'Read',
            description:
                'Read a UTF-8 text file with optional line bounds. Large files are truncated; pass start_line/end_line to page through them.',
            parameters: {
                type: 'object',
                required: ['path'],
                properties: {
                    path: { type: 'string' },
                    start_line: { type: 'integer', minimum: 1 },
                    end_line: { type: 'integer', minimum: 1 },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'Write',
            description: 'Create or overwrite a UTF-8 text file inside the workspace.',
            parameters: {
                type: 'object',
                required: ['path', 'content'],
                properties: {
                    path: { type: 'string' },
                    content: { type: 'string' },
                    overwrite: { type: 'boolean', default: false },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'Edit',
            description:
                'Replace exact text in a UTF-8 text file. Use Read first. The search text must be unique in the file unless replace_all is set.',
            parameters: {
                type: 'object',
                required: ['path', 'search', 'replace'],
                properties: {
                    path: { type: 'string' },
                    search: { type: 'string' },
                    replace: { type: 'string' },
                    replace_all: { type: 'boolean', default: false },
                },
            },
        },
    },
];

export function createFsHandlers({ root, resolvePath }) {
    return {
        Read: (args) => readFile(resolvePath(args.path), args),
        Write: (args) => writeFile(resolvePath(args.path), args),
        Edit: (args) => editFile(resolvePath(args.path), args),
    };

    async function readFile(file, { start_line: startLine, end_line: endLine }) {
        const stat = await fs.stat(file).catch((error) => {
            if (error.code === 'ENOENT') throw new Error(`File not found: ${path.relative(root, file)}`);
            throw error;
        });
        if (stat.isDirectory()) {
            throw new Error('Path is a directory — use list_files or Glob instead.');
        }
        if (stat.size > MAX_READ_BYTES) {
            throw new Error(
                `File is ${(stat.size / 1024 / 1024).toFixed(1)}MB (limit 5MB). Use Grep to locate the relevant section instead.`
            );
        }

        const text = await fs.readFile(file, 'utf8');
        const lines = text.split(/\r?\n/);
        const start = Math.max((startLine || 1) - 1, 0);
        let end = Math.min(endLine || lines.length, lines.length);
        let note;
        if (!endLine && end - start > DEFAULT_MAX_LINES) {
            end = start + DEFAULT_MAX_LINES;
            note = `[truncated: showing lines ${start + 1}-${end} of ${lines.length} — pass start_line/end_line to read more]`;
        }
        const numbered = lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`);
        return {
            path: path.relative(root, file),
            total_lines: lines.length,
            content: note ? `${numbered.join('\n')}\n${note}` : numbered.join('\n'),
        };
    }

    async function writeFile(file, { content, overwrite = false }) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        if (!overwrite) {
            try {
                await fs.access(file);
                throw new Error('File exists. Pass overwrite=true to replace it.');
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
        await fs.writeFile(file, content ?? '', 'utf8');
        return {
            path: path.relative(root, file),
            bytes: Buffer.byteLength(content ?? '', 'utf8'),
        };
    }

    async function editFile(file, { search, replace, replace_all: replaceAll = false }) {
        if (!search) throw new Error('search must be non-empty');
        const before = await fs.readFile(file, 'utf8');

        // The model emits \n, but a file on disk may use \r\n (Windows / git
        // autocrlf). Align the search/replace line endings to the file so an
        // exact match isn't missed.
        let needle = search;
        let value = replace ?? '';
        if (before.includes('\r\n') && !needle.includes('\r\n')) {
            needle = needle.replace(/\n/g, '\r\n');
            value = value.replace(/\n/g, '\r\n');
        } else if (!before.includes('\r\n') && needle.includes('\r\n')) {
            needle = needle.replace(/\r\n/g, '\n');
            value = value.replace(/\r\n/g, '\n');
        }

        const count = before.split(needle).length - 1;
        if (!count) {
            throw new Error(
                'search text not found in file. Read the file and pass the exact text, including whitespace.'
            );
        }
        if (count > 1 && !replaceAll) {
            throw new Error(
                `search text appears ${count} times — include more surrounding lines to make it unique, or set replace_all=true`
            );
        }
        // split/join replaces literally (no $-pattern interpretation) and, since
        // a non-replace_all edit requires a unique match, handles both cases.
        const after = before.split(needle).join(value);
        await fs.writeFile(file, after, 'utf8');
        return { path: path.relative(root, file), replacements: count };
    }
}
