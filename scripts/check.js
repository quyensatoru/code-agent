// Cross-platform syntax check: `node --check` every .js file under src/, bin/,
// tests/, scripts/ (the old npm script used a bash for-loop, which broke on
// Windows).
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const roots = ['src', 'bin', 'tests', 'scripts'];
const files = [];

function walk(dir) {
    let entries;
    try {
        entries = readdirSync(dir);
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (entry.endsWith('.js')) files.push(full);
    }
}

for (const root of roots) walk(root);

let failed = 0;
for (const file of files) {
    try {
        execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
        failed += 1;
        console.error(`SYNTAX ERROR: ${file}\n${error.stderr?.toString() || error.message}`);
    }
}

console.log(`${files.length - failed}/${files.length} files OK`);
if (failed) process.exit(1);
