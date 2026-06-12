// pipeline/pipeline.js
// Full Pipeline: Arena JSON → Clean → Paragraphs → TTS → Alignment → v3 Project
//
// Supports both v2 (legacy slide deck) and v3 (messages + paragraphs) output.
// Default is v3. Use --v2 to produce the legacy slide-deck format.
//
// Usage:
//   node pipeline/pipeline.js <arena-export.json> [output-dir] [--skip-clean] [--v2]

const path = require('path');
const fs = require('fs');
const { parseArenaExport } = require('./importer.js');
const { buildProject } = require('./build-messages.js');
const { cleanWithLLM } = require('./build-deck.js');
const { processInput: ttsProcess } = require('./tts.js');
const { processInput: alignProcess } = require('./align.js');

async function runPipelineV3(inputPath, outputDir, options = {}) {
    const startTime = Date.now();
    console.log('═══════════════════════════════════════════');
    console.log('  Arena Slideshow Pipeline (v3 — paragraphs)');
    console.log('═══════════════════════════════════════════');
    console.log(`  Input:  ${inputPath}`);
    console.log(`  Output: ${outputDir}\n`);

    fs.mkdirSync(outputDir, { recursive: true });

    // ─── Step 1: Import + Clean + Split into paragraphs ────────
    console.log('── Step 1/3: Import, Clean, Split into Paragraphs ──');
    const raw = fs.readFileSync(inputPath, 'utf-8');
    const arenaData = JSON.parse(raw);

    const projectPath = path.join(outputDir, 'project_v3.json');
    const skipLLM = options.skipClean;
    const cachedProject = !skipLLM && fs.existsSync(projectPath);

    let project;
    if (cachedProject) {
        console.log('  Using cached project (delete project_v3.json to re-run)');
        project = JSON.parse(fs.readFileSync(projectPath, 'utf-8'));
    } else {
        project = await buildProject(arenaData, outputDir, undefined, { skipClean: options.skipClean });
    }

    const totalParagraphs = project.messages.reduce((sum, m) => sum + m.paragraphs.length, 0);
    console.log(`  ${project.messages.length} messages, ${totalParagraphs} paragraphs\n`);

    // ─── Step 2: TTS Generation ───────────────────────────────
    console.log('── Step 2/3: TTS Generation (per paragraph) ──');
    const ttsPath = path.join(outputDir, 'project_v3_tts.json');
    if (fs.existsSync(ttsPath)) {
        console.log('  Using cached TTS (delete project_v3_tts.json to re-run)');
        project = JSON.parse(fs.readFileSync(ttsPath, 'utf-8'));
    } else {
        await ttsProcess(path.resolve(projectPath), outputDir);
        project = JSON.parse(fs.readFileSync(ttsPath, 'utf-8'));
    }
    const ttsSuccess = project.messages.reduce((sum, m) =>
        sum + m.paragraphs.filter(p => p.audioFile && !p.ttsError).length, 0);
    console.log(`  ${ttsSuccess}/${totalParagraphs} paragraphs have audio\n`);

    // ─── Step 3: Word Alignment ───────────────────────────────
    console.log('── Step 3/3: Word Alignment (per paragraph) ──');
    const alignedPath = path.join(outputDir, 'project_v3_aligned.json');
    if (fs.existsSync(alignedPath)) {
        console.log('  Using cached alignment (delete project_v3_aligned.json to re-run)');
        project = JSON.parse(fs.readFileSync(alignedPath, 'utf-8'));
    } else {
        await alignProcess(path.resolve(ttsPath), outputDir);
        project = JSON.parse(fs.readFileSync(alignedPath, 'utf-8'));
    }

    // ─── Summary ──────────────────────────────────────────────
    const alignedParagraphs = project.messages.reduce((sum, m) =>
        sum + m.paragraphs.filter(p => p.words && p.words.length > 0).length, 0);
    const totalDurationMs = project.messages.reduce((sum, m) =>
        sum + m.paragraphs.reduce((pSum, p) => pSum + (p.durationMs || 0), 0), 0);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('═══════════════════════════════════════════');
    console.log('  Pipeline Complete (v3)');
    console.log('═══════════════════════════════════════════');
    console.log(`  Messages:      ${project.messages.length}`);
    console.log(`  Paragraphs:    ${totalParagraphs}`);
    console.log(`  With audio:    ${ttsSuccess}`);
    console.log(`  With timings:  ${alignedParagraphs}`);
    console.log(`  Total audio:   ${(totalDurationMs / 1000).toFixed(1)}s`);
    console.log(`  Elapsed:       ${elapsed}s`);
    console.log(`  Final output:  ${alignedPath}`);
    console.log('═══════════════════════════════════════════\n');

    return project;
}

