// pipeline/tts.js
// Slide Deck → TTS Audio Files via nSpeech
// Reads slide_deck.json, generates audio for each slide, updates deck.

const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────

const NSPEECH_URL = process.env.NSPEECH_URL || 'http://192.168.0.145:2233';

// ─── Helpers ──────────────────────────────────────────────────

function getSlideText(slide) {
    // Use the most appropriate text field for speech
    let text;
    if (slide.type === 'title' || slide.type === 'end') {
        text = slide.narration || slide.text || '';
    } else {
        text = slide.text || slide.narration || '';
    }
    // Strip markdown *emphasis* markers from spoken text. nSpeech would
    // otherwise speak "asterisk" literally. Mirrors the server-side fix
    // in server/server.js — keep them in sync.
    return text ? text.toString().replace(/\*+/g, '') : text;
}

function getVoiceConfig(slide, voiceMapping) {
    const role = slide.speaker || 'narrator';
    const config = voiceMapping[role] || voiceMapping.narrator;
    if (!config) {
        throw new Error(`No voice mapping found for speaker "${role}"`);
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

// ─── TTS Generation ───────────────────────────────────────────

async function generateTtsForSlide(slide, voiceMapping, outputDir, slideIndex) {
    const text = getSlideText(slide);
    if (!text || text.trim().length === 0) {
        console.log(`  [Slide ${slideIndex}] Skipping — no text to speak`);
        return null;
    }

    const voiceConfig = getVoiceConfig(slide, voiceMapping);
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

// ─── CLI ──────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.error('Usage: node pipeline/tts.js <slide_deck.json> [output-dir]');
        process.exit(1);
    }

    const deckPath = path.resolve(args[0]);
    const outputDir = path.resolve(args[1] || 'pipeline/output');

    if (!fs.existsSync(deckPath)) {
        console.error(`Input file not found: ${deckPath}`);
        process.exit(1);
    }

    await processDeck(deckPath, outputDir);
}

if (require.main === module) {
    main().catch(err => {
        console.error('FATAL:', err.message);
        process.exit(1);
    });
}

module.exports = { processDeck };
