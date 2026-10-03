// server/migrate-setup-narration.js
//
// One-off (2026-10-01, final pass). Sets the Setup opening to the minimal
// original: one sentence, nothing else. The Claude-identity and
// name-mismatch explanations were cut — explaining the non-interference
// contract at length reads as defensive; the sentence carries it.
//
// The opening exists in THREE places per project, and all three must move
// together or the deck breaks in a confusing way:
//
//   msg.text                the slide's text
//   msg.narration           the line build-deck.js generates
//   msg.paragraphs[0].text  THE SPOKEN TEXT — what TTS renders and what the
//                            freshness hash is computed from
//
// Rewriting narration alone is the trap: paragraph text is what gets spoken
// and hashed, so the old audio would keep playing and the deck would still
// read as fresh. All three are written here.
//
// Render data is deliberately left alone. The new paragraph text hashes
// differently, so a previously rendered setup reads as stale and re-renders
// on demand — that is the hash doing its job. Unrendered decks pick the new
// wording up for free.
//
// Idempotent: a project already on the new wording is skipped.
//
//   node server/migrate-setup-narration.js --dry-run
//
// Re-runnable as a repair: a deck already carrying NEW_OPENING in its
// paragraph text is left alone, which also means a deck left with a doubled
// caption by an earlier run of this script is NOT repaired by re-running.
// Fix those with --repair-caption, which only resets text to 'Setup'.

const fs = require('fs');
const path = require('path');
const nDB = require('./ndb.js');

const DRY_RUN = process.argv.includes('--dry-run');
const REPAIR = process.argv.includes('--repair-caption');
const DATA = process.env.NDB_DATA_PATH || './data';
const JSONL_PATH = path.resolve(__dirname, DATA, 'slideshows.jsonl');

// Idempotency is EXACT MATCH: the final opening is one sentence, and every
// earlier generation shares phrases with it ('with no further human
// involvement' appears in three generations) — a contains-check cannot
// discriminate. Compare the whole string.
const OLD_TAIL = 'then stepped back'; // compact-pass marker (informational)

const NEW_OPENING =
    "You're about to hear a conversation between two language models. " +
    "They were given a single prompt \u2014 a topic \u2014 and then left " +
    "to respond to each other directly, with no further human " +
    "involvement.";

if (!fs.existsSync(JSONL_PATH)) {
    throw new Error(`Store not found: ${JSONL_PATH}\nNDB_DATA_PATH resolves to ${JSONL_PATH}`);
}

const db = nDB.Database.open(JSONL_PATH, { persistence: 'immediate' });

(async () => {
    const all = (await db.query({})).filter(d => d._type !== 'app_settings');
    let migrated = 0, alreadyNew = 0, noSetup = 0, skipped = 0, willRerender = 0, repaired = 0;

    for (const doc of all) {
        const idx = (doc.messages || []).findIndex(m => m.type === 'setup');
        const title = doc.source?.topic || 'Untitled';
        if (idx === -1) { console.log(`${doc._id}  ${title} — no setup slide, skipped`); noSetup++; continue; }

        const setup = doc.messages[idx];
        const para = setup.paragraphs?.[0];
        if (!para) { console.log(`${doc._id}  ${title} — setup has no paragraph, skipped`); skipped++; continue; }

        if (String(para.text || '').trim() === NEW_OPENING) {
            if (REPAIR && String(setup.text || '') !== 'Setup') {
                if (DRY_RUN) console.log(`${doc._id}  ${title}  would reset caption to 'Setup'`);
                else {
                    setup.text = 'Setup';
                    db.update(doc._id, { ...doc, messages: doc.messages });
                    repaired++;
                    console.log(`${doc._id}  ${title}  caption reset to 'Setup'`);
                }
            } else {
                alreadyNew++;
            }
            continue;
        }

        // A deck whose opening was hand-edited (a draft of the new wording
        // pasted into the editor, say) must not be silently overwritten. It
        // starts with the same opening sentence, so match on that alone and
        // report it for the user to decide on.
        const PREFIX = "You're about to hear";
        const isStandardOpening = String(para.text || '').includes(OLD_TAIL) || String(para.text || '').includes(PREFIX);
        if (!isStandardOpening) {
            console.log(`${doc._id}  ${title} — opening was hand-edited, left alone`);
            skipped++;
            continue;
        }
        const handEdited = !String(para.text || '').includes(OLD_TAIL);

        const hadAudio = !!para.audioRef;
        if (hadAudio) willRerender++;

        if (DRY_RUN) {
            console.log(`${doc._id}  ${title}${handEdited ? '  [hand-edited opening]' : ''}`);
            console.log(`   would rewrite text + narration; setup audio ${hadAudio ? 'EXISTS -> 1 paragraph re-renders' : 'absent -> nothing to re-render'}`);
            continue;
        }

        // text stays the short caption. The setup layout renders BOTH slide.text
        // and slide.narration as separate blocks, and it is the only opening
        // slide where the two used to be the same string — details and topic
        // keep a caption ("Details", "Topic: …") distinct from the spoken
        // narration. Writing the narration into text as well is what made the
        // sentence appear twice on the slide.
        para.text = NEW_OPENING;
        setup.text = 'Setup';
        setup.narration = NEW_OPENING;
        db.update(doc._id, { ...doc, messages: doc.messages });
        migrated++;
        console.log(`${doc._id}  ${title}  rewritten${handEdited ? ' (was hand-edited)' : ''}${hadAudio ? ' (setup will re-render)' : ''}`);
    }

    console.log(DRY_RUN
        ? `\nDRY RUN — nothing written. ${all.length} project(s): ${migrated} would migrate, ${alreadyNew} already current, ${noSetup} without a setup slide, ${skipped} skipped, ${repaired} caption repairs.`
        : `\nMigrated ${migrated} project(s); ${alreadyNew} already current, ${noSetup} without a setup slide, ${skipped} skipped, ${repaired} caption repaired. ${willRerender} setup paragraph(s) will need a re-render.`);

    db.close();
})();
