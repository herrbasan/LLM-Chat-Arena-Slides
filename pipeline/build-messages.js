// pipeline/build-messages.js
// v3 Project Builder — Messages with Paragraphs
//
// Takes a parsed Arena source (from importer.js) and builds a v3 project:
//   { version: 3, source, voiceMapping, messages[] }
//
// Each message contains paragraphs[] — the natural text boundaries that
// TTS and alignment operate on. No slides are stored; slide layout is
// computed at runtime by the browser.
//
// Before splitting into paragraphs, message text is cleaned via
// pipeline/clean.js (LLM gateway call per message) to remove client-side
// noise, stage directions, and other artifacts.
// Pass { skipClean: true } to bypass this (e.g. for quick reimports).

const fs = require('fs');
const path = require('path');
const { cleanAllMessages } = require('./clean.js');
const { parseArenaExport } = require('./importer.js');

// ─── Voice config ─────────────────────────────────────────────

const VOICES = {
    narrator: {
        voice: process.env.VOICE_NARRATOR || 'en-US-Male',
        speed: parseFloat(process.env.VOICE_NARRATOR_SPEED) || 0.95
    },
    participantA: {
        voice: process.env.VOICE_PARTICIPANT_A || 'en-US-Female',
        speed: parseFloat(process.env.VOICE_PARTICIPANT_A_SPEED) || 1.0
    },
    participantB: {
        voice: process.env.VOICE_PARTICIPANT_B || 'en-UK-Male',
        speed: parseFloat(process.env.VOICE_PARTICIPANT_B_SPEED) || 1.0
    }
};

// ─── Paragraph splitting ──────────────────────────────────────
// Split on double newlines (with optional whitespace between them).
// Single newlines within a paragraph are preserved as soft breaks
// in the text — they don't create separate paragraphs.

function splitIntoParagraphs(text) {
    if (!text || !text.trim()) return [];
    return text.split(/\n\s*\n/)
        .map(p => p.trim())
        .filter(p => p.length > 0);
}

// ─── Role resolution ──────────────────────────────────────────

function resolveRoles(participants) {
    const pA = participants[0] || null;
    const pB = participants[1] || null;

    return function roleFor(speaker) {
        if (!speaker) return { role: 'participantA', label: pA || 'Speaker A' };
        const s = String(speaker).trim();
        if (pA && s === pA) return { role: 'participantA', label: pA };
        if (pB && s === pB) return { role: 'participantB', label: pB };
        return { role: 'participantA', label: s };
    };
}

// ─── Message building ─────────────────────────────────────────

function buildMessages(source, progress) {
    const roleFor = resolveRoles(source.participants.filter(Boolean));

    progress('messages', `Splitting ${source.messages.length} messages into paragraphs…`, 30);

    const messages = source.messages.map((m, idx) => {
        const text = m.content || '';
        const { role, label } = roleFor(m.speaker);
        const paragraphs = splitIntoParagraphs(text);

        if (paragraphs.length === 0) {
            console.warn(`  [Message ${idx}] Empty message from ${m.speaker} — skipping`);
            return null;
        }

        return {
            speaker: role,
            label: label,
            role: m.role || 'assistant',
            createdAt: m.createdAt || null,
            originalSpeaker: m.speaker,
            paragraphs: paragraphs.map(p => ({ text: p }))
        };
    }).filter(Boolean);

    const totalParagraphs = messages.reduce((sum, m) => sum + m.paragraphs.length, 0);
    progress('messages', `Built ${messages.length} messages with ${totalParagraphs} paragraphs`, 70);

    return messages;
}

// ─── Main ─────────────────────────────────────────────────────

/**
 * Build a v3 project from a parsed Arena source.
 *
 * @param {Object} sourceData — parsed Arena export (or pre-parsed source).
 * @param {string|null} outputDir — where to write the project JSON. null = skip.
 * @param {Function} [progress] — (stage, message, pct) => void
 * @param {Object} [options]
 * @param {boolean} [options.skipClean] — skip LLM text cleaning (default false)
 * @returns {Object} v3 project: { version: 3, source, voiceMapping, messages[] }
 */
