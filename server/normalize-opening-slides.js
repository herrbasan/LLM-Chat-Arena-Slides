// server/normalize-opening-slides.js
//
// One-off script. Forces the first three slides of a project to match
// the locked opening contract:
//   0. setup    — narrator frames the experiment
//   1. details  — provenance block: recorded date, rendered date,
//                 model chips, turn count
//   2. topic    — the seed prompt verbatim, with the "Topic:" prefix preserved
//
// Idempotent: re-running produces the same result. Throws only if the
// data is missing.

const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'slideshow_w8hveoIVFd6e1B8y';
const JSONL_PATH = path.join(__dirname, 'data', 'slideshows.jsonl');

const SETUP_NARRATION =
    "You're about to hear a conversation between two language models. " +
    "They were given a single prompt \u2014 a topic \u2014 and then left to " +
    "respond to each other directly, with no further human involvement. " +
    "What follows is unedited and unsteered. The models chose every word themselves.";

// Number-word spell for "twenty" — simple inline copy of what llm-clean.js does.
// Kept here so this script doesn't have to import the LLM-clean module (which
// pulls in the gateway URL, even if we don't use it).
function spell(n) {
    const ones = ['zero','one','two','three','four','five','six','seven','eight','nine','ten',
                  'eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
    if (n < 20) return ones[n];
    const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
    const t = Math.floor(n / 10);
    const r = n % 10;
    return r ? `${tens[t]}-${ones[r]}` : tens[t];
}

// 1. Read JSONL, find last write for the project.
const lines = fs.readFileSync(JSONL_PATH, 'utf-8').split('\n').filter(Boolean);
let lastIdx = -1;
for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(`"${PROJECT_ID}"`)) { lastIdx = i; break; }
}
if (lastIdx === -1) throw new Error(`Project ${PROJECT_ID} not found in JSONL`);

const project = JSON.parse(lines[lastIdx]);
const src = project.source;
if (!src) throw new Error('Project is missing source');
if (!src.seedPromptRaw) throw new Error('Project source is missing seedPromptRaw');
if (!src.exportedAt) throw new Error('Project source is missing exportedAt');
if (!Array.isArray(src.participants) || src.participants.length < 2) {
    throw new Error('Project source is missing participants');
}

// 2. Build the three slides.
const date = new Date(src.exportedAt);
const dateText = date.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
});

const turnCount = (project.slides || []).filter(s => s.type === 'conversation').reduce((max, s) => {
    return s.originalIdx != null ? Math.max(max, s.originalIdx) : max;
}, -1) + 1;
// Above gives us the count of distinct originalIdx values — i.e. message count.
// If the deck has no conversation slides, fall back to 0.

const modelChips = src.participants.slice(0, 2).map((name, i) => ({
    name,
    role: i === 0 ? 'participantA' : 'participantB'
}));

const renderedAt = src.renderedAt || src.exportedAt;
const participantLine = `${src.participants[0]} and ${src.participants[1]}`;
const turnCountText = turnCount === 1 ? 'One turn.' : `${spell(turnCount)} turns.`;

const slides = [
    {
        type: 'setup',
        speaker: 'narrator',
        label: 'Narrator',
        text: 'Setup',
        narration: SETUP_NARRATION,
        tts: null
    },
    {
        type: 'details',
        speaker: 'narrator',
        label: 'Narrator',
        text: 'Details',
        narration: `This recording was generated on ${dateText}, featuring the models ${participantLine}. ${turnCountText}`,
        tts: null,
        meta: {
            recordedAt: src.exportedAt,
            renderedAt: renderedAt,
            models: modelChips,
            turnCount: turnCount
        }
    },
    {
        type: 'topic',
        speaker: 'narrator',
        label: 'Narrator',
        text: src.seedPromptRaw,
        narration: src.seedPromptRaw,
        tts: null
    }
];

// 3. Replace positions 0..2. Preserve the rest of the deck as-is.
project.slides = [...slides, ...project.slides.slice(3)];
project.updatedAt = Date.now();
// Also bump the deck version to 2 — old format decks are v1.
if (project.version === 1) project.version = 2;

// 4. Append the new line. No leading newline — the file already ends
//    with \n from the previous append. (We do NOT touch the render cache;
//    if any of slides 0..2 had stale tts, a prior run already wiped it.)
fs.appendFileSync(JSONL_PATH, JSON.stringify(project) + '\n');

console.log(`OK: opening slides normalized. Total slides: ${project.slides.length}`);
console.log(`  0. [${project.slides[0].type}] "${project.slides[0].text}"`);
console.log(`  1. [${project.slides[1].type}] (meta block: ${turnCount} turns, ${modelChips.length} models)`);
console.log(`  2. [${project.slides[2].type}] "${project.slides[2].text.substring(0, 100)}..."`);
