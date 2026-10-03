// server/repair-untitled-deck.js
//
// One-off (2026-10-03). Repairs slideshow_XOAjsiXuLwjEJgUU — a gateway-chat
// dump imported through the (since fixed) buildProject gate that skipped the
// importer for moderator-less raw exports. Damage: participants [], every
// turn collapsed onto participantA, details slide reading "featuring the
// models two language models", topic slide speaking "Untitled".
//
// Repair (mechanical, no semantic choices):
//   source.participants  <- first-appearance order of originalSpeaker
//   conversation msgs    <- speaker remapped participantA/B, label = raw name
//   setup + details msgs <- rebuilt from buildOpeningSlides (canonical)
//
// The topic slide is deliberately LEFT AS-IS — its handling is coupled to the
// deck title, which is a human decision. Nothing in this deck was ever
// rendered (0 audio refs), so remapping voices invalidates no audio.
//
//   node server/repair-untitled-deck.js [--dry-run]

const nDB = require('./ndb.js');
const { buildOpeningSlides } = require('../pipeline/build-deck.js');

const DRY_RUN = process.argv.includes('--dry-run');
const PROJECT_ID = 'slideshow_XOAjsiXuLwjEJgUU';
const DATA = process.env.NDB_DATA_PATH || './data';
const path = require('path');
const JSONL_PATH = path.join(__dirname, DATA, 'slideshows.jsonl');

const fs = require('fs');
if (!fs.existsSync(JSONL_PATH)) {
    throw new Error(`Store not found: ${JSONL_PATH}`);
}

const db = nDB.Database.open(JSONL_PATH, { persistence: 'immediate' });

(async () => {
    if (!db.contains(PROJECT_ID)) throw new Error(`No project ${PROJECT_ID}`);
    const doc = await db.get(PROJECT_ID);

    const conv = (doc.messages || []).filter(m => m.type === 'conversation');

    // Participants in first-appearance order of the RAW speaker names.
    const order = [];
    for (const m of conv) {
        const s = m.originalSpeaker;
        if (s && !order.includes(s)) order.push(s);
    }
    if (order.length < 2) {
        throw new Error(`Expected 2 distinct originalSpeakers, found ${order.length}: [${order.join(', ')}]`);
    }
    const participants = order.slice(0, 2);
    const unexpected = conv.filter(m => m.originalSpeaker && !participants.includes(m.originalSpeaker));
    if (unexpected.length > 0) {
        throw new Error(`More than 2 distinct speakers: found ${[...new Set(conv.map(m => m.originalSpeaker))].join(', ')}`);
    }

    // Remap roles + labels.
    let remapped = 0;
    for (const m of conv) {
        const role = m.originalSpeaker === participants[0] ? 'participantA' : 'participantB';
        if (m.speaker !== role || m.label !== m.originalSpeaker) remapped++;
        m.speaker = role;
        m.label = m.originalSpeaker;
    }

    // Rebuild setup + details from the canonical builder (with participants
    // now set). Splice positions 0/1; keep topic + everything else.
    doc.source.participants = participants;
    const built = buildOpeningSlides(doc.source);
    const idxSetup = doc.messages.findIndex(m => m.type === 'setup');
    const idxDetails = doc.messages.findIndex(m => m.type === 'details');
    if (idxSetup === -1 || idxDetails === -1) throw new Error('Missing setup/details message');

    const aSeq = conv.map(m => m.speaker === 'participantA' ? 'A' : 'B').join('');
    console.log(`participants: ${participants.join(' vs ')}`);
    console.log(`remapped messages: ${remapped} of ${conv.length}`);
    console.log(`role sequence: ${aSeq}`);
    console.log(`details narration: ${built[1].narration}`);

    if (DRY_RUN) { console.log('\nDRY RUN — nothing written.'); db.close(); return; }

    doc.messages[idxSetup] = { ...doc.messages[idxSetup], ...built[0] };
    doc.messages[idxDetails] = { ...doc.messages[idxDetails], ...built[1] };
    doc.updatedAt = Date.now();
    db.update(doc._id, doc);
    console.log('\nWritten.');
    db.close();
})();