async function runPipelineV2(inputPath, outputDir, options = {}) {
    const startTime = Date.now();
    console.log('═══════════════════════════════════════════');
    console.log('  Arena Slideshow Pipeline (v2 — slides)');
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
    const skipLLM = options.skipClean;

    let deck;
    if (!skipLLM && fs.existsSync(llmDeckPath)) {
        console.log('── Step 2/4: LLM Text Cleaning (cached) ──');
        deck = JSON.parse(fs.readFileSync(llmDeckPath, 'utf-8'));
        console.log(`  Using cached deck: ${deck.slides.length} slides\n`);
    } else {
        console.log('── Step 2/4: LLM Text Cleaning & Slide Construction ──');
        deck = await cleanWithLLM(source, outputDir);
        console.log(`  ${deck.slides.length} slides created\n`);
    }

    // ─── Step 3: TTS Generation ───────────────────────────────
    console.log('── Step 3/4: TTS Generation ──');
    await ttsProcess(path.resolve(llmDeckPath), outputDir);
    const ttsDeckPath = path.join(outputDir, 'slide_deck_tts.json');
    const ttsDeck = JSON.parse(fs.readFileSync(ttsDeckPath, 'utf-8'));
    const ttsSuccess = ttsDeck.slides.filter(s => s.tts && !s.tts.error).length;
    console.log(`  ${ttsSuccess}/${ttsDeck.slides.length} slides generated\n`);

    // ─── Step 4: Word Alignment ───────────────────────────────
    console.log('── Step 4/4: Word Alignment ──');
    await alignProcess(path.resolve(ttsDeckPath), outputDir);

    // ─── Summary ──────────────────────────────────────────────
    const finalDeckPath = path.join(outputDir, 'slide_deck_aligned.json');
    const finalDeck = JSON.parse(fs.readFileSync(finalDeckPath, 'utf-8'));

    const alignedSlides = finalDeck.slides.filter(s => s.tts && s.tts.words && s.tts.words.length > 0);
    const totalDurationMs = alignedSlides.reduce((sum, s) => sum + (s.tts.durationMs || 0), 0);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('═══════════════════════════════════════════');
    console.log('  Pipeline Complete (v2)');
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
        console.error('Usage: node pipeline/pipeline.js <arena-export.json> [output-dir] [--skip-clean] [--v2]');
        process.exit(1);
    }

    const inputPath = path.resolve(args[0]);
    const outputDir = path.resolve(args[1] || 'pipeline/output');
    const useV2 = args.includes('--v2');
    const skipClean = args.includes('--skip-clean');

    if (!fs.existsSync(inputPath)) {
        console.error(`Input file not found: ${inputPath}`);
        process.exit(1);
    }

    if (useV2) {
        await runPipelineV2(inputPath, outputDir, { skipClean });
    } else {
        await runPipelineV3(inputPath, outputDir, { skipClean });
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error('\nPipeline FATAL:', err.message);
        console.error(err.stack);
        process.exit(1);
    });
}

module.exports = { runPipelineV3, runPipelineV2 };
