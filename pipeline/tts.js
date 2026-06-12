// pipeline/tts.js
// TTS Audio Generation via nSpeech
//
// Supports two input formats:
//   v2 (deck with slides): processes each slide → slide_000.mp3
//   v3 (project with messages/paragraphs): processes each paragraph → msg_000_p000.mp3
//
// The version is auto-detected from the input JSON structure.

const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────

const NSPEECH_URL = process.env.NSPEECH_URL || 'http://192.168.0.145:2233';

// ─── Helpers ──────────────────────────────────────────────────

function getSpokenText(text) {
    if (!text) return '';
    // Strip markdown *emphasis* markers from spoken text. nSpeech would
    // otherwise speak "asterisk" literally. Mirrors the server-side fix
    // in server/server.js — keep them in sync.
    return text.toString().replace(/\*+/g, '');
}

function getVoiceConfig(role, voiceMapping) {
    const config = voiceMapping[role] || voiceMapping.narrator;
    if (!config) {
        throw new Error(`No voice mapping found for role "${role}"`);
    }
    return config;
}

function buildTtsUrl(text, voiceConfig) {
    const params = new URLSearchParams({
        text: text,
        voice_name: voiceConfig.voice,
        speed: (voiceConfig.speed || 1.0).toString(),
        output_format: 'mp3'
    });
    return `${NSPEECH_URL}/tts?${params.toString()}`;
}

function computeRenderHash(text, voice, speed) {
    const state = `${text || ''}|${voice || ''}|${speed || 1.0}`;
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < state.length; i++) {
        const ch = state.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h2 >>> 13), 3266489909);
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

// ─── v3: Paragraph-level TTS ──────────────────────────────────

async function generateTtsForParagraph(text, voiceConfig, audioDir, msgIdx, paraIdx) {
    const spokenText = getSpokenText(text);
    if (!spokenText || spokenText.trim().length === 0) {
        console.log(`  [Msg ${msgIdx} Para ${paraIdx}] Skipping — no text to speak`);
        return null;
    }

    const renderHash = computeRenderHash(spokenText, voiceConfig.voice, voiceConfig.speed);
    const filename = `msg_${String(msgIdx).padStart(3, '0')}_p${String(paraIdx).padStart(3, '0')}_${renderHash}.mp3`;
    const filePath = path.join(audioDir, filename);
    const audioUrl = `/cache/audio/{projectId}/${filename}`;

    // Cache hit: reuse existing audio file
    if (fs.existsSync(filePath)) {
        console.log(`  [Msg ${msgIdx} Para ${paraIdx}] Cached: ${filename}`);
        return {
            audioFile: filename,
            audioPath: filePath,
            audioUrl: audioUrl,
            voice: voiceConfig.voice,
            speed: voiceConfig.speed,
            renderHash: renderHash,
            cached: true
        };
    }

    const url = buildTtsUrl(spokenText, voiceConfig);
    console.log(`  [Msg ${msgIdx} Para ${paraIdx}] "${spokenText.substring(0, 60)}${spokenText.length > 60 ? '...' : ''}"`);

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`nSpeech TTS failed for msg ${msgIdx} para ${paraIdx}: HTTP ${response.status} ${response.statusText}`);
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    if (audioBuffer.length === 0) {
        throw new Error(`nSpeech TTS returned empty audio for msg ${msgIdx} para ${paraIdx}`);
    }

    fs.writeFileSync(filePath, audioBuffer);
    console.log(`    Saved: ${filename} (${(audioBuffer.length / 1024).toFixed(1)} KB)`);

    return {
        audioFile: filename,
        audioPath: filePath,
        audioUrl: audioUrl,
        voice: voiceConfig.voice,
        speed: voiceConfig.speed,
        byteLength: audioBuffer.length,
        renderHash: renderHash
    };
}

async function processProject(project, outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });

    const audioDir = path.join(outputDir, 'audio');
    fs.mkdirSync(audioDir, { recursive: true });

    const totalParagraphs = project.messages.reduce((sum, m) => sum + m.paragraphs.length, 0);
    console.log(`\n[TTS v3] Processing ${project.messages.length} messages (${totalParagraphs} paragraphs)...\n`);

    let successCount = 0;
    let skipCount = 0;
    let failCount = 0;

    for (let mi = 0; mi < project.messages.length; mi++) {
        const message = project.messages[mi];
        const voiceConfig = getVoiceConfig(message.speaker, project.voiceMapping);

        for (let pi = 0; pi < message.paragraphs.length; pi++) {
            const para = message.paragraphs[pi];
            try {
                const result = await generateTtsForParagraph(para.text, voiceConfig, audioDir, mi, pi);
                if (result) {
                    Object.assign(para, result);
                    successCount++;
                } else {
                    skipCount++;
                }
            } catch (err) {
                console.error(`  [Msg ${mi} Para ${pi}] ERROR: ${err.message}`);
                para.ttsError = err.message;
                failCount++;
            }
        }
    }

    const outputPath = path.join(outputDir, 'project_v3_tts.json');
    fs.writeFileSync(outputPath, JSON.stringify(project, null, 2), 'utf-8');

    console.log(`\n[TTS v3] Complete: ${successCount} generated, ${skipCount} skipped, ${failCount} failed`);
    console.log(`[TTS v3] Output: ${outputPath}`);
    console.log(`[TTS v3] Audio:  ${audioDir}\n`);

    return project;
}