async function buildProject(sourceData, outputDir = null, progress = () => {}, options = {}) {
    progress('import', `Loaded ${sourceData.messages?.length || 0} messages`, 10);

    // If the input looks like raw Arena JSON (has a moderator message),
    // parse it through the importer first. This makes buildProject accept
    // both raw Arena exports and pre-parsed source objects.
    const hasModerator = Array.isArray(sourceData.messages) && sourceData.messages.some(
        m => (m.speaker || '').toLowerCase() === 'moderator'
    );
    const rawSource = hasModerator ? parseArenaExport(sourceData) : sourceData;

    // Normalize: accept both raw Arena JSON and pre-parsed source objects.
    const source = {
        id: rawSource.id || rawSource.source?.id || rawSource.source?.arenaExportId || 'unknown',
        topic: rawSource.topic || rawSource.source?.topic || 'Untitled',
        participants: rawSource.participants || rawSource.source?.participants || [],
        messages: rawSource.messages || rawSource.source?.messages || [],
        exportedAt: rawSource.exportedAt || rawSource.source?.exportedAt || new Date().toISOString(),
        seedPrompt: rawSource.seedPrompt || rawSource.source?.seedPrompt || null,
        seedPromptRaw: rawSource.seedPromptRaw || rawSource.source?.seedPromptRaw || null,
        renderedAt: rawSource.renderedAt || rawSource.source?.renderedAt || null
    };

    if (source.messages.length === 0) {
        throw new Error('No messages found in source data');
    }
    if (!source.seedPrompt) {
        console.warn('[Build Messages] WARNING: source.seedPrompt is empty — topic will fall back to summary title.');
    }

    // ── Step 1: Clean message text via LLM ─────────────────────
    if (!options.skipClean) {
        progress('clean', `Cleaning ${source.messages.length} messages via LLM…`, 15);
        await cleanAllMessages(source.messages, (i, total, speaker, cleaned, cached) => {
            progress('clean', `Cleaning message ${i}/${total} (${speaker})`, 15 + Math.floor((i / total) * 10));
        });
    } else {
        progress('clean', 'Skipping LLM text cleaning (--skip-clean)', 20);
    }

    // ── Step 2: Split messages into paragraphs ─────────────────
    progress('messages', `Splitting messages into paragraphs…`, 25);
    const messages = buildMessages(source, progress);

    // ── Step 3: Assemble v3 project ────────────────────────────
    const participants = source.participants.filter(Boolean);

    const project = {
        version: 3,
        source: {
            arenaExportId: source.id,
            exportedAt: source.exportedAt,
            topic: source.topic,
            seedPrompt: source.seedPrompt,
            seedPromptRaw: source.seedPromptRaw,
            participants: participants,
            renderedAt: source.renderedAt || source.exportedAt
        },
        voiceMapping: {
            narrator:     { voice: VOICES.narrator.voice,     speed: VOICES.narrator.speed },
            participantA: { voice: VOICES.participantA.voice, speed: VOICES.participantA.speed, label: participants[0] || '' },
            participantB: { voice: VOICES.participantB.voice, speed: VOICES.participantB.speed, label: participants[1] || '' }
        },
        messages: messages,
        createdAt: Date.now(),
        renderedAt: source.renderedAt || source.exportedAt
    };

    const totalParagraphs = messages.reduce((sum, m) => sum + m.paragraphs.length, 0);
    progress('write', `Project: ${messages.length} messages, ${totalParagraphs} paragraphs`, 95);

    if (outputDir) {
        fs.mkdirSync(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, 'project_v3.json');
        fs.writeFileSync(outputPath, JSON.stringify(project, null, 2), 'utf-8');
        console.log(`[Build Messages] Output: ${outputPath}`);
    }

    console.log(`\n[Build Messages] Overview (${messages.length} messages, ${totalParagraphs} paragraphs):`);
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        const paraCount = m.paragraphs.length;
        const preview = m.paragraphs[0].text.substring(0, 60).replace(/\n/g, ' ');
        console.log(`  ${i}. [${m.speaker}] ${m.label}: ${paraCount} paragraph${paraCount !== 1 ? 's' : ''} — "${preview}…"`);
    }

    progress('done', `Done — ${messages.length} messages, ${totalParagraphs} paragraphs`, 100);
    return project;
}

// ─── CLI ──────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.error('Usage: node pipeline/build-messages.js <arena-export.json> [output-dir] [--skip-clean]');
        process.exit(1);
    }

    const inputPath = path.resolve(args[0]);
    const outputDir = path.resolve(args[1] || 'pipeline/output');
    const skipClean = args.includes('--skip-clean');

    if (!fs.existsSync(inputPath)) {
        console.error(`Input file not found: ${inputPath}`);
        process.exit(1);
    }

    const raw = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
    await buildProject(raw, outputDir, undefined, { skipClean });
}

if (require.main === module) {
    main().catch(err => {
        console.error('\n[Build Messages] FATAL:', err.message);
        process.exit(1);
    });
}

module.exports = { buildProject, splitIntoParagraphs };
