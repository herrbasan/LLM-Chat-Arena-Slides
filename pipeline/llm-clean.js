// pipeline/llm-clean.js
// LLM Gateway → Conversation-Slide Generation
// Uses badkid-llama-chat (local, 128K context)
//
// Architecture: SINGLE BATCH CALL.
// The whole conversation fits in 128K, so we send it all at once and ask
// the LLM to respond with a JSON array of conversation slides. No tool
// loop, no re-encoding of growing context per turn.
//
// The opening (setup + details + title) and the closing (end) are
// INJECTED DETERMINISTICALLY from source.seedPrompt / source.seedPromptRaw.
// The LLM has no say in the opener — only the conversation slides.
//
// The seed prompt is messages[0].content (the moderator's first message)
// MINUS the "Topic:" prefix. It is what the first model actually
// responded to. The AI-generated `source.topic` (summary.title) is NOT
// used for the title slide.

const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────

const GATEWAY_URL = process.env.LLM_GATEWAY_URL || 'http://192.168.0.100:3400';
const MODEL = 'badkid-llama-chat';

// Voice config — override in .env
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

// ─── Date helper ──────────────────────────────────────────────

const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

const NUMBER_WORDS_0_19 = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'
];
// Spelling variants needed when the number is followed by a word starting
// with a vowel (e.g. "eighth" not "eightth", "fifth" not "fiveth").
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
        // Years like 2026: "twenty twenty-six"
        const th = Math.floor(n / 1000);
        const rest = n % 1000;
        const head = th < 20 ? NUMBER_WORDS_0_19[th] + ' thousand' : `${spell(th)} thousand`;
        return rest ? `${head} ${spell(rest)}` : head;
    }
    return String(n); // Fallback for very large numbers
}

function formatHumanDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const day = d.getUTCDate();
    const month = MONTHS[d.getUTCMonth()];
    const year = d.getUTCFullYear();
    // Build the day word. Numbers 1-19 spell cleanly; for teens + 11/12/13
    // the suffix is always "th" but a few numbers (8, 9, 12) need a vowel
    // variant to flow naturally into "th".
    const dayWord = day < 20 && NUMBER_WORDS_VOWEL_NEXT[day]
        ? NUMBER_WORDS_VOWEL_NEXT[day]
        : `${spell(day)}th`;
    return `${month} ${dayWord}, ${spell(year)}`;
}

// ─── Gateway call (single shot) ───────────────────────────────
//
// We used to call the LLM to convert raw messages → slides. Empirically
// the model was unreliable: 8 slides on one run, 17 on another, 22 on a
// third. The LLM also produced text that violated the verbatim-fidelity
// rule (it summarized, it cleaned, it reworded) and on long conversations
// it hit the gateway's max_tokens ceiling and produced truncated JSON.
//
// The LLM's only legitimate job here was: pass text through verbatim,
// map speaker names, and split very long messages at boundaries. All
// three are deterministic operations that don't need an LLM.
//
// We still import the gateway config so the CLI / API layer can verify
// reachability, but generation is local and pure.

async function gatewayChat(messages) {
    const noThinking = { enable_thinking: false };
    const body = {
        model: MODEL,
        messages: messages,
        temperature: 0.3,
        chat_template_kwargs: noThinking,
        extraBody: { chat_template_kwargs: noThinking }
    };
    const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => 'unknown');
        throw new Error(`Gateway HTTP ${res.status}: ${errText.substring(0, 500)}`);
    }
    return res.json();
}

// ─── Deterministic opening / closing slides ────────────────────

