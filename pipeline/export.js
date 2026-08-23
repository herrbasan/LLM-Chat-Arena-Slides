// pipeline/export.js
// Bake a rendered v3 project into a static, portable folder:
//   {out}/{slug}/project.json   — data structure: messages, paragraphs,
//                                 aligned word timings, voice mapping, source
//   {out}/{slug}/transcript.md  — human-readable transcript + metadata header
//   {out}/{slug}/audio/*.mp3    — every referenced audio file
//
// The export player (server/export-template/) is a static page; point it
// at the folder: player/?src={slug}/ (or .../project.json).
//
// Usage:
//   node pipeline/export.js <projectId> [outputRoot]
// Default outputRoot: server/data/exports (locally previewed via the
// slideshow server's /exports static route).
//
// Fails loud unless every speakable paragraph has audio + alignment —
// an export is a publishable artifact, gaps are not allowed.

const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '../server/node_modules/dotenv')).config({ path: path.join(__dirname, '../server/.env') });

const projectId = process.argv[2];
const outputRoot = path.resolve(process.argv[3] || path.join(__dirname, '../web-export/convos'));

if (!projectId) {
    console.error('Usage: node pipeline/export.js <projectId> [outputRoot]');
    process.exit(1);
}
if (!process.env.NDB_DATA_PATH) {
    throw new Error('NDB_DATA_PATH not set — check server/.env');
}

const nDB = require('../modules/nDB/napi/index.js');
const db = nDB.Database.open(path.resolve(__dirname, '../server', process.env.NDB_DATA_PATH, 'slideshows.jsonl'), { persistence: 'immediate' });

const doc = db.get(projectId);
if (!doc) throw new Error(`Project not found: ${projectId}`);
if (doc.version !== 3) throw new Error('Not a v3 project');

// ─── Validation: every speakable paragraph rendered + aligned ───
const missing = [];
for (let mi = 0; mi < doc.messages.length; mi++) {
    const paras = doc.messages[mi].paragraphs || [];
    for (let pi = 0; pi < paras.length; pi++) {
        const p = paras[pi];
        if (!/[\p{L}\p{N}]/u.test(p.text || '')) continue; // unspeakable — skipped everywhere
        if (!p.audioRef || !(p.words?.length > 0)) missing.push(`msg${mi}/p${pi}`);
    }
}
if (missing.length > 0) {
    throw new Error(`${missing.length} paragraph(s) not fully rendered: ${missing.slice(0, 20).join(', ')}`);
}

// ─── Folder ───
const slug = String(doc.source?.topic || doc._id)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || doc._id;
const outDir = path.join(outputRoot, slug);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'audio'), { recursive: true });

// ─── Audio (dedup by content hash — paragraphs can share files) ───
const urlByRef = new Map();
function mapRef(ref) {
    if (!ref) return null;
    if (urlByRef.has(ref)) return urlByRef.get(ref);
    const m = ref.match(/^([^:]+):([^.]+)\.(.+)$/);
    if (!m) throw new Error(`Invalid audioRef: ${ref}`);
    const rel = `audio/${m[2]}.${m[3]}`;
    fs.writeFileSync(path.join(outDir, rel), db.getFile(m[1], m[2], m[3]));
    urlByRef.set(ref, rel);
    return rel;
}

// ─── project.json ───
const project = {
    version: 3,
    source: doc.source,
    voiceMapping: doc.voiceMapping,
    messages: doc.messages.map(m => ({
        speaker: m.speaker,
        label: m.label,
        type: m.type,
        text: m.text,
        narration: m.narration,
        createdAt: m.createdAt || null,
        meta: m.meta || null,
        conversationIdx: m.conversationIdx,
        paragraphs: (m.paragraphs || []).map(p => ({
            text: p.text,
            audioUrl: mapRef(p.audioRef),
            words: p.words,
            durationMs: p.durationMs
        }))
    }))
};
fs.writeFileSync(path.join(outDir, 'project.json'), JSON.stringify(project));

