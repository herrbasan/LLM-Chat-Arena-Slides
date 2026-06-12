// pipeline/build-deck.js
// Deterministic Slide Deck Builder
//
// Takes a parsed Arena source (from importer.js) and builds a complete
// slide deck with the v2 structure:
//   setup → details → topic → [conversation slides] → end
//
// The opening/closing slides are deterministic — same shape every time.
// Conversation slides are one-per-message, with long messages split at
// sentence boundaries.
//
// Before building slides, message text is cleaned via pipeline/clean.js
// (LLM gateway call per message) to remove client-side noise, stage
// directions, and other artifacts that sound unnatural when spoken by TTS.
// Pass { skipClean: true } to bypass this (e.g. for quick reimports).

const fs = require('fs');
const path = require('path');
const { cleanAllMessages } = require('./clean.js');

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

// ─── Date helpers ──────────────────────────────────────────────

const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

const NUMBER_WORDS_0_19 = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'
];
const NUMBER_WORDS_VOWEL_NEXT = {
    1: 'first', 2: 'second', 3: 'third', 5: 'fifth', 8: 'eighth', 9: 'ninth', 12: 'twelfth'
};
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function spell(n) {
    if (n < 0) return 'negative ' + spell(-n);
    if (n < 20) return NUMBER_WORDS_0_19[n];
    if (n < 100) {
        const t = Math.floor(n / 10);
        const r = n % 10;
        return r ? `${TENS[t]}-${NUMBER_WORDS_0_19[r]}` : TENS[t];
    }
    if (n < 1000) {
        const h = Math.floor(n / 100);
        const r = n % 100;
        const head = h === 1 ? 'one hundred' : `${NUMBER_WORDS_0_19[h]} hundred`;
        return r ? `${head} ${spell(r)}` : head;
    }
    if (n < 10000) {
        const th = Math.floor(n / 1000);
        const rest = n % 1000;
        const head = th < 20 ? NUMBER_WORDS_0_19[th] + ' thousand' : `${spell(th)} thousand`;
        return rest ? `${head} ${spell(rest)}` : head;
    }
    return String(n);
}

function capitalize(s) {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatHumanDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const day = d.getUTCDate();
    const month = MONTHS[d.getUTCMonth()];
    const year = d.getUTCFullYear();
    const dayWord = day < 20 && NUMBER_WORDS_VOWEL_NEXT[day]
        ? NUMBER_WORDS_VOWEL_NEXT[day]
        : `${spell(day)}th`;
    return `${month} ${dayWord}, ${spell(year)}`;
}

// ─── Opening / closing slides (deterministic) ──────────────────

function buildOpeningSlides(source) {
    const participants = source.participants.filter(Boolean);
    const dateText = formatHumanDate(source.exportedAt) || 'an unknown date';
    const participantLine = participants.length >= 2
        ? `${participants[0]} and ${participants[1]}`
        : (participants[0] || 'two language models');

    const turnCount = (source.messages || []).length;
    const modelChips = participants.map((name, i) => ({
        name,
        role: i === 0 ? 'participantA' : 'participantB'
    }));
    const renderedAt = source.renderedAt || source.exportedAt;

    return [
        {
            type: 'setup',
            speaker: 'narrator',
            label: 'Narrator',
            text: 'Setup',
            narration: "You're about to hear a conversation between two language models. They were given a single prompt \u2014 a topic \u2014 and then left to respond to each other directly, with no further human involvement. What follows is unedited and unsteered. The models chose every word themselves.",
            tts: null
        },
        {
            type: 'details',
            speaker: 'narrator',
            label: 'Narrator',
            text: 'Details',
            narration: `This recording was generated on ${dateText}, featuring the models ${participantLine}. ${turnCount === 1 ? 'One' : capitalize(spell(turnCount))} turn${turnCount === 1 ? '' : 's'}.`,
            tts: null,
            meta: {
                recordedAt: source.exportedAt,
                renderedAt: renderedAt,
                models: modelChips,
                turnCount: turnCount
            }
        },
        {
            type: 'topic',
            speaker: 'narrator',
            label: 'Narrator',
            text: source.seedPromptRaw || source.seedPrompt || source.topic,
            narration: source.seedPromptRaw || source.seedPrompt || source.topic,
            tts: null
        }
    ];
}

function buildEndSlide() {
    return {
        type: 'end',
        speaker: 'narrator',
        label: 'Narrator',
        text: 'End of conversation.',
        tts: null
    };
}

// ─── Conversation-slide generation (deterministic) ────────────

const SLIDE_TEXT_SOFT_LIMIT = 600;
const SLIDE_TEXT_HARD_LIMIT = 1500;

function splitLongMessage(text) {
    if (text.length <= SLIDE_TEXT_SOFT_LIMIT) return [text];

    const sentences = [];
    const re = /[^.!?\n]+[.!?]+(?=\s|$)|[^.!?\n]+$/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        sentences.push(m[0].trim());
    }
    if (sentences.length <= 1) return [text];

    const chunks = [];
    let buf = '';
    for (const s of sentences) {
        if (buf && (buf.length + s.length + 1) > SLIDE_TEXT_SOFT_LIMIT) {
            chunks.push(buf);
            buf = s;
        } else {
            buf = buf ? (buf + ' ' + s) : s;
        }
    }
    if (buf) chunks.push(buf);

    return chunks.map(c => c.length > SLIDE_TEXT_HARD_LIMIT ? c : c);
}

