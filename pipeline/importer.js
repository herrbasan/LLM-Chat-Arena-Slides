// pipeline/importer.js
// Arena Export JSON → Raw Source Data
// Thin parser — no text cleaning, no slide creation.
// Text cleaning and slide construction are handled by llm-clean.js.
//
// Supports both legacy (v1) and current (v2, mode: "arena") formats.
// The v2 format consolidated with the normal chat export, so the
// structure is richer: participants are objects with name/model/role
// and messages have additional metadata (id, usage, streamStats).
// The first message is typically a `moderator` system prompt that
// sets the topic — we keep it in the messages array so downstream
// tools can decide how to use it.

const fs = require('fs');
const path = require('path');

function parseArenaExport(arenaData) {
    if (!arenaData || !Array.isArray(arenaData.messages)) {
        throw new Error('Invalid Arena export: missing messages array');
    }

    // Idempotent guard: if the input is ALREADY a parsed source object
    // (e.g. the editor's "Generate with AI" re-sends deck.source, which
    // has no moderator message and already has seedPrompt set), pass it
    // through. Re-parsing a parsed source would lose the seedPrompt
    // (the moderator is already stripped from messages), and the title
    // slide would fall back to the AI-generated topic summary.
    const hasModerator = arenaData.messages.some(
        m => (m.speaker || '').toLowerCase() === 'moderator'
    );
    if (!hasModerator && arenaData.seedPrompt) {
        return {
            id: arenaData.id || 'unknown',
            exportedAt: arenaData.exportedAt || new Date().toISOString(),
            topic: arenaData.topic || 'Untitled Conversation',
            seedPrompt: arenaData.seedPrompt,
            seedPromptRaw: arenaData.seedPromptRaw || arenaData.seedPrompt,
            participants: (arenaData.participants || []).map(p =>
                typeof p === 'string' ? p : (p && p.name) || null
            ).filter(Boolean),
            messages: arenaData.messages
        };
    }

    // Normalize participants to a flat array of name strings.
    // v1: ['glm5-chat', 'minimax-m3-chat']
    // v2: [{ name: 'glm5-chat', model: 'glm5-chat', role: 'assistant' }, ...]
    let participants = (arenaData.participants || [])
        .map(p => {
            if (typeof p === 'string') return p;
            if (p && typeof p === 'object' && p.name) return p.name;
            return null;
        })
        .filter(Boolean);

    // Fallback: derive participants from the speaker set in messages.
    if (participants.length === 0) {
        const speakers = new Set();
        for (const m of arenaData.messages) {
            if (m.speaker) speakers.add(m.speaker);
        }
        participants = [...speakers];
    }

    // The moderator's first message is the SEED PROMPT — the literal text
    // sent to participantA. We extract it and expose it as `seedPrompt`.
    // The `topic` field on the Arena export is the AI-generated summary title
    // produced AFTER the conversation; do NOT use it for the title slide.
    //
    // The moderator message itself is stripped from `messages` so the LLM
    // never sees it. The title slide is injected deterministically in the
    // post-processing step of llm-clean.js, using `seedPrompt`.
    const moderatorIdx = arenaData.messages.findIndex(
        m => (m.speaker || '').toLowerCase() === 'moderator'
    );
    const moderatorMessage = moderatorIdx >= 0 ? arenaData.messages[moderatorIdx] : null;
    const seedPrompt = moderatorMessage
        ? (moderatorMessage.content || '').replace(/^\s*Topic:\s*/i, '').trim()
        : null;

    return {
        id: arenaData.id || arenaData.chatInfo?.id || 'unknown',
        exportedAt: arenaData.exportedAt || new Date().toISOString(),
        // Kept for backward compat / display — but DO NOT use for the title slide.
        topic: arenaData.topic || arenaData.chatInfo?.title || 'Untitled Conversation',
        // The actual seed prompt that the first model responded to.
        // Verbatim from messages[0].content, minus the `Topic:` prefix.
        seedPrompt: seedPrompt,
        // Raw, unprefixed moderator content including `Topic:` prefix, for
        // the deterministic title slide to speak verbatim if it wants.
        seedPromptRaw: moderatorMessage ? (moderatorMessage.content || '').trim() : null,
        participants: participants,
        // Messages WITHOUT the moderator. The LLM never sees the moderator.
        messages: arenaData.messages
            .filter((_, i) => i !== moderatorIdx)
            .map(m => ({
                speaker: m.speaker || m.model || 'Unknown',
                role: m.role || 'assistant',
                content: m.content || m.text || '',
                createdAt: m.createdAt || null,
                model: m.model || m.speaker || null
            }))
    };
}

function main() {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.error('Usage: node pipeline/importer.js <arena-export.json> [output-dir]');
        process.exit(1);
    }

    const inputPath = path.resolve(args[0]);
    const outputDir = path.resolve(args[1] || 'pipeline/output');

    if (!fs.existsSync(inputPath)) {
        console.error(`Input file not found: ${inputPath}`);
        process.exit(1);
    }

    fs.mkdirSync(outputDir, { recursive: true });

    const raw = fs.readFileSync(inputPath, 'utf-8');
    const arenaData = JSON.parse(raw);
    const source = parseArenaExport(arenaData);

    const outputPath = path.join(outputDir, 'source.json');
    fs.writeFileSync(outputPath, JSON.stringify(source, null, 2), 'utf-8');

    console.log(`[Importer] ${source.messages.length} messages from "${source.topic}"`);
    console.log(`[Importer] Participants: ${source.participants.join(', ')}`);
    console.log(`[Importer] Output: ${outputPath}`);
}

if (require.main === module) {
    main();
}

module.exports = { parseArenaExport };
