// server/reimport.js
//
// One-off script. Reads a raw Arena export from the reference/ folder,
// runs it through the refactored pipeline (importer + cleanWithLLM), and
// writes a fresh project record to server/data/slideshows.jsonl.
//
// Use this to seed a deck with the new slide structure (topic instead
// of title, details with meta block, conversation slides with explicit
// splitCount, etc.) without going through the editor's import flow.
//
// Usage:
//   node server/reimport.js [path-to-arena-export.json] [project-id]
//
// If arguments are omitted, defaults to the House vs Grooves reference
// and a deterministic project id.

const fs = require('fs');
const path = require('path');
const { parseArenaExport } = require('../pipeline/importer.js');
const { cleanWithLLM } = require('../pipeline/llm-clean.js');

const REFERENCE_PATH = process.argv[2] || path.join(__dirname, '..', 'reference',
    'arena-house_vs__grooves__being_caugh-glm5-chat-vs-minimax-m3-chat-2026-06-08.json');
const PROJECT_ID = process.argv[3] || 'slideshow_house_vs_grooves';
const JSONL_PATH = path.join(__dirname, 'data', 'slideshows.jsonl');

async function main() {
    if (!fs.existsSync(REFERENCE_PATH)) {
        throw new Error(`Reference file not found: ${REFERENCE_PATH}`);
    }

    console.log(`Reading ${REFERENCE_PATH}...`);
    const raw = JSON.parse(fs.readFileSync(REFERENCE_PATH, 'utf-8'));

    // Parse → clean. The cleanWithLLM is the canonical builder. It
    // produces a deck with the new v2 structure (topic, meta block,
    // splitCount, etc.).
    console.log('Parsing + cleaning...');
    const source = parseArenaExport(raw);
    const deck = await cleanWithLLM(source, null, () => {});

    // Stamp the project id. cleanWithLLM doesn't know about the
    // wrapping record shape — that's the editor's job — so we set
    // the id here.
    deck._id = PROJECT_ID;
    deck.createdAt = Date.now();
    deck.updatedAt = Date.now();

    // Truncate the JSONL before writing the new record. This is a
    // destructive reimport — wipes all existing projects. The cache
    // is also wiped (deleted separately by the user, or the next
    // "Render All" will just regenerate what's stale).
    console.log(`Truncating ${JSONL_PATH}...`);
    fs.writeFileSync(JSONL_PATH, '');

    // Write the new record as the first (and only) line.
    fs.appendFileSync(JSONL_PATH, JSON.stringify(deck) + '\n');

    console.log('');
    console.log('=== Reimport summary ===');
    console.log(`Project id: ${PROJECT_ID}`);
    console.log(`Deck version: ${deck.version}`);
    console.log(`Total slides: ${deck.slides.length}`);
    console.log(`Conversation slides: ${deck.slides.filter(s => s.type === 'conversation').length}`);
    console.log(`Turns (distinct originalIdx): ${new Set(deck.slides.filter(s => s.type === 'conversation').map(s => s.originalIdx)).size}`);
    console.log(`Opening: setup → details → topic → ${deck.slides.length - 4} conversation → end`);
}

main().catch(err => {
    console.error('Reimport failed:', err.message);
    console.error(err.stack);
    process.exit(1);
});
