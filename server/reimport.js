// server/reimport.js
//
// One-off script. Reads a raw Arena export from the reference/ folder,
// runs it through the pipeline, and writes a fresh project record to
// server/data/slideshows.jsonl.
//
// v3 mode (default): paragraph architecture — build-messages.js
// v2 mode (--v2): slide architecture — build-deck.js
//
// Usage:
//   node server/reimport.js [path-to-arena-export.json] [project-id]
//   node server/reimport.js --v2 [path-to-arena-export.json] [project-id]

const fs = require('fs');
const path = require('path');
const { parseArenaExport } = require('../pipeline/importer.js');
const { cleanWithLLM } = require('../pipeline/build-deck.js');
const { buildProject } = require('../pipeline/build-messages.js');

const USE_V3 = !process.argv.includes('--v2');
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const SKIP_CLEAN = process.argv.includes('--skip-clean');
const REFERENCE_PATH = args[0] || path.join(__dirname, '..', 'reference',
    'arena-house_vs__grooves__being_caugh-glm5-chat-vs-minimax-m3-chat-2026-06-08.json');
const PROJECT_ID = args[1] || (USE_V3 ? 'slideshow_house_vs_grooves_v3' : 'slideshow_house_vs_grooves');
const JSONL_PATH = path.join(__dirname, 'data', 'slideshows.jsonl');

async function main() {
    if (!fs.existsSync(REFERENCE_PATH)) {
        throw new Error(`Reference file not found: ${REFERENCE_PATH}`);
    }

    console.log(`Reading ${REFERENCE_PATH}...`);
    const raw = JSON.parse(fs.readFileSync(REFERENCE_PATH, 'utf-8'));

    if (USE_V3) {
        console.log('Building v3 project (paragraph architecture)...');
        const project = await buildProject(raw, null, (stage, message, pct) => {
            if (message) console.log(`  [${stage}] ${message} (${pct.toFixed(0)}%)`);
        }, { useLLM: true });

        project._id = PROJECT_ID;
        project.createdAt = Date.now();
        project.updatedAt = Date.now();

        console.log(`Truncating ${JSONL_PATH}...`);
        fs.writeFileSync(JSONL_PATH, '');
        fs.appendFileSync(JSONL_PATH, JSON.stringify(project) + '\n');

        const totalParagraphs = project.messages.reduce((sum, m) => sum + m.paragraphs.length, 0);
        console.log('');
        console.log('=== Reimport summary (v3) ===');
        console.log(`Project id: ${PROJECT_ID}`);
        console.log(`Version: ${project.version}`);
        console.log(`Messages: ${project.messages.length}`);
        console.log(`Total paragraphs: ${totalParagraphs}`);
        console.log(`Seed prompt: ${project.source?.seedPromptRaw?.substring(0, 80)}...`);
    } else {
        console.log('Parsing + cleaning (v2 slide architecture)...');
        const source = parseArenaExport(raw);
        const deck = await cleanWithLLM(source, null, () => {}, { skipClean: SKIP_CLEAN });

        deck._id = PROJECT_ID;
        deck.createdAt = Date.now();
        deck.updatedAt = Date.now();

        console.log(`Truncating ${JSONL_PATH}...`);
        fs.writeFileSync(JSONL_PATH, '');
        fs.appendFileSync(JSONL_PATH, JSON.stringify(deck) + '\n');

        console.log('');
        console.log('=== Reimport summary (v2) ===');
        console.log(`Project id: ${PROJECT_ID}`);
        console.log(`Deck version: ${deck.version}`);
        console.log(`Total slides: ${deck.slides.length}`);
        console.log(`Conversation slides: ${deck.slides.filter(s => s.type === 'conversation').length}`);
    }
}

main().catch(err => {
    console.error('Reimport failed:', err.message);
    console.error(err.stack);
    process.exit(1);
});