// ─── transcript.md ───
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
function humanDate(iso) {
    if (!iso) return 'unknown date';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 'unknown date';
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

const topic = doc.source?.topic || slug;
const participants = (doc.source?.participants || []).filter(Boolean);
const conversation = doc.messages.filter(m => m.type === 'conversation');

const lines = [];
lines.push(`# ${topic}`);
lines.push('');
const metaBits = [];
metaBits.push(`Recorded: ${humanDate(doc.source?.exportedAt)}`);
if (participants.length) metaBits.push(`Models: ${participants.join(', ')}`);
metaBits.push(`${conversation.length} turns`);
lines.push(metaBits.join(' · '));
if (doc.source?.seedPromptRaw) {
    lines.push('');
    lines.push(`> ${doc.source.seedPromptRaw}`);
}
lines.push('');
lines.push('---');
lines.push('');
for (const m of conversation) {
    const label = m.label || m.originalSpeaker || m.speaker || 'Unknown';
    lines.push(`**${label}**`);
    lines.push('');
    for (const p of (m.paragraphs || [])) {
        if (!/[\p{L}\p{N}]/u.test(p.text || '')) continue; // skip unspeakable (e.g. dividers)
        lines.push(p.text);
        lines.push('');
    }
}
fs.writeFileSync(path.join(outDir, 'transcript.md'), '\uFEFF' + lines.join('\n'));

console.log(`[Export] ${slug}`);
console.log(`  ${project.messages.length} messages, ${conversation.length} turns`);
console.log(`  ${urlByRef.size} audio files`);
console.log(`  → ${outDir}`);

// ─── Root listing (index.html next to convos/) ─────────────
// Regenerated on every export: one entry per baked conversation,
// newest first. Static, deployable as-is.
function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function regenerateListing(convosDir) {
    const rootDir = path.dirname(convosDir);
    const entries = [];
    for (const d of fs.readdirSync(convosDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        try {
            const p = JSON.parse(fs.readFileSync(path.join(convosDir, d.name, 'project.json'), 'utf-8'));
            const durationMs = p.messages.reduce((sum, m) => sum + (m.paragraphs || []).reduce((s2, pa) => s2 + (pa.durationMs || 0), 0), 0);
            entries.push({
                slug: d.name,
                topic: p.source?.topic || d.name,
                date: p.source?.exportedAt || '',
                participants: (p.source?.participants || []).filter(Boolean),
                turns: p.messages.filter(m => m.type === 'conversation').length,
                durationMs
            });
        } catch { /* folder without readable project.json — skip */ }
    }
    entries.sort((a, b) => String(b.date).localeCompare(String(a.date)));

    const items = entries.map(e => `        <a class="convo" href="player/?src=../convos/${e.slug}/">
            <span class="convo__topic">${esc(e.topic)}</span>
            <span class="convo__meta">${esc(humanDate(e.date))} · ${esc(e.participants.join(' vs '))} · ${e.turns} turns · ${Math.round(e.durationMs / 60000)} min</span>
        </a>`).join('\n');

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Arena Conversations</title>
<style>
    :root { color-scheme: dark; }
    body { margin: 0; background: rgb(20,20,20); color: rgb(230,230,230); font-family: system-ui, sans-serif; font-weight: 300; }
    main { max-width: 48rem; margin: 0 auto; padding: 2rem 1rem; }
    h1 { font-size: 1.25rem; font-weight: 400; color: rgb(180,180,180); margin-bottom: 2rem; }
    .convo { display: block; padding: 1rem; margin-bottom: 0.5rem; background: rgb(30,30,30); border-radius: 0.25rem; text-decoration: none; color: inherit; border-left: 3px solid rgb(76,132,229); }
    .convo:hover { background: rgb(40,40,40); }
    .convo__topic { display: block; font-size: 1.1rem; margin-bottom: 0.25rem; }
    .convo__meta { display: block; font-size: 0.85rem; color: rgb(180,180,180); }
</style>
</head>
<body>
<main>
    <h1>Arena Conversations</h1>
${items}
</main>
</body>
</html>
`;
    fs.writeFileSync(path.join(rootDir, 'index.html'), html);
    console.log(`  listing: ${entries.length} conversation(s) → ${path.join(rootDir, 'index.html')}`);
}

regenerateListing(outputRoot);
