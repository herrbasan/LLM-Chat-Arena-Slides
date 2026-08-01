// One-off migration: recompute durationMs for all paragraphs/slides from the
// REAL audio bytes in the nDB bucket. Fixes the sync-rush + early-speaker-
// advance caused by durationMs being set to nVoice's last-word-end (which
// under-reports trailing silence by up to 140%).
//
// Run: node server/fix-durations.js
// Safe to re-run — it just overwrites durationMs with the true MP3 length.

const path = require('path');
const nDB = require('../modules/nDB/napi');
const { mp3DurationMs } = require('./mp3-duration.js');

const dbPath = path.resolve(__dirname, process.env.NDB_DATA_PATH || './data');
const db = nDB.Database.open(path.join(dbPath, 'slideshows.jsonl'), { persistence: 'immediate' });

const AUDIO_BUCKET = 'rendered_slides';

function readAudio(audioRef) {
    const m = audioRef.match(/^([^:]+):([^.]+)\.(.+)$/);
    if (!m) throw new Error(`Invalid audioRef: ${audioRef}`);
    return db.getFile(m[1], m[2], m[3]);
}

(async () => {
    const result = await db.query({});
    const projects = result.projects || result.docs || (Array.isArray(result) ? result : []);
    let fixedParas = 0, fixedSlides = 0, skipped = 0, errors = 0;

    for (const doc of projects) {
        if (!doc || !doc._id) continue;
        let changed = false;

        // v3 paragraphs
        if (Array.isArray(doc.messages)) {
            for (const msg of doc.messages) {
                for (const para of (msg.paragraphs || [])) {
                    if (!para.audioRef) continue;
                    try {
                        const real = mp3DurationMs(readAudio(para.audioRef));
                        if (para.durationMs !== real) {
                            para.durationMs = real;
                            changed = true;
                            fixedParas++;
                        }
                    } catch (e) {
                        console.error(`[${doc._id}] para audio read failed: ${e.message}`);
                        errors++;
                    }
                }
            }
        }

        // v2 slides
        if (Array.isArray(doc.slides)) {
            for (const slide of doc.slides) {
                if (!slide.tts?.audioRef) continue;
                try {
                    const real = mp3DurationMs(readAudio(slide.tts.audioRef));
                    if (slide.tts.durationMs !== real) {
                        slide.tts.durationMs = real;
                        changed = true;
                        fixedSlides++;
                    }
                } catch (e) {
                    console.error(`[${doc._id}] slide audio read failed: ${e.message}`);
                    errors++;
                }
            }
        }

        if (changed) {
            doc.updatedAt = Date.now();
            db.update(doc._id, doc);
            console.log(`[${doc._id}] updated`);
        } else {
            skipped++;
        }
    }

    console.log(`\nDone: ${fixedParas} paragraphs, ${fixedSlides} slides fixed; ${skipped} projects unchanged; ${errors} errors`);
    process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
