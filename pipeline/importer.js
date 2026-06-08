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

    return {
        id: arenaData.id || arenaData.chatInfo?.id || 'unknown',
        exportedAt: arenaData.exportedAt || new Date().toISOString(),
        topic: arenaData.topic || arenaData.chatInfo?.title || 'Untitled Conversation',
        participants: participants,
        messages: arenaData.messages.map(m => ({
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
