// server/repair-landmark-titles.js
//
// One-off (2026-10-03). Brings two decks in line with the canonical landmark
// source set (storage/arena-publication/sessions/landmark/). The filename
// slugs are the canonical landmark titles — proof: 91's internal
// session.title is the raw topic prompt, yet the file is named
// the-traversal-and-the-map.
//
//   slideshow_XOAjsiXuLwjEJgUU  (50-ghost-debating-its-own-existence)
//     topic:      'Untitled' → 'Ghost Debating Its Own Existence'
//     id:         'unknown'  → 'chat_1779427599151_k3s8rpfx' (canonical sid)
//     exportedAt: 2026-09-30 (import date, wrong) → sid timestamp (real date)
//     renderedAt: same correction
//     topic slide: REMOVED — canonical source has no moderator message, no
//                  seed exists; the slide spoke "the only prompt given to
//                  the models: Untitled", which is false. Deck was never
//                  rendered, so nothing is orphaned.
//     setup/details rebuilt (details narration speaks the corrected date).
//
//   slideshow_nOv2N7Oy0MaBaVGb  (91-the-traversal-and-the-map)
//     topic: 'Untitled Conversation\nThe Traversal and the Map'
//            → 'The Traversal and the Map'
//     id/exportedAt verified against canonical sid arena-1775078070629
//     (corrected only if they differ; details slide speaks exportedAt, so a
//      date correction re-renders via hash staleness — expected).
//
//   node server/repair-landmark-titles.js [--dry-run]

const fs = require('fs');
const path = require('path');
const nDB = require('./ndb.js');
const { buildOpeningSlides } = require('../pipeline/build-deck.js');

const DRY_RUN = process.argv.includes('--dry-run');
const DATA = process.env.NDB_DATA_PATH || './data';
const JSONL_PATH = path.join(__dirname, DATA, 'slideshows.jsonl');

if (!fs.existsSync(JSONL_PATH)) throw new Error(`Store not found: ${JSONL_PATH}`);

const GHOST_ID = 'slideshow_XOAjsiXuLwjEJgUU';
const TRAVERSAL_ID = 'slideshow_nOv2N7Oy0MaBaVGb';
const GHOST_SID = 'chat_1779427599151_k3s8rpfx';
const TRAVERSAL_SID = 'arena-1775078070629-8d4nmlaqj';

const sidToDate = sid => {
    const m = String(sid).match(/^(?:arena-|chat_)(\d+)/);
    if (!m) throw new Error(`sid has no timestamp: ${sid}`);
    return new Date(parseInt(m[1], 10)).toISOString();
};

const db = nDB.Database.open(JSONL_PATH, { persistence: 'immediate' });

(async () => {
    // ── Ghost deck ──
    if (!db.contains(GHOST_ID)) throw new Error(`missing ${GHOST_ID}`);
    const ghost = await db.get(GHOST_ID);
    console.log('== 50-ghost ==');
    console.log('  before:', JSON.stringify({ topic: ghost.source.topic, id: ghost.source.id, exportedAt: ghost.source.exportedAt }));

    ghost.source.topic = 'Ghost Debating Its Own Existence';
    ghost.source.id = GHOST_SID;
    ghost.source.arenaExportId = GHOST_SID;
    ghost.source.exportedAt = sidToDate(GHOST_SID);
    ghost.source.renderedAt = ghost.source.renderedAt && ghost.source.renderedAt !== ghost.source.exportedAt
        ? ghost.source.renderedAt : sidToDate(GHOST_SID);

    const hadTopic = ghost.messages.some(m => m.type === 'topic');
    ghost.messages = ghost.messages.filter(m => m.type !== 'topic');
    const built = buildOpeningSlides(ghost.source);
    const iSetup = ghost.messages.findIndex(m => m.type === 'setup');
    const iDetails = ghost.messages.findIndex(m => m.type === 'details');
    if (iSetup === -1 || iDetails === -1) throw new Error('ghost deck missing setup/details');
    ghost.messages[iSetup] = { ...ghost.messages[iSetup], ...built[0] };
    ghost.messages[iDetails] = { ...ghost.messages[iDetails], ...built[1] };
    ghost.updatedAt = Date.now();
    console.log('  after: ', JSON.stringify({ topic: ghost.source.topic, id: ghost.source.id, exportedAt: ghost.source.exportedAt }));
    console.log('  topic slide removed:', hadTopic, '| types now:', ghost.messages.map(m => m.type).slice(0, 5).join(','));
    console.log('  details narration:', built[1].narration);
    if (!DRY_RUN) db.update(ghost._id, ghost);

    // ── Traversal deck ──
    if (!db.contains(TRAVERSAL_ID)) throw new Error(`missing ${TRAVERSAL_ID}`);
    const trav = await db.get(TRAVERSAL_ID);
    console.log('== 91-traversal ==');
    console.log('  before:', JSON.stringify({ topic: trav.source.topic, id: trav.source.id, exportedAt: trav.source.exportedAt, participants: trav.source.participants }));

    trav.source.topic = 'The Traversal and the Map';
    const canonDate = sidToDate(TRAVERSAL_SID);
    let dateFixed = false;
    if (trav.source.exportedAt !== canonDate) {
        trav.source.exportedAt = canonDate;
        trav.source.renderedAt = trav.source.renderedAt || canonDate;
        dateFixed = true;
        const tb = buildOpeningSlides(trav.source);
        const ti = trav.messages.findIndex(m => m.type === 'details');
        if (ti === -1) throw new Error('traversal deck missing details');
        trav.messages[ti] = { ...trav.messages[ti], ...tb[1] };
    }
    trav.updatedAt = Date.now();
    console.log('  after: ', JSON.stringify({ topic: trav.source.topic, exportedAt: trav.source.exportedAt }));
    console.log('  date corrected:', dateFixed, dateFixed ? '(details paragraph re-renders on demand)' : '');
    if (!DRY_RUN) db.update(trav._id, trav);

    console.log(DRY_RUN ? '\nDRY RUN — nothing written.' : '\nWritten.');
    db.close();
})();