function buildOpeningSlides(source) {
    const participants = source.participants.filter(Boolean);
    const dateText = formatHumanDate(source.exportedAt) || 'an unknown date';
    const participantLine = participants.length >= 2
        ? `${participants[0]} and ${participants[1]}`
        : (participants[0] || 'two language models');

    return [
        {
            type: 'setup',
            speaker: 'narrator',
            label: 'Narrator',
            text: 'Setup',
            narration: 'Setup. This presentation serves as evidence of an autonomously generated conversation between two large language models responding to each other directly, with no human intervention. The tone is factual and transparent.',
            tts: null
        },
        {
            type: 'details',
            speaker: 'narrator',
            label: 'Narrator',
            text: `Recorded on ${dateText}`,
            narration: `This recording was generated on ${dateText}, featuring the models ${participantLine}.`,
            tts: null
        },
        {
            type: 'title',
            speaker: 'narrator',
            label: 'Narrator',
            // The visible text on screen is the literal moderator message,
            // including the "Topic:" prefix, so the viewer sees exactly
            // what the human wrote.
            text: source.seedPromptRaw || source.seedPrompt || source.topic,
            // The narrator reads the seed prompt verbatim, framed by a brief
            // intro beat. Prefix is kept on purpose — see Agents.md.
            narration: source.seedPromptRaw
                ? `The conversation began with this prompt. ${source.seedPromptRaw}`
                : `The conversation began with this prompt. ${source.seedPrompt || source.topic}`,
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
//
// We no longer call the LLM to convert messages → slides. The LLM was
// unreliable: it summarized, it cleaned, it produced different slide
// counts across runs, and it hit the gateway's max_tokens ceiling on
// long conversations.
//
// The deterministic pipeline:
//   1. Map every source message to a (participantA | participantB) slide.
//   2. Map the message's speaker name to the original display label.
//   3. Pass text through verbatim — no cleaning, no summarization.
//   4. Optionally split very long messages at sentence boundaries so a
//      single slide isn't unreadably long.

const SLIDE_TEXT_SOFT_LIMIT = 600;   // chars — if a message is longer, try to split
const SLIDE_TEXT_HARD_LIMIT = 1500;  // chars — give up on splitting, keep whole

function splitLongMessage(text) {
    // Returns 1+ chunks. Each chunk is verbatim from `text`. Splits at
    // sentence boundaries when over the soft limit.
    if (text.length <= SLIDE_TEXT_SOFT_LIMIT) return [text];

    const sentences = [];
    // Naive sentence boundary: ". " or ".\n" or "? " or "! " followed by
    // a capital letter or quote. Preserves the trailing punctuation.
    const re = /[^.!?\n]+[.!?]+(?=\s|$)|[^.!?\n]+$/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        sentences.push(m[0].trim());
    }
    if (sentences.length <= 1) return [text]; // No good split point; keep whole.

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

    // If a chunk is still over the hard limit, don't try to split further;
    // accept a long slide.
    return chunks.map(c => c.length > SLIDE_TEXT_HARD_LIMIT ? c : c);
}

function generateConversationSlides(source, progress) {
    const participants = source.participants.filter(Boolean);
    const pA = participants[0] || null;
    const pB = participants[1] || null;

    // Speaker-name → (role, displayLabel) map. Use the first message's
    // speaker text as the display label, but accept either the literal
    // name or a slugified variant.
    function roleFor(speaker) {
        if (!speaker) return { role: 'participantA', label: pA || 'Speaker A' };
        const s = String(speaker).trim();
        if (pA && s === pA) return { role: 'participantA', label: pA };
        if (pB && s === pB) return { role: 'participantB', label: pB };
        // Fall back to participantA for unknown speakers (shouldn't happen
        // because the moderator has already been stripped upstream).
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
                tts: null,
                _splitIdx: ci
            });
        });
    });

    progress('llm', `Built ${slides.length} conversation slides (${source.messages.length} messages, deterministic)`, 70);
    return slides;
}

// ─── Main ─────────────────────────────────────────────────────

/**
 * Build a complete slide deck from a parsed Arena source.
 *
 * @param {Object} sourceData — parsed Arena export (or pre-parsed source).
 *   Must include: topic, participants, messages (already without the moderator),
 *   seedPrompt, seedPromptRaw, exportedAt.
 * @param {string|null} outputDir — where to write the deck JSON. null = skip.
 * @param {Function} [progress] — (stage, message, pct) => void for progress
 *   reporting. stage is one of "import"|"llm"|"inject"|"write".
 */
