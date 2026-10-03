// server/repair-ghost-topic-slide.js
//
// One-off (2026-10-03, follow-up to repair-landmark-titles). Restores the
// topic slide on the Ghost deck (slideshow_XOAjsiXuLwjEJgUU) — the previous
// repair removed it because the canonical source (50-ghost-debating-its-
// own-existence.json) has no moderator message, so the slide's "the only
// prompt given to the models" claim was false. But the export's
// session.title ("AI Consciousness: Simulation vs. Suffering") IS the
// human's topic — the same field carries the seed on seeded exports of
// that era. So: topic slide returns, built by buildOpeningSlides from
// source.sessionTitle, with narration that claims only what is true
// ("The models were given the topic: …").
//
// Zero audio on this deck (verified 2026-10-03) — nothing to invalidate.
//
//   node server/repair-ghost-topic-slide.js [--dry-run]

const fs = require('fs');
const path = require('path');
const nDB = require('./ndb.js');
const { buildOpeningSlides } = require('../pipeline/build-deck.js');

const DRY_RUN = process.argv.includes('--dry-run');
const PROJECT_ID = 'slideshow_XOAjsiXuLwjEJgUU';
const SESSION_TITLE = 'AI Consciousness: Simulation vs. Suffering';
const DATA = process.env.NDB_DATA_PATH || './data';
const JSONL_PATH = path.join(__dirname, DATA, 'slideshows.jsonl');

if (!fs.existsSync(JSONL_PATH)) throw new Error(`Store not found: ${JSONL_PATH}`);

// Mirrors slideToMessage in pipeline/build-messages.js.
const slideToMessage = slide => ({
    speaker: slide.speaker || 'narrator',
    label: slide.label || 'Narrator',
    role: 'narrator',
    type: slide.type,
    text: slide.text || '',
    narration: slide.narration || slide.text || '',
    createdAt: null,
    originalSpeaker: 'narrator',
    meta: slide.meta || null,
    paragraphs: String(slide.narration || slide.text || '')
        .split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0)
        .map(p => ({ text: p }))
});

const db = nDB.Database.open(JSONL_PATH, { persistence: 'immediate' });

(async () => {
    if (!db.contains(PROJECT_ID)) throw new Error(`missing ${PROJECT_ID}`);
    const doc = await db.get(PROJECT_ID);

    if (doc.messages.some(m => m.type === 'topic')) {
        console.log('topic slide already present — nothing to do.');
        db.close();
        return;
    }

    doc.source.sessionTitle = SESSION_TITLE;
    const built = buildOpeningSlides(doc.source);
    const topicSlide = built.find(s => s.type === 'topic');
    if (!topicSlide) throw new Error('buildOpeningSlides produced no topic slide — template edit missing?');

    const iDetails = doc.messages.findIndex(m => m.type === 'details');
    if (iDetails === -1) throw new Error('no details message — insert position unknown');

    const msg = slideToMessage(topicSlide);
    doc.messages.splice(iDetails + 1, 0, msg);
    doc.updatedAt = Date.now();

    console.log(`inserted topic slide after details (index ${iDetails + 1})`);
    console.log(`  text:      ${JSON.stringify(msg.text)}`);
    console.log(`  narration: ${JSON.stringify(msg.narration)}`);
    console.log(`  message types now: ${doc.messages.map(m => m.type).slice(0, 5).join(',')} …`);

    if (DRY_RUN) { console.log('\nDRY RUN — nothing written.'); db.close(); return; }
    db.update(doc._id, doc);
    console.log('\nWritten.');
    db.close();
})();
