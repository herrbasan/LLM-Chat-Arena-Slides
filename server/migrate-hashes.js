const fs = require('fs');
const path = require('path');

const nDB = require('../modules/nDB/napi');
const dbPath = path.join(__dirname, 'data');
const db = nDB.Database.open(path.join(dbPath, 'slideshows.jsonl'), { persistence: 'immediate' });

function getSpokenText(text) {
    return text ? text.toString().replace(/\*+/g, '') : '';
}

function computeRenderHash(text, voice, speed) {
    const state = `${text || ''}|${voice || ''}|${speed || 1.0}`;
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < state.length; i++) {
        const ch = state.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

function computeOldRenderHash(text, voice, speed) {
    const state = `${getSpokenText(text) || ''}|${voice || ''}|${speed || 1.0}`;
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < state.length; i++) {
        const ch = state.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}



const RENDER_CACHE_ROOT = path.join(dbPath, 'render_cache');

let migratedProjects = 0;
let migratedParagraphs = 0;

const projectIds = fs.existsSync(RENDER_CACHE_ROOT)
    ? fs.readdirSync(RENDER_CACHE_ROOT).filter(id => {
        try {
            const doc = db.get(id);
            return doc && doc.version === 3 && doc.messages;
        } catch { return false; }
    })
    : [];

for (const projectId of projectIds) {
    const doc = db.get(projectId);

    const cacheDir = path.join(RENDER_CACHE_ROOT, projectId);
    if (!fs.existsSync(cacheDir)) continue;

    let changed = false;

    for (let msgIdx = 0; msgIdx < doc.messages.length; msgIdx++) {
        const msg = doc.messages[msgIdx];
        const role = msg.speaker || 'narrator';
        const voiceConfig = doc.voiceMapping?.[role] || doc.voiceMapping?.narrator || { voice: 'en-US-Male', speed: 1.0 };

        for (let paraIdx = 0; paraIdx < msg.paragraphs.length; paraIdx++) {
            const para = msg.paragraphs[paraIdx];
            if (!para.text || !para.audioPath) continue;

            const correctHash = computeRenderHash(para.text, voiceConfig.voice, voiceConfig.speed);
            const oldHash = computeOldRenderHash(para.text, voiceConfig.voice, voiceConfig.speed);

            if (para.renderHash === correctHash) continue;
            if (para.renderHash !== oldHash) {
                console.log(`[${projectId}] msg${msgIdx}/p${paraIdx}: unexpected hash ${para.renderHash}, expected ${correctHash} or ${oldHash}`);
                continue;
            }

            const oldFile = `msg_${msgIdx}_p_${paraIdx}_${oldHash}.mp3`;
            const newFile = `msg_${msgIdx}_p_${paraIdx}_${correctHash}.mp3`;
            const oldPath = path.join(cacheDir, oldFile);
            const newPath = path.join(cacheDir, newFile);

            if (!fs.existsSync(oldPath)) {
                console.log(`[${projectId}] msg${msgIdx}/p${paraIdx}: old file missing ${oldFile}`);
                continue;
            }

            fs.renameSync(oldPath, newPath);
            para.audioFile = newFile;
            para.audioPath = newPath;
            para.audioUrl = `/cache/audio/${projectId}/${newFile}`;
            para.renderHash = correctHash;
            changed = true;
            migratedParagraphs++;
        }
    }

    if (changed) {
        db.update(projectId, { ...doc, updatedAt: Date.now() });
        const projectPath = path.join(cacheDir, 'project_v3.json');
        fs.writeFileSync(projectPath, JSON.stringify(doc, null, 2), 'utf-8');
        migratedProjects++;
        console.log(`[${projectId}] migrated ${migratedParagraphs} paragraphs`);
    }
}

console.log(`Migration complete: ${migratedProjects} projects, ${migratedParagraphs} paragraphs`);
