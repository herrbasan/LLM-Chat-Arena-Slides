// pipeline/pipeline.js
// Full Pipeline: Arena JSON → LLM Clean → TTS → Alignment → Annotated Deck
// Usage: node pipeline/pipeline.js <arena-export.json> [output-dir]

const path = require('path');
const { parseArenaExport } = require('./importer.js');
const { cleanWithLLM } = require('./llm-clean.js');
const { processDeck: ttsProcess } = require('./tts.js');
const { processDeck: alignProcess } = require('./align.js');
const fs = require('fs');

async function runPipeline(inputPath, outputDir) {
    const startTime = Date.now();
    console.log('═══════════════════════════════════════════');
    console.log('  Arena Slideshow Pipeline');
    console.log('═══════════════════════════════════════════');
    console.log(`  Input:  ${inputPath}`);
    console.log(`  Output: ${outputDir}\n`);

    fs.mkdirSync(outputDir, { recursive: true });

    // ─── Step 1: Import ───────────────────────────────────────
    console.log('── Step 1/4: Import Arena JSON ──');
    const raw = fs.readFileSync(inputPath, 'utf-8');
    const arenaData = JSON.parse(raw);
    const source = parseArenaExport(arenaData);

    const sourcePath = path.join(outputDir, 'source.json');
    fs.writeFileSync(sourcePath, JSON.stringify(source, null, 2), 'utf-8');
    console.log(`  ${source.messages.length} messages from "${source.topic}"\n`);

    // ─── Step 2: LLM Text Cleaning ─────────────────────────────
    const llmDeckPath = path.join(outputDir, 'slide_deck_llm.json');
    const skipLLM = process.argv.includes('--skip-llm');

    let deck;
    if (!skipLLM && fs.existsSync(llmDeckPath)) {
        console.log('── Step 2/4: LLM Text Cleaning (cached) ──');
        deck = JSON.parse(fs.readFileSync(llmDeckPath, 'utf-8'));
        console.log(`  Using cached deck: ${deck.slides.length} slides`);
        console.log(`  (delete ${llmDeckPath} or use --skip-llm to re-run)\n`);
    } else if (skipLLM) {
        console.log('── Step 2/4: LLM Text Cleaning (skipped) ──');
        // Fall back to source.json for raw data
        const sourceForFallback = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));
        deck = await cleanWithLLM(sourceForFallback, outputDir);
    } else {
        console.log('── Step 2/4: LLM Text Cleaning & Slide Construction ──');
        deck = await cleanWithLLM(source, outputDir);
        console.log(`  ${deck.slides.length} slides created\n`);
    }

    // ─── Step 3: TTS Generation ───────────────────────────────
    console.log('── Step 3/4: TTS Generation ──');
    await ttsProcess(llmDeckPath, outputDir);
    const ttsDeckPath = path.join(outputDir, 'slide_deck_tts.json');
    const ttsDeck = JSON.parse(fs.readFileSync(ttsDeckPath, 'utf-8'));
    const ttsSuccess = ttsDeck.slides.filter(s => s.tts && !s.tts.error).length;
    console.log(`  ${ttsSuccess}/${ttsDeck.slides.length} slides generated\n`);

    // ─── Step 4: Word Alignment ───────────────────────────────
    console.log('── Step 4/4: Word Alignment ──');
    await alignProcess(ttsDeckPath, outputDir);

    // ─── Summary ──────────────────────────────────────────────
    const finalDeckPath = path.join(outputDir, 'slide_deck_aligned.json');
    const finalDeck = JSON.parse(fs.readFileSync(finalDeckPath, 'utf-8'));

    const alignedSlides = finalDeck.slides.filter(s => s.tts && s.tts.words && s.tts.words.length > 0);
    const totalDurationMs = alignedSlides.reduce((sum, s) => sum + (s.tts.durationMs || 0), 0);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('═══════════════════════════════════════════');
    console.log('  Pipeline Complete');
    console.log('═══════════════════════════════════════════');
    console.log(`  Slides:        ${finalDeck.slides.length}`);
    console.log(`  With audio:    ${finalDeck.slides.filter(s => s.tts && !s.tts.error && s.tts.audioFile).length}`);
    console.log(`  With timings:  ${alignedSlides.length}`);
    console.log(`  Total audio:   ${(totalDurationMs / 1000).toFixed(1)}s`);
    console.log(`  Elapsed:       ${elapsed}s`);
    console.log(`  Final output:  ${finalDeckPath}`);
    console.log('═══════════════════════════════════════════\n');

    return finalDeck;
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.error('Usage: node pipeline/pipeline.js <arena-export.json> [output-dir]');
        process.exit(1);
    }

    const inputPath = path.resolve(args[0]);
    const outputDir = path.resolve(args[1] || 'pipeline/output');

    if (!fs.existsSync(inputPath)) {
        console.error(`Input file not found: ${inputPath}`);
        process.exit(1);
    }

    await runPipeline(inputPath, outputDir);
}

if (require.main === module) {
    main().catch(err => {
        console.error('\nPipeline FATAL:', err.message);
        console.error(err.stack);
        process.exit(1);
    });
}

module.exports = { runPipeline };