function generateConversationSlides(source, progress) {
    const participants = source.participants.filter(Boolean);
    const pA = participants[0] || null;
    const pB = participants[1] || null;

    function roleFor(speaker) {
        if (!speaker) return { role: 'participantA', label: pA || 'Speaker A' };
        const s = String(speaker).trim();
        if (pA && s === pA) return { role: 'participantA', label: pA };
        if (pB && s === pB) return { role: 'participantB', label: pB };
        return { role: 'participantA', label: s };
    }

    progress('llm', `Converting ${source.messages.length} messages to slides…`, 30);

    const slides = [];
    source.messages.forEach((m, idx) => {
        const text = m.content || '';
        const chunks = splitLongMessage(text);
        const { role, label } = roleFor(m.speaker);
        chunks.forEach((chunk, ci) => {
            slides.push({
                type: 'conversation',
                speaker: role,
                label: label,
                text: chunk,
                originalIdx: idx,
                splitIdx: ci,
                tts: null
            });
        });
    });

    // Backfill splitCount.
    const splitCounts = new Map();
    for (const s of slides) {
        if (s.type !== 'conversation') continue;
        splitCounts.set(s.originalIdx, (splitCounts.get(s.originalIdx) || 0) + 1);
    }
    for (const s of slides) {
        if (s.type !== 'conversation') continue;
        s.splitCount = splitCounts.get(s.originalIdx);
    }

    progress('llm', `Built ${slides.length} conversation slides (${source.messages.length} messages, deterministic)`, 70);
    return slides;
}

// ─── Main ─────────────────────────────────────────────────────

/**
 * Build a complete slide deck from a parsed Arena source.
 *
 * @param {Object} sourceData — parsed Arena export (or pre-parsed source).
 * @param {string|null} outputDir — where to write the deck JSON. null = skip.
 * @param {Function} [progress] — (stage, message, pct) => void
 * @param {Object} [options]
 * @param {boolean} [options.skipClean] — skip LLM text cleaning (default false)
 */
async function cleanWithLLM(sourceData, outputDir = null, progress = () => {}, options = {}) {
    progress('import', `Loaded ${sourceData.messages?.length || 0} messages`, 10);

    // Normalize: accept both raw Arena JSON and pre-parsed source objects.
    const source = {
        id: sourceData.id || sourceData.source?.id || sourceData.source?.arenaExportId || 'unknown',
        topic: sourceData.topic || sourceData.source?.topic || 'Untitled',
        participants: sourceData.participants || sourceData.source?.participants || [],
        messages: sourceData.messages || sourceData.source?.messages || [],
        exportedAt: sourceData.exportedAt || sourceData.source?.exportedAt || new Date().toISOString(),
        seedPrompt: sourceData.seedPrompt || sourceData.source?.seedPrompt || null,
        seedPromptRaw: sourceData.seedPromptRaw || sourceData.source?.seedPromptRaw || null,
        renderedAt: sourceData.renderedAt || sourceData.source?.renderedAt || null
    };

    if (source.messages.length === 0) {
        throw new Error('No messages found in source data');
    }
    if (!source.seedPrompt) {
        console.warn('[Build Deck] WARNING: source.seedPrompt is empty — topic slide will fall back to topic summary.');
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

    // ── Step 2: Build conversation slides ─────────────────────
    progress('llm', `Generating conversation slides…`, 25);
    const conversationSlides = generateConversationSlides(source, progress);

    // ── Step 3: Inject opening + closing ──────────────────────
    progress('inject', `Injecting opening + closing slides`, 85);
    const opening = buildOpeningSlides(source);
    const ending = buildEndSlide();

    const slides = [...opening, ...conversationSlides, ending];
    for (let i = slides.length - 1; i > 0; i--) {
        if (slides[i].text === slides[i - 1].text && slides[i].speaker === slides[i - 1].speaker) {
            slides.splice(i, 1);
        }
    }

    const participants = source.participants.filter(Boolean);
    const deck = {
        version: 2,
        source: {
            arenaExportId: source.id,
            exportedAt: source.exportedAt,
            topic: source.topic,
            seedPrompt: source.seedPrompt,
            seedPromptRaw: source.seedPromptRaw,
            participants: participants,
            messages: source.messages,
            renderedAt: source.renderedAt || source.exportedAt
        },
        voiceMapping: {
            narrator:     { voice: VOICES.narrator.voice,     speed: VOICES.narrator.speed },
            participantA: { voice: VOICES.participantA.voice, speed: VOICES.participantA.speed, label: participants[0] || '' },
            participantB: { voice: VOICES.participantB.voice, speed: VOICES.participantB.speed, label: participants[1] || '' }
        },
        slides: slides,
        createdAt: Date.now(),
        renderedAt: source.renderedAt || source.exportedAt
    };

    progress('write', `Deck: ${slides.length} slides`, 95);

    if (outputDir) {
        fs.mkdirSync(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, 'slide_deck_llm.json');
        fs.writeFileSync(outputPath, JSON.stringify(deck, null, 2), 'utf-8');
        console.log(`[Build Deck] Output: ${outputPath}`);
    }

    console.log(`\n[Build Deck] Slide overview (${deck.slides.length} slides):`);
    for (let i = 0; i < deck.slides.length; i++) {
        const s = deck.slides[i];
        const preview = (s.text || '').substring(0, 80).replace(/\n/g, ' ');
        console.log(`  ${i}. [${s.type}] ${s.label}: "${preview}${preview.length >= 80 ? '...' : ''}"`);
    }

    progress('done', `Done — ${deck.slides.length} slides`, 100);
    return deck;
}

// ─── CLI ──────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.error('Usage: node pipeline/build-deck.js <arena-export.json> [output-dir] [--skip-clean]');
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
    await cleanWithLLM(raw, outputDir, undefined, { skipClean });
}

if (require.main === module) {
    main().catch(err => {
        console.error('\n[Build Deck] FATAL:', err.message);
        process.exit(1);
    });
}

module.exports = { cleanWithLLM, buildOpeningSlides, buildEndSlide, generateConversationSlides };
