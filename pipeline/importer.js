// pipeline/importer.js
// Arena Export JSON → Raw Source Data
// Thin parser — no text cleaning, no slide creation.
// Text cleaning and slide construction are handled by llm-clean.js.

const fs = require('fs');
const path = require('path');

function parseArenaExport(arenaData) {
    if (!arenaData || !Array.isArray(arenaData.messages)) {
        throw new Error('Invalid Arena export: missing messages array');
    }

    const participants = (arenaData.participants || []).filter(Boolean);
    if (participants.length === 0) {
        const speakers = new Set();
        for (const m of arenaData.messages) {
            if (m.speaker) speakers.add(m.speaker);
        }
        participants.push(...speakers);
    }

    return {
        id: arenaData.id || 'unknown',
        exportedAt: arenaData.exportedAt || new Date().toISOString(),
        topic: arenaData.topic || 'Untitled Conversation',
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