async function cleanWithLLM(sourceData, outputDir = null, progress = () => {}) {
    progress('import', `Loaded ${sourceData.messages?.length || 0} messages`, 10);

    // Normalize: accept both raw Arena JSON and pre-parsed source objects.
    const source = {
        id: sourceData.id || sourceData.source?.id || sourceData.source?.arenaExportId || 'unknown',
        topic: sourceData.topic || sourceData.source?.topic || 'Untitled',
        participants: sourceData.participants || sourceData.source?.participants || [],
        messages: sourceData.messages || sourceData.source?.messages || [],
        exportedAt: sourceData.exportedAt || sourceData.source?.exportedAt || new Date().toISOString(),
        seedPrompt: sourceData.seedPrompt || sourceData.source?.seedPrompt || null,
        seedPromptRaw: sourceData.seedPromptRaw || sourceData.source?.seedPromptRaw || null
    };

    if (source.messages.length === 0) {
        throw new Error('No messages found in source data');
    }
    if (!source.seedPrompt) {
        console.warn('[LLM Clean] WARNING: source.seedPrompt is empty — title slide will fall back to topic summary.');
    }

    const participants = source.participants.filter(Boolean);
    progress('llm', `Generating conversation slides…`, 20);

    // Step 1: Generate conversation slides deterministically from the
    // source messages. The LLM is no longer in the loop for this step.
    const conversationSlides = generateConversationSlides(source, progress);

    progress('inject', `Injecting opening + closing slides`, 80);

    // Step 2: Deterministic opener + closer.
    const opening = buildOpeningSlides(source);
    const ending = buildEndSlide();

    // Step 3: Concatenate, dedupe adjacent identical slides, sanity-check.
    const slides = [...opening, ...conversationSlides, ending];

    // Dedupe adjacent identical-text+speaker slides (LLM occasionally emits a duplicate).
    for (let i = slides.length - 1; i > 0; i--) {
        if (slides[i].text === slides[i - 1].text && slides[i].speaker === slides[i - 1].speaker) {
            slides.splice(i, 1);
        }
    }

    // Build the deck structure.
    const deck = {
        version: 1,
        source: {
            arenaExportId: source.id,
            exportedAt: source.exportedAt,
            topic: source.topic,
            seedPrompt: source.seedPrompt,
            seedPromptRaw: source.seedPromptRaw,
            participants: participants,
            messages: source.messages
        },
        voiceMapping: {
            narrator:     { voice: VOICES.narrator.voice,     speed: VOICES.narrator.speed },
            participantA: { voice: VOICES.participantA.voice, speed: VOICES.participantA.speed, label: participants[0] || '' },
            participantB: { voice: VOICES.participantB.voice, speed: VOICES.participantB.speed, label: participants[1] || '' }
        },
        slides: slides,
        createdAt: Date.now()
    };

    progress('write', `Deck: ${slides.length} slides`, 90);

    // Write output (skip if outputDir is null — API mode).
    if (outputDir) {
        fs.mkdirSync(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, 'slide_deck_llm.json');
        fs.writeFileSync(outputPath, JSON.stringify(deck, null, 2), 'utf-8');
        console.log(`[LLM Clean] Output: ${outputPath}`);
    }

    // Slide overview log.
    console.log(`\n[LLM Clean] Slide overview (${deck.slides.length} slides):`);
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
        console.error('Usage: node pipeline/llm-clean.js <arena-export.json> [output-dir]');
        process.exit(1);
    }

    const inputPath = path.resolve(args[0]);
    const outputDir = path.resolve(args[1] || 'pipeline/output');

    if (!fs.existsSync(inputPath)) {
        console.error(`Input file not found: ${inputPath}`);
        process.exit(1);
    }

    const raw = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
    await cleanWithLLM(raw, outputDir);
}

if (require.main === module) {
    main().catch(err => {
        console.error('\n[LLM Clean] FATAL:', err.message);
        process.exit(1);
    });
}

module.exports = { cleanWithLLM };