// ─── v2: Slide-level TTS (legacy) ─────────────────────────────

function getSlideText(slide) {
    let text;
    if (slide.type === 'title' || slide.type === 'end') {
        text = slide.narration || slide.text || '';
    } else {
        text = slide.text || slide.narration || '';
    }
    return getSpokenText(text);
}

async function generateTtsForSlide(slide, voiceMapping, outputDir, slideIndex) {
    const text = getSlideText(slide);
    if (!text || text.trim().length === 0) {
        console.log(`  [Slide ${slideIndex}] Skipping — no text to speak`);
        return null;
    }

    const voiceConfig = getVoiceConfig(slide.speaker, voiceMapping);
    const url = buildTtsUrl(text, voiceConfig);

    console.log(`  [Slide ${slideIndex}] "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}"`);
    console.log(`    Voice: ${voiceConfig.voice}, Speed: ${voiceConfig.speed}`);

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`nSpeech TTS failed for slide ${slideIndex}: HTTP ${response.status} ${response.statusText}`);
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    if (audioBuffer.length === 0) {
        throw new Error(`nSpeech TTS returned empty audio for slide ${slideIndex}`);
    }

    const filename = `slide_${String(slideIndex).padStart(3, '0')}.mp3`;
    const filePath = path.join(outputDir, filename);
    fs.writeFileSync(filePath, audioBuffer);

    console.log(`    Saved: ${filename} (${(audioBuffer.length / 1024).toFixed(1)} KB)`);

    return {
        audioFile: filename,
        audioPath: filePath,
        voice: voiceConfig.voice,
        speed: voiceConfig.speed,
        byteLength: audioBuffer.length
    };
}

async function processDeck(deckPath, outputDir) {
    const deck = JSON.parse(fs.readFileSync(deckPath, 'utf-8'));
    fs.mkdirSync(outputDir, { recursive: true });

    const audioDir = path.join(outputDir, 'audio');
    fs.mkdirSync(audioDir, { recursive: true });

    console.log(`\n[TTS] Processing ${deck.slides.length} slides...\n`);

    let successCount = 0;
    let skipCount = 0;

    for (let i = 0; i < deck.slides.length; i++) {
        const slide = deck.slides[i];
        try {
            const ttsResult = await generateTtsForSlide(slide, deck.voiceMapping, audioDir, i);
            if (ttsResult) {
                slide.tts = ttsResult;
                successCount++;
            } else {
                skipCount++;
            }
        } catch (err) {
            console.error(`  [Slide ${i}] ERROR: ${err.message}`);
            slide.tts = { error: err.message };
        }
    }

    const deckOutputPath = path.join(outputDir, 'slide_deck_tts.json');
    fs.writeFileSync(deckOutputPath, JSON.stringify(deck, null, 2), 'utf-8');

    console.log(`\n[TTS] Complete: ${successCount} generated, ${skipCount} skipped, ${deck.slides.length - successCount - skipCount} failed`);
    console.log(`[TTS] Output: ${deckOutputPath}`);
    console.log(`[TTS] Audio:  ${audioDir}\n`);

    return deck;
}

// ─── Auto-detect entry point ──────────────────────────────────

async function processInput(inputPath, outputDir) {
    const data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));

    if (data.version === 3 && data.messages && data.messages[0]?.paragraphs) {
        console.log('[TTS] Detected v3 project (messages + paragraphs)');
        return processProject(data, outputDir);
    }

    if (data.slides) {
        console.log('[TTS] Detected v2 deck (slides)');
        return processDeck(inputPath, outputDir);
    }

    throw new Error('Unrecognized input format: expected v2 deck with slides or v3 project with messages.paragraphs');
}

// ─── CLI ──────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.error('Usage: node pipeline/tts.js <project_v3.json | slide_deck.json> [output-dir]');
        process.exit(1);
    }

    const inputPath = path.resolve(args[0]);
    const outputDir = path.resolve(args[1] || 'pipeline/output');

    if (!fs.existsSync(inputPath)) {
        console.error(`Input file not found: ${inputPath}`);
        process.exit(1);
    }

    await processInput(inputPath, outputDir);
}

if (require.main === module) {
    main().catch(err => {
        console.error('FATAL:', err.message);
        process.exit(1);
    });
}

module.exports = { processDeck, processProject, processInput };
