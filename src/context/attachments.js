import { promises as fs } from 'node:fs';
import path from 'node:path';

// Resolve external context (images, PDFs, research docs) into OpenRouter
// chat-completions content parts so the agent can reason over more than plain
// text. Maps onto the Claude Agent SDK's multimodal MessageParam blocks
// (text/image/document); here we emit the OpenAI-compatible shapes OpenRouter
// expects:
//   image -> { type:"image_url", image_url:{ url } }
//   pdf   -> { type:"file", file:{ filename, file_data } } (+ file-parser plugin)
//   audio -> { type:"input_audio", input_audio:{ data, format } } (raw base64, no URL)
//   video -> { type:"video_url", video_url:{ url } } (data URL or http URL)
//   text  -> { type:"text", text } (local docs inlined with a label)

const IMAGE_MEDIA = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
};

// ext -> OpenRouter audio `format` value (data is raw base64, not a data URL).
const AUDIO_FORMAT = {
    '.wav': 'wav',
    '.mp3': 'mp3',
    '.flac': 'flac',
    '.m4a': 'm4a',
    '.ogg': 'ogg',
    '.aac': 'aac',
    '.aiff': 'aiff',
};

const VIDEO_MEDIA = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
};

const TEXT_EXT = new Set([
    '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log', '.yml',
    '.yaml', '.xml', '.html', '.htm', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
    '.py', '.go', '.rs', '.java', '.rb', '.php', '.c', '.h', '.cpp', '.cc', '.cs',
    '.sh', '.bash', '.zsh', '.sql', '.toml', '.ini', '.env', '.conf', '.css',
]);

const MAX_DOC_CHARS = 200000;

// Resolve attachment descriptors into { parts, hasFile }.
//   attachments: [{ kind: 'image'|'pdf'|'doc', ref: string }]
//   ref is a local path (relative to cwd or absolute) or an http(s) URL.
export async function resolveAttachments(attachments = [], cwd = process.cwd()) {
    const parts = [];
    let hasFile = false;

    for (const att of attachments) {
        const ref = typeof att === 'string' ? att : att.ref;
        if (!ref) continue;
        const kind = classify(att.kind, ref);
        const isUrl = /^https?:\/\//i.test(ref);

        if (kind === 'image') {
            const url = isUrl ? ref : await toDataUrl(ref, cwd, imageMedia(ref));
            parts.push({ type: 'image_url', image_url: { url } });
        } else if (kind === 'pdf') {
            const fileData = isUrl ? ref : await toDataUrl(ref, cwd, 'application/pdf');
            parts.push({
                type: 'file',
                file: { filename: path.basename(ref) || 'document.pdf', file_data: fileData },
            });
            hasFile = true;
        } else if (kind === 'audio') {
            if (isUrl) {
                parts.push({
                    type: 'text',
                    text: `--- Audio URL: ${ref} ---\nOpenRouter audio input must be a local file (base64); URLs are not supported.`,
                });
            } else {
                parts.push({ type: 'input_audio', input_audio: await audioPart(ref, cwd) });
            }
        } else if (kind === 'video') {
            const url = isUrl ? ref : await toDataUrl(ref, cwd, videoMedia(ref));
            parts.push({ type: 'video_url', video_url: { url } });
        } else {
            // text/research doc -> inline as a labeled text part.
            parts.push({ type: 'text', text: await inlineTextDoc(ref, cwd, isUrl) });
        }
    }

    return { parts, hasFile };
}

// Build the file-parser plugin config when any file/PDF is attached.
export function filePlugins(hasFile, pdfEngine) {
    if (!hasFile) return undefined;
    const pdf = pdfEngine ? { engine: pdfEngine } : undefined;
    return [{ id: 'file-parser', ...(pdf ? { pdf } : {}) }];
}

function classify(kind, ref) {
    if (kind === 'image' || kind === 'pdf' || kind === 'audio' || kind === 'video') return kind;
    const ext = path.extname(ref).toLowerCase();
    if (ext === '.pdf') return 'pdf';
    if (IMAGE_MEDIA[ext]) return 'image';
    if (AUDIO_FORMAT[ext]) return 'audio';
    if (VIDEO_MEDIA[ext]) return 'video';
    return 'text';
}

function imageMedia(ref) {
    return IMAGE_MEDIA[path.extname(ref).toLowerCase()] || 'image/png';
}

function videoMedia(ref) {
    return VIDEO_MEDIA[path.extname(ref).toLowerCase()] || 'video/mp4';
}

async function audioPart(ref, cwd) {
    const abs = path.resolve(cwd, ref);
    const buffer = await fs.readFile(abs);
    const format = AUDIO_FORMAT[path.extname(ref).toLowerCase()] || 'wav';
    return { data: buffer.toString('base64'), format };
}

async function toDataUrl(ref, cwd, mediaType) {
    const abs = path.resolve(cwd, ref);
    const buffer = await fs.readFile(abs);
    return `data:${mediaType};base64,${buffer.toString('base64')}`;
}

async function inlineTextDoc(ref, cwd, isUrl) {
    if (isUrl) {
        return `--- Reference document URL: ${ref} ---\nUse the WebFetch tool to read this document if its contents are needed.`;
    }
    const abs = path.resolve(cwd, ref);
    const raw = await fs.readFile(abs, 'utf8');
    const truncated = raw.length > MAX_DOC_CHARS;
    const body = truncated ? raw.slice(0, MAX_DOC_CHARS) : raw;
    const note = truncated ? `\n[truncated ${raw.length - MAX_DOC_CHARS} chars]` : '';
    return `--- Attached document: ${path.basename(ref)} ---\n${body}${note}`;
}
