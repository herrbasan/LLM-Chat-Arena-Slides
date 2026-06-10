// server/retrofit-setup-slide.js
//
// One-off script. Splices the Setup slide (locked in pipeline/llm-clean.js
// buildOpeningSlides) at position 0 of the House vs Grooves deck, which
// was generated before commit 1c5e808 added the deterministic opener.
//
// The Setup narration is reproduced here verbatim from
// pipeline/llm-clean.js — do not edit; if the contract changes, bump
// ALIGNMENT_VERSION and re-run the renderer.

const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'slideshow_w8hveoIVFd6e1B8y';
const JSONL_PATH = path.join(__dirname, 'data', 'slideshows.jsonl');
const CACHE_DIR = path.join(__dirname, 'data', 'render_cache', PROJECT_ID);

const SETUP_SLIDE = {
    type: 'setup',
    speaker: 'narrator',
    label: 'Narrator',
    text: 'Setup',
    narration: "You're about to hear a conversation between two language models. They were given a single prompt \u2014 a topic \u2014 and then left to respond to each other directly, with no further human involvement. What follows is unedited and unsteered. The models chose every word themselves.",
    tts: null
};

// 1. Read JSONL, find last write for the project.
const lines = fs.readFileSync(JSONL_PATH, 'utf-8').split('\n').filter(Boolean);
let lastIdx = -1;
for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(`"${PROJECT_ID}"`)) { lastIdx = i; break; }
}
if (lastIdx === -1) throw new Error(`Project ${PROJECT_ID} not found in JSONL`);

const project = JSON.parse(lines[lastIdx]);
const before = project.slides.length;
if (project.slides[0] && project.slides[0].type === 'setup') {
    throw new Error(`Deck already has a Setup slide at position 0 (slides=${before}). Nothing to do.`);
}

// 2. Splice Setup at position 0; wipe tts on the existing slides because
//    their cache references are positional and will be wrong after the
//    index shift. Re-render rebuilds everything cleanly.
project.slides = [SETUP_SLIDE, ...project.slides.map(s => {
    if (s.tts) {
        const { tts, ...rest } = s;
        return rest;
    }
    return s;
})];
project.updatedAt = Date.now();

// 3. Append the new line. No leading newline — the file already ends
//    with \n from the previous append.
fs.appendFileSync(JSONL_PATH, JSON.stringify(project) + '\n');

// 4. Trash the render cache for this project. Re-render rebuilds it.
if (fs.existsSync(CACHE_DIR)) {
    const files = fs.readdirSync(CACHE_DIR);
    for (const f of files) fs.unlinkSync(path.join(CACHE_DIR, f));
    fs.rmdirSync(CACHE_DIR);
}

console.log(`OK: spliced Setup at position 0. slides ${before} -> ${project.slides.length}. Cache cleared.`);
console.log(`Slide 0: type=${project.slides[0].type} text="${project.slides[0].text}"`);
console.log(`Slide 1: type=${project.slides[1].type} text="${project.slides[1].text.substring(0, 80)}..."`);
console.log(`Last slide: type=${project.slides[project.slides.length - 1].type}`);
