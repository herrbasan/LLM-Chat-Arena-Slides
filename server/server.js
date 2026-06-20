const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const https = require('https');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');

// Allow self-signed certs for internal services.
const tlsAgent = new https.Agent({ rejectUnauthorized: false });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Render concurrency: how many paragraphs to process in parallel.
// Each paragraph does TTS → align sequentially within its slot.
// Kokoro (CPU) and Whisper (GPU) both handle concurrent requests.
const RENDER_CONCURRENCY = parseInt(process.env.RENDER_CONCURRENCY || '4', 10);

// Attempt to load nDB
let nDB;
try {
    nDB = require('../modules/nDB/napi/index.js');
    console.log('[Server] Successfully loaded nDB driver.');
} catch (err) {
    console.error('[Server] Failed to load nDB natively:', err.message);
    console.error('Ensure that the prebuilt binaries exist and are compatible.');
}

// Pipeline modules
const { cleanWithLLM } = require('../pipeline/build-deck.js');
const { buildProject } = require('../pipeline/build-messages.js');
const { parseArenaExport } = require('../pipeline/importer.js');
const { processInput: ttsProcess } = require('../pipeline/tts.js');
const { processInput: alignProcess, processProject: alignProject, ALIGNMENT_VERSION } = require('../pipeline/align.js');
const { speakText } = require('../pipeline/speak-text.js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Global CSP header (replaces meta tag to avoid browser placement warnings).
// media-src * allows the browser to play TTS preview audio directly
// from nSpeech without a server proxy (same as LLM Gateway Chat).
app.use((req, res, next) => {
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; media-src *; img-src 'self' data:;"
    );
    next();
});

// Explicit Configuration Validation
// Only PORT and NDB_DATA_PATH are required at boot. The URL settings
// (LLM_GATEWAY_URL, NSPEECH_URL, NVOICE_URL) can be supplied via env
// OR set at runtime via the app config dialog (see getSettings()).
const requiredEnvVars = ['PORT', 'NDB_DATA_PATH'];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        console.error(`[FATAL] Missing required environment variable: ${envVar}`);
        process.exit(1);
    }
}

const PORT = process.env.PORT || 3600;

// Initialize Database Storage
const dbPath = path.resolve(__dirname, process.env.NDB_DATA_PATH);
if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath, { recursive: true });
}

let db;
if (nDB) {
    db = nDB.Database.open(path.join(dbPath, 'slideshows.jsonl'), { persistence: 'immediate' });
}

// ─── Application Settings (runtime, persisted in nDB) ─────────
// URL/model settings are stored in nDB as a single record. The record
// is found at startup by scanning for _type === 'app_settings' (a
// field nDB itself never sets, so the marker is unambiguous). Its
// auto-generated _id is cached in settingsId for subsequent updates.
//
// The user edits these from the config dialog (gear icon in the
// header). Changes apply live on the next server call — no restart.
// Stored values fall back to env defaults when empty.

const SETTINGS_TYPE = 'app_settings';
let settingsId = null;     // nDB record id of the settings row
let settingsCache = {};    // process-memory mirror

// On startup, find the existing settings record (if any) and cache
// its id + contents in memory.
(function loadSettings() {
    if (!db) return;
    try {
        const all = db.iter();
        for (const doc of all) {
            if (doc && doc._type === SETTINGS_TYPE) {
                settingsId = doc._id;
                settingsCache = doc;
                return;
            }
        }
    } catch (err) {
        // iter() on a fresh or empty store may throw — treat as no
        // settings saved yet. Env defaults will be used.
    }
})();

function loadStoredSettings() {
    return { ...settingsCache };
}

function saveStoredSettings(partial) {
    if (!db) throw new Error('Database not available');
    const merged = { ...settingsCache, ...partial, updatedAt: Date.now() };
    merged._type = SETTINGS_TYPE; // marker so we can find this record on startup
    if (settingsId) {
        // Existing record — update in place.
        db.update(settingsId, merged);
    } else {
        // First write — create via the public API. nDB generates the id.
        settingsId = db.insert(merged);
        // insert() may strip our _type; the id is what we need.
    }
    settingsCache = merged;
    return settingsCache;
}

function getSettings() {
    const stored = loadStoredSettings();
    return {
        // LLM gateway (cleanup + chat)
        llmGatewayUrl: stored.llmGatewayUrl || process.env.LLM_GATEWAY_URL,
        llmGatewayApiKey: stored.llmGatewayApiKey || process.env.LLM_GATEWAY_API_KEY || '',
        cleanupModel: stored.cleanupModel || process.env.CLEANUP_MODEL || 'badkid-llama-chat',
        // nSpeech (TTS)
        nspeechUrl: stored.nspeechUrl || process.env.NSPEECH_URL,
        // nVoice (alignment)
        nvoiceUrl: stored.nvoiceUrl || process.env.NVOICE_URL
    };
}

// Public settings shape (excludes secrets from /api/settings GET by
// default; explicit fetch with ?includeSecrets=true to read the API key).
function getPublicSettings(includeSecrets = false) {
    const s = getSettings();
    if (!includeSecrets) {
        return { ...s, llmGatewayApiKey: s.llmGatewayApiKey ? '***' : '' };
    }
    return s;
}

// ─── Render Audio Storage (nDB file bucket) ──────────────────
// Rendered audio is stored in a single nDB bucket "rendered_slides".
// nDB deduplicates by SHA-256 content hash, so identical audio across
// projects shares storage. Each paragraph/slide stores a compact
// FileRef string (e.g. "rendered_slides:69538b86.mp3") as audioRef.
// The browser fetches via the dynamic /audio/:bucket/:id.:ext route.
// Orphaned files are cleaned via db.gcBuckets() after mutations.
const AUDIO_BUCKET = 'rendered_slides';

// Transient render-progress JSON files (not audio — just polling state).
// Stored on disk under data/render_progress/{projectId}.json.
const RENDER_PROGRESS_ROOT = path.join(dbPath, 'render_progress');
fs.mkdirSync(RENDER_PROGRESS_ROOT, { recursive: true });

// Per-project render abort controllers so the user can stop a
// long-running Render All operation without restarting the server.
const renderControllers = new Map();

// Store an audio buffer in the bucket. Returns { audioRef, audioUrl }.
function storeAudio(name, audioBuffer) {
    const meta = db.storeFile(AUDIO_BUCKET, name, audioBuffer, 'audio/mpeg');
    const ref = `${meta._file.bucket}:${meta._file.id}.${meta._file.ext}`;
    const url = `/audio/${meta._file.bucket}/${meta._file.id}.${meta._file.ext}`;
    return { audioRef: ref, audioUrl: url, byteLength: audioBuffer.length };
}

// Read audio bytes from the bucket by parsing a compact FileRef string.
function readAudio(audioRef) {
    // audioRef format: "bucket:id.ext"
    const m = audioRef.match(/^([^:]+):([^.]+)\.(.+)$/);
    if (!m) throw new Error(`Invalid audioRef: ${audioRef}`);
    return db.getFile(m[1], m[2], m[3]);
}

// Check if an audioRef's file exists in the bucket and is non-empty.
// A zero-byte file is treated as missing so paragraphs with failed/empty
// TTS are re-rendered instead of being considered "has audio".
function audioExists(audioRef) {
    if (!audioRef) return false;
    try {
        const buf = readAudio(audioRef);
        return buf.length > 0;
    } catch {
        return false;
    }
}

// Garbage-collect orphaned audio. Call after any mutation that may
// drop audioRef values from documents (delete, save, re-render).
function gcAudio() {
    try {
        const trashed = db.gcBuckets();
        if (trashed > 0) console.log(`[Audio GC] Trashed ${trashed} orphaned file(s)`);
    } catch (err) {
        console.error('[Audio GC] Failed:', err.message);
    }
}

function getProjectRenderProgressPath(projectId) {
    return path.join(RENDER_PROGRESS_ROOT, `${projectId}.json`);
}

function writeRenderProgress(projectId, stage, message, pct) {
    try {
        fs.writeFileSync(
            getProjectRenderProgressPath(projectId),
            JSON.stringify({ stage, message, pct, ts: Date.now() }, null, 2),
            'utf-8'
        );
    } catch (err) {
        // Progress is best-effort; never let it break the render.
        console.error('[v3 Render] progress write failed:', err.message);
    }
}

async function renderParagraph(project, msgIdx, paraIdx, nVoiceAvailable, options = {}) {
    const msg = project.messages[msgIdx];
    const para = msg.paragraphs[paraIdx];
    const role = msg.speaker || 'narrator';
    const voiceConfig = project.voiceMapping?.[role] || project.voiceMapping?.narrator || { voice: 'en-US-Male', speed: 1.0 };
    const signal = options.signal;

    // Hash must be computed from the spoken text (after speakText
    // normalization) because that's what the audio actually contains.
    // Using raw para.text would mismatch for any paragraph with
    // *emphasis* markers.
    const spokenText = speakText(para.text);
    const renderHash = computeRenderHash(spokenText, voiceConfig.voice, voiceConfig.speed);

    // Paragraph is fresh if its stored hash matches current text/voice/speed,
    // the audio exists in the bucket (and is non-empty), and alignment is at
    // the current version. `force` bypasses the freshness check — the user
    // asked for it, do it.
    const isFresh = para.renderHash === renderHash
        && para.audioRef
        && audioExists(para.audioRef)
        && para.alignVersion === ALIGNMENT_VERSION
        && para.words?.length > 0;

    if (isFresh && !options.force) {
        return { rendered: false, aligned: false };
    }

    // Abort early if the render was cancelled.
    if (signal?.aborted) {
        return { rendered: false, aligned: false, error: 'Render aborted' };
    }

    // Clear stale render data for this paragraph. Old audio will be
    // garbage-collected by gcBuckets() after the render completes.
    delete para.audioRef;
    delete para.audioUrl;
    delete para.words;
    delete para.durationMs;
    delete para.alignComplete;
    delete para.alignVersion;
    delete para.alignError;
    delete para.ttsError;

    // Generate TTS with retry. Empty audio and transient failures (5xx,
    // network errors) are retried; 4xx client errors are not.
    const ttsUrl = `${getSettings().nspeechUrl}/tts?` + new URLSearchParams({
        text: spokenText,
        voice_name: voiceConfig.voice,
        speed: (voiceConfig.speed || 1.0).toString(),
        output_format: 'mp3'
    }).toString();

    let audioBuffer = null;
    let ttsError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        if (signal?.aborted) {
            ttsError = 'Render aborted';
            break;
        }
        try {
            console.log(`[v3 Render] msg${msgIdx}/p${paraIdx}: TTS attempt ${attempt}`);
            const ttsRes = await fetch(ttsUrl, { signal });
            if (!ttsRes.ok) {
                const body = await ttsRes.text().catch(() => '');
                console.error(`[v3 Render] msg${msgIdx}/p${paraIdx} TTS HTTP ${ttsRes.status}: ${body.slice(0, 200)}`);
                ttsError = `TTS HTTP ${ttsRes.status}`;
                // Do not retry client errors (4xx).
                if (ttsRes.status >= 400 && ttsRes.status < 500) break;
                await sleep(500 * attempt);
                continue;
            }
            const buf = Buffer.from(await ttsRes.arrayBuffer());
            if (!buf || buf.length === 0) {
                console.error(`[v3 Render] msg${msgIdx}/p${paraIdx} TTS returned empty audio (attempt ${attempt})`);
                ttsError = 'TTS returned empty audio';
                await sleep(500 * attempt);
                continue;
            }
            audioBuffer = buf;
            break;
        } catch (err) {
            if (err.name === 'AbortError') {
                ttsError = 'Render aborted';
                break;
            }
            console.error(`[v3 Render] msg${msgIdx}/p${paraIdx} TTS network error (attempt ${attempt}):`, err.message);
            ttsError = `TTS network error: ${err.message}`;
            await sleep(500 * attempt);
        }
    }

    if (!audioBuffer) {
        para.renderHash = renderHash;
        para.ttsError = ttsError || 'TTS failed after retries';
        console.error(`[v3 Render] msg${msgIdx}/p${paraIdx} ${para.ttsError}`);
        return { rendered: false, aligned: false, error: para.ttsError };
    }

    const { audioRef, audioUrl, byteLength } = storeAudio(
        `msg_${msgIdx}_p_${paraIdx}_${renderHash}.mp3`, audioBuffer
    );

    para.audioRef = audioRef;
    para.audioUrl = audioUrl;
    para.renderHash = renderHash;
    para.voice = voiceConfig.voice;
    para.speed = voiceConfig.speed;
    para.byteLength = byteLength;

    // Align immediately while the audio is fresh, with retry for transient
    // failures and empty results.
    let aligned = false;
    if (nVoiceAvailable) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (signal?.aborted) {
                para.alignError = 'Render aborted';
                break;
            }
            try {
                const alignRes = await alignParagraph(para, msgIdx, paraIdx, { signal });
                if (alignRes) {
                    para.words = alignRes.words;
                    para.durationMs = alignRes.durationMs;
                    para.alignComplete = alignRes.alignComplete;
                    para.alignVersion = ALIGNMENT_VERSION;
                    aligned = true;
                    console.log(`[v3 Render] msg${msgIdx}/p${paraIdx}: aligned ${alignRes.words.length} words (attempt ${attempt})`);
                    break;
                }
                // alignParagraph should throw on real failures; reaching here
                // means preconditions weren't met (no text/audio).
                para.alignError = 'Alignment skipped';
                break;
            } catch (err) {
                if (err.name === 'AbortError') {
                    para.alignError = 'Render aborted';
                    break;
                }
                const retryable = err.message?.includes('no segments') ||
                                  err.message?.includes('no words') ||
                                  err.message?.includes('nVoice alignment failed') ||
                                  err.message?.includes('timed out') ||
                                  err.message?.includes('network');
                para.alignError = err.message;
                if (retryable && attempt < 3) {
                    console.warn(`[v3 Render] msg${msgIdx}/p${paraIdx} alignment retry ${attempt + 1}: ${err.message}`);
                    await sleep(500 * attempt);
                    continue;
                }
                console.error(`[v3 Render] msg${msgIdx}/p${paraIdx} alignment failed:`, err.message);
                break;
            }
        }
    } else {
        para.alignError = 'nVoice unavailable';
    }

    return { rendered: true, aligned };
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function computeRenderHash(text, voice, speed) {
    const state = `${text || ''}|${voice || ''}|${speed || 1.0}`;
    // Portable 64-bit hash (hex, safe for filenames, consistent with client)
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

function getSpokenText(slide) {
    let text;
    // topic and end slides speak the narration; everything else (setup,
    // details, conversation) speaks the on-screen text. The narration
    // for setup/details is a short spoken intro, and the on-screen
    // meta/text is what the viewer reads while the narrator speaks.
    if (slide.type === 'topic' || slide.type === 'end') {
        text = slide.narration || slide.text || '';
    } else {
        text = slide.text || slide.narration || '';
    }
    // Strip *emphasis* markers via the shared speakText() helper.
    // On-screen slide.text keeps the marks; only spoken text is cleaned.
    // Browser-side mirror: stripEmphasisForSpeech in render.js.
    return speakText(text);
}

function normalizeAlignedWord(word) {
    return String(word).replace(/[^\w]/g, '').toLowerCase();
}

function isImmediateDuplicateWord(previousWord, word) {
    if (!previousWord) return false;
    if (word.startMs - previousWord.endMs > 250) return false;
    return normalizeAlignedWord(previousWord.word) === normalizeAlignedWord(word.word);
}

// Serve Client Config dynamically. Reads from getSettings() so URL
// changes saved via the config dialog are reflected on the next page
// load (the config script is fetched on every page load).
app.get('/js/config.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    const settings = getSettings();
    const configScript = `
// ============================================
// Dynamically Generated Slideshow Configuration
// ============================================
window.SLIDESHOW_CONFIG = {
    GATEWAY_URL: ${JSON.stringify(settings.llmGatewayUrl)},
    NSPEECH_URL: ${JSON.stringify(settings.nspeechUrl)},
    NVOICE_URL: ${JSON.stringify(settings.nvoiceUrl)},
    DEFAULT_NARRATOR_VOICE: 'en-US-Male',
    DEFAULT_NARRATOR_SPEED: 0.95
};
if (!window.SLIDESHOW_CONFIG.GATEWAY_URL) {
    throw new Error('FATAL: Slideshow client is missing required configuration properties.');
}
    `;
    res.send(configScript);
});

// APIs
app.get('/api/projects', async (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not initialized' });
    }
    try {
        const projects = await db.query({}); // Return all
        console.log("DB QUERY RESULTS:", projects);
        console.log("IS ARRAY?", Array.isArray(projects));
        // It is better to return only metadata for the list to save bandwidth if decks are large, but for now we return all.
        res.json({ projects });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/projects', (req, res) => {
    if (!db) return res.status(500).json({ error: 'Database not initialized' });
    const body = req.body;
    const isV3 = body.version === 3 || (body.messages && !body.slides);

    if (isV3) {
        const id = db.insertWithPrefix('slideshow', {
            version: 3,
            source: body.source || {},
            voiceMapping: body.voiceMapping || {},
            messages: body.messages || [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        });
        res.json({ id, status: 'created', version: 3 });
    } else {
        const { source, voiceMapping, slides } = body;
        const id = db.insertWithPrefix('slideshow', {
            version: 1,
            source: source || {},
            voiceMapping: voiceMapping || {},
            slides: slides || [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        });
        res.json({ id, status: 'created', version: 1 });
    }
});

app.get('/api/projects/:id', (req, res) => {
    if (!db) return res.status(500).json({ error: 'Database not initialized' });
    const doc = db.get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Project not found' });

    // v3 projects: render state is authoritative only from nDB.
    // The render output directory is not a cache; it is rewritten
    // from scratch on every render, so we do not merge it back here.
    if (doc.version === 3) {
        return res.json(doc);
    }

    // v3 projects store everything (including tts data) directly in nDB.
    // v2 projects now persist rendered slide data (audioRef, audioUrl,
    // alignment) to nDB via the render-deck endpoint, so no separate
    // cache merge is needed.
    res.json(doc);
});

app.get('/api/voices', async (req, res) => {
    try {
        const response = await fetch(`${getSettings().nspeechUrl}/voices`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error('[Server] Failed to fetch voices from nSpeech:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── App Settings (config dialog) ──────────────────────────────
//
// GET  /api/settings                  → public settings (API key redacted)
// GET  /api/settings?includeSecrets=1 → full settings including API key
// PUT  /api/settings                  → merge partial settings; returns the
//                                       stored record. Empty strings clear
//                                       the stored value (env default takes
//                                       over on next read).
app.get('/api/settings', (req, res) => {
    if (!db) return res.status(500).json({ error: 'Database not initialized' });
    const includeSecrets = req.query.includeSecrets === '1' || req.query.includeSecrets === 'true';
    res.json(getPublicSettings(includeSecrets));
});

app.put('/api/settings', (req, res) => {
    if (!db) return res.status(500).json({ error: 'Database not initialized' });
    const body = req.body || {};
    // Only allow known keys; ignore anything else to avoid surprises.
    const allowed = ['llmGatewayUrl', 'llmGatewayApiKey', 'cleanupModel', 'nspeechUrl', 'nvoiceUrl'];
    const patch = {};
    for (const key of allowed) {
        if (key in body) {
            // Empty string is a valid value: clears the stored override
            // so the env default takes over. (We don't distinguish
            // "never set" from "cleared" — both fall through to env.)
            patch[key] = typeof body[key] === 'string' ? body[key].trim() : body[key];
        }
    }
    if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'No recognized settings fields in body' });
    }
    const stored = saveStoredSettings(patch);
    // Return the public view (API key redacted unless explicitly asked).
    const isApiKeyPatch = 'llmGatewayApiKey' in patch;
    res.json(getPublicSettings(isApiKeyPatch));
});

// GET /api/models — proxy to the LLM gateway's /v1/models.
// Used by the config dialog to populate the cleanup model <select>.
// Returns { models: [{ id, ... }, ...] } or { models: [], error } on
// gateway failure (so the dialog can fall back to a free-text input).
app.get('/api/models', async (req, res) => {
    const settings = getSettings();
    if (!settings.llmGatewayUrl) {
        return res.json({ models: [], error: 'LLM gateway URL not configured' });
    }
    try {
        const response = await fetch(`${settings.llmGatewayUrl.replace(/\/+$/, '')}/v1/models`, {
            signal: AbortSignal.timeout(5000),
            agent: tlsAgent,
            headers: settings.llmGatewayApiKey
                ? { 'Authorization': `Bearer ${settings.llmGatewayApiKey}` }
                : {}
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        // Normalize to a flat list of model ids; different gateways
        // return different shapes (some nest under .data, some return
        // an array, some return an object with a .models field).
        let models = [];
        if (Array.isArray(data)) {
            models = data.map(m => (typeof m === 'string' ? m : m.id)).filter(Boolean);
        } else if (Array.isArray(data.data)) {
            models = data.data.map(m => m.id).filter(Boolean);
        } else if (Array.isArray(data.models)) {
            models = data.models.map(m => (typeof m === 'string' ? m : m.id)).filter(Boolean);
        } else if (typeof data === 'object' && data !== null) {
            // Some gateways return a top-level object of { id: meta }.
            models = Object.keys(data);
        }
        res.json({ models });
    } catch (err) {
        console.warn('[Server] /api/models fetch failed:', err.message);
        res.json({ models: [], error: err.message });
    }
});

app.put('/api/projects/:id', (req, res) => {
    if (!db) return res.status(500).json({ error: 'Database not initialized' });
    const existing = db.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Project not found' });

    const updated = {
        ...existing,
        ...req.body,
        _id: req.params.id,
        updatedAt: Date.now()
    };
    // Preserve version from existing if not in body
    if (!req.body.version && existing.version) {
        updated.version = existing.version;
    }
    db.update(req.params.id, updated);

    // GC orphan audio: after the client strips cached TTS data (e.g.
    // via the editor's Edit Message dialog, which replaces paragraphs
    // with fresh `{ text }` objects), the old audioRefs are gone from
    // the document. nDB's gcBuckets() sweeps all unreferenced files.
    gcAudio();

    res.json({ status: 'updated' });
});

app.delete('/api/projects/:id', (req, res) => {
    if (!db) return res.status(500).json({ error: 'Database not initialized' });
    db.delete(req.params.id);
    // The conversation document is now in nDB's trash. Its audioRefs
    // are no longer referenced by any active document — gcBuckets()
    // moves them to the file trash.
    gcAudio();
    res.json({ status: 'deleted' });
});

// ─── LLM Slide Generation (with progress streaming) ──────────

app.post('/api/generate-deck', async (req, res) => {
    const arenaData = req.body;
    if (!arenaData || !Array.isArray(arenaData.messages)) {
        return res.status(400).json({ error: 'Invalid Arena export: missing messages array' });
    }

    // Honor the Accept header. If client wants SSE, stream progress events.
    // Otherwise fall back to a single JSON response (legacy behavior).
    const accept = (req.headers['accept'] || '').toLowerCase();
    const useSSE = accept.includes('text/event-stream');

    if (!useSSE) {
        // Legacy JSON mode.
        try {
            console.log(`[Server] Generate deck: "${arenaData.topic}", ${arenaData.messages.length} messages`);
            const source = parseArenaExport(arenaData);
            const deck = await cleanWithLLM(source, null);
            res.json(deck);
        } catch (err) {
            console.error('[Server] Generate deck failed:', err.message);
            res.status(500).json({ error: err.message });
        }
        return;
    }

    // SSE progress mode.
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no' // Disable proxy buffering (nginx etc.)
    });
    // Flush headers immediately so the client sees a connection.
    if (res.flushHeaders) res.flushHeaders();
    // Disable Nagle's algorithm so each write is sent as a separate
    // TCP packet — otherwise progress events batch up and the client
    // sees them all at once.
    if (res.socket) res.socket.setNoDelay(true);

    const send = (event, data) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        // Compression middleware adds a .flush() method; if present,
        // force the write to the wire immediately.
        if (res.flush) res.flush();
    };

    // Periodic keep-alive so proxies don't drop the connection.
    const heartbeat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch {}
    }, 15000);

    try {
        console.log(`[Server] Generate deck (SSE): "${arenaData.topic}", ${arenaData.messages.length} messages`);
        const source = parseArenaExport(arenaData);
        const deck = await cleanWithLLM(source, null, (stage, message, pct) => {
            send('progress', { stage, message, pct });
        });
        send('done', { slideCount: deck.slides.length });
        send('result', deck);
        res.end();
    } catch (err) {
        console.error('[Server] Generate deck failed:', err.message);
        send('error', { message: err.message });
        res.end();
    } finally {
        clearInterval(heartbeat);
    }
});

// ─── v3 Generate Deck (Paragraph Architecture) ─────────────
app.post('/api/v3/generate-deck', async (req, res) => {
    const arenaData = req.body;
    if (!arenaData || !Array.isArray(arenaData.messages)) {
        return res.status(400).json({ error: 'Invalid Arena export: missing messages array' });
    }

    const accept = (req.headers['accept'] || '').toLowerCase();
    const useSSE = accept.includes('text/event-stream');

    if (!useSSE) {
        try {
            console.log(`[Server] v3 Generate: ${arenaData.messages.length} messages`);
            const project = await buildProject(arenaData, null, null, { skipClean: false, settings: getSettings() });
            res.json(project);
        } catch (err) {
            console.error('[Server] v3 Generate failed:', err.message);
            res.status(500).json({ error: err.message });
        }
        return;
    }

    // SSE progress mode
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    if (res.flushHeaders) res.flushHeaders();
    if (res.socket) res.socket.setNoDelay(true);

    const send = (event, data) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        if (res.flush) res.flush();
    };

    const heartbeat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch {}
    }, 15000);

    try {
        console.log(`[Server] v3 Generate (SSE): ${arenaData.messages.length} messages`);
        const project = await buildProject(arenaData, null, (stage, message, pct) => {
            send('progress', { stage, message, pct });
        }, { skipClean: false, settings: getSettings() });
        const totalParagraphs = project.messages.reduce((sum, m) => sum + m.paragraphs.length, 0);
        send('done', { messageCount: project.messages.length, paragraphCount: totalParagraphs });
        send('result', project);
        res.end();
    } catch (err) {
        console.error('[Server] v3 Generate failed:', err.message);
        send('error', { message: err.message });
        res.end();
    } finally {
        clearInterval(heartbeat);
    }
});

// Raw import: builds a v3 project skeleton from the Arena export
// WITHOUT running the LLM cleaning pass. Used by the import flow so
// the user is never surprised by a silent LLM call. The editor's
// "Generate with AI" button is the explicit trigger for the clean
// pass (which calls /api/v3/generate-deck above). The resulting
// project still has the deterministic opening slides (setup +
// details + topic, using source.seedPrompt) and paragraph-split
// conversation messages, but no LLM-derived text cleaning.
app.post('/api/v3/import-raw', async (req, res) => {
    const arenaData = req.body;
    if (!arenaData || !Array.isArray(arenaData.messages)) {
        return res.status(400).json({ error: 'Invalid Arena export: missing messages array' });
    }
    try {
        console.log(`[Server] v3 Import (raw): ${arenaData.messages.length} messages`);
        const project = await buildProject(arenaData, null, null, { skipClean: true });
        res.json(project);
    } catch (err) {
        console.error('[Server] v3 Import (raw) failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Cached Render ──────────────────────────────────────────

// ─── LLM Chat Proxy ────────────────────────────────────────
// Proxies the LLM gateway's OpenAI-compatible /v1/chat/completions
// endpoint. The browser can't reach the gateway directly because:
//   1. CSP default-src 'self' blocks cross-origin connect-src
//   2. The gateway URL (LLM_GATEWAY_URL) may not be reachable from
//      the browser's network
// Streaming is end-to-end: we forward the gateway's SSE bytes
// verbatim so the existing GatewayClient SSE parser works without
// any changes to its event semantics.
app.post('/api/chat', async (req, res) => {
    const settings = getSettings();
    const gatewayUrl = settings.llmGatewayUrl;
    if (!gatewayUrl) {
        res.status(500).json({ error: 'LLM gateway URL is not configured (set it in the app settings or LLM_GATEWAY_URL env var)' });
        return;
    }

    // Force stream=true on the wire regardless of what the client
    // sent; the editor's GatewayClient always wants streaming.
    const bodyParams = { ...(req.body || {}), stream: true };
    delete bodyParams.session_id; // server assigns its own
    const url = `${gatewayUrl.replace(/\/+$/, '')}/v1/chat/completions`;

    const headers = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
    if (settings.llmGatewayApiKey) {
        headers['Authorization'] = `Bearer ${settings.llmGatewayApiKey}`;
    }

    // Initial-connect timeout only. Once we're streaming, the
    // response body drives lifetime; no overall read timeout.
    const controller = new AbortController();
    const initialTimeout = setTimeout(() => controller.abort(), 30000);

    let gatewayRes;
    try {
        gatewayRes = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(bodyParams),
            signal: controller.signal
        });
    } catch (err) {
        clearTimeout(initialTimeout);
        console.error('[Chat Proxy] Gateway unreachable:', err.message);
        res.status(502).json({ error: 'LLM gateway unreachable: ' + err.message });
        return;
    }
    clearTimeout(initialTimeout);

    if (!gatewayRes.ok) {
        const errText = await gatewayRes.text();
        console.error(`[Chat Proxy] Gateway ${gatewayRes.status}: ${errText.substring(0, 500)}`);
        res.status(gatewayRes.status).json({ error: `Gateway returned ${gatewayRes.status}`, detail: errText.substring(0, 500) });
        return;
    }

    // Stream the SSE response through to the client verbatim.
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    if (res.flushHeaders) res.flushHeaders();

    // Heartbeat keeps proxies from idling out a long stream.
    const heartbeat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch {}
    }, 15000);

    const clientGone = () => {
        clearInterval(heartbeat);
        try { gatewayRes.body?.cancel?.(); } catch {}
    };
    req.on('close', clientGone);
    req.on('aborted', clientGone);

    try {
        const reader = gatewayRes.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(value)) {
                // Backpressure: wait for drain before pulling more.
                await new Promise(r => res.once('drain', r));
            }
        }
    } catch (err) {
        console.error('[Chat Proxy] Stream error:', err.message);
        try { res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`); } catch {}
    } finally {
        clearInterval(heartbeat);
        try { res.end(); } catch {}
    }
});

app.post('/api/render-deck/:id', async (req, res) => {
    try {
        const projectId = req.params.id;
        const deck = req.body;
        if (!deck || !Array.isArray(deck.slides)) {
            return res.status(400).json({ error: 'Invalid deck: missing slides array' });
        }

        let reRendered = 0;
        let cached = 0;

        for (let i = 0; i < deck.slides.length; i++) {
            const slide = deck.slides[i];
            const text = getSpokenText(slide);
            const role = slide.speaker || 'narrator';
            const voiceConfig = deck.voiceMapping[role] || deck.voiceMapping.narrator || { voice: 'en-US-Male', speed: 1.0 };
            const renderHash = computeRenderHash(text, voiceConfig.voice, voiceConfig.speed);

            // Cache hit: audioRef exists and hash matches. Reuse audio,
            // preserve alignment data if the hash hasn't changed.
            if (slide.tts?.audioRef && slide.tts.renderHash === renderHash && audioExists(slide.tts.audioRef)) {
                slide.tts.cached = true;
                cached++;
                continue;
            }

            // Cache miss — generate TTS
            console.log(`[Render] Slide ${i}: cache miss, generating TTS...`);
            const ttsUrl = `${getSettings().nspeechUrl}/tts?` + new URLSearchParams({
                text: text,
                voice_name: voiceConfig.voice,
                speed: voiceConfig.speed.toString(),
                output_format: 'mp3'
            }).toString();

            const ttsRes = await fetch(ttsUrl);
            if (!ttsRes.ok) {
                console.error(`[Render] Slide ${i} TTS failed: HTTP ${ttsRes.status}`);
                slide.tts = { error: `TTS HTTP ${ttsRes.status}`, renderHash };
                continue;
            }

            const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
            const { audioRef, audioUrl, byteLength } = storeAudio(
                `slide_${String(i).padStart(3, '0')}_${renderHash}.mp3`, audioBuffer
            );

            slide.tts = {
                audioRef,
                audioUrl,
                voice: voiceConfig.voice,
                speed: voiceConfig.speed,
                byteLength,
                renderHash
            };
            reRendered++;
        }

        // Quick nVoice health check before attempting alignment
        let nVoiceAvailable = false;
        try {
            const nvRes = await fetch(getSettings().nvoiceUrl, { signal: AbortSignal.timeout(3000), agent: tlsAgent });
            nVoiceAvailable = nvRes.ok;
        } catch { /* nVoice not available */ }

        if (nVoiceAvailable) {
            console.log(`[Render] ${reRendered} generated, ${cached} cached. Running alignment...`);
            // Align all slides that have audio but no word timing data
            for (let i = 0; i < deck.slides.length; i++) {
                const slide = deck.slides[i];
                if (!slide.tts || slide.tts.error || !slide.tts.audioRef) continue;
                if (!audioExists(slide.tts.audioRef)) continue;
                if (slide.tts.alignVersion === ALIGNMENT_VERSION && slide.tts.words && slide.tts.words.length > 0) continue;

                alignAttempted++;
                try {
                    const alignRes = await alignSingleSlide(slide, i);
                    if (alignRes) {
                        slide.tts.words = alignRes.words;
                        slide.tts.segments = alignRes.segments;
                        slide.tts.durationMs = alignRes.durationMs;
                        slide.tts.alignComplete = alignRes.alignComplete;
                        slide.tts.sourceWordCount = alignRes.sourceWordCount;
                        slide.tts.alignedWordCount = alignRes.alignedWordCount;
                        slide.tts.alignVersion = ALIGNMENT_VERSION;
                        console.log(`[Render] Slide ${i}: aligned ${alignRes.words.length} words`);
                    }
                } catch (err) {
                    console.error(`[Render] Slide ${i} alignment failed:`, err.message);
                    slide.tts.alignError = err.message;
                }
            }
            console.log(`[Render] Alignment complete: ${alignAttempted} slides attempted`);
        } else {
            console.log(`[Render] ${reRendered} generated, ${cached} cached. nVoice unavailable — skipping alignment.`);
        }

        // Persist rendered deck metadata back to nDB so render page shows correct state
        if (db) {
            const existing = db.get(projectId);
            if (existing) {
                db.update(projectId, {
                    ...existing,
                    slides: deck.slides,
                    updatedAt: Date.now()
                });
            }
        }

        console.log(`[Render] Complete for ${projectId}: ${reRendered} generated, ${cached} cached, ${deck.slides.length} slides`);
        res.json(deck);
    } catch (err) {
        console.error('[Server] Render failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── v3 Render Deck (Paragraph Architecture) ───────────────

app.post('/api/v3/render-deck/:id', async (req, res) => {
    const projectId = req.params.id;

    // If a render is already running for this project, reject the new request.
    if (renderControllers.has(projectId)) {
        return res.status(409).json({ error: 'Render already in progress' });
    }

    try {
        // Load the project from nDB. The browser sends its view of the
        // project, but nDB is the source of truth. We only use the request
        // body for intent (force, targets) and voice mapping overrides.
        const storedProject = db.get(projectId);
        if (!storedProject) {
            return res.status(404).json({ error: 'Project not found' });
        }
        if (storedProject.version !== 3) {
            return res.status(400).json({ error: `Expected version 3, got ${storedProject.version}` });
        }
        if (!storedProject.messages || !Array.isArray(storedProject.messages)) {
            return res.status(400).json({ error: 'Invalid v3 project: missing messages array' });
        }

        const project = { ...storedProject };
        // Accept voice mapping updates from the editor, but keep nDB
        // paragraphs/source as the authoritative payload.
        if (req.body?.voiceMapping) {
            project.voiceMapping = req.body.voiceMapping;
        }

        const controller = new AbortController();
        renderControllers.set(projectId, controller);

        const targets = req.body?.targets;
        const force = req.body?.force === true;
        const totalParagraphs = project.messages.reduce((sum, m) => sum + m.paragraphs.length, 0);

        // Check nVoice availability once up front.
        let nVoiceAvailable = false;
        try {
            const nvRes = await fetch(getSettings().nvoiceUrl, { signal: AbortSignal.timeout(3000), agent: tlsAgent });
            nVoiceAvailable = nvRes.ok;
        } catch {}

        let processedCount = 0;
        let renderedCount = 0;
        let alignSucceeded = 0;
        let totalWordsRendered = 0;
        let stopped = false;

        // Build the flat list of render targets (msgIdx, paraIdx).
        const renderTargets = [];
        for (let msgIdx = 0; msgIdx < project.messages.length; msgIdx++) {
            const msg = project.messages[msgIdx];
            for (let paraIdx = 0; paraIdx < msg.paragraphs.length; paraIdx++) {
                const para = msg.paragraphs[paraIdx];
                if (!para.text || para.text.trim() === '' || para.text.trim() === '...') continue;
                if (targets && !targets.some(t => t.msgIdx === msgIdx && t.paraIdx === paraIdx)) continue;
                renderTargets.push({ msgIdx, paraIdx });
            }
        }
        const totalToRender = renderTargets.length;

        writeRenderProgress(projectId, 'render', `Starting render (${RENDER_CONCURRENCY} parallel)...`, 0);

        const renderStartTime = Date.now();

        // Worker-pool: process up to RENDER_CONCURRENCY paragraphs at once.
        // Each worker does TTS → align sequentially within its slot.
        let nextTargetIdx = 0;

        async function renderWorker() {
            while (!controller.signal.aborted) {
                const myIdx = nextTargetIdx++;
                if (myIdx >= totalToRender) return;

                const { msgIdx, paraIdx } = renderTargets[myIdx];
                const result = await renderParagraph(project, msgIdx, paraIdx, nVoiceAvailable, { force, signal: controller.signal });

                processedCount++;
                if (result.rendered) {
                    renderedCount++;
                    const para = project.messages[msgIdx].paragraphs[paraIdx];
                    const wordCount = (para.text || '').split(/\s+/).filter(w => w.length > 0).length;
                    totalWordsRendered += wordCount;
                }
                if (result.aligned) alignSucceeded++;

                // Progress reporting
                if (processedCount % 5 === 0 || processedCount === totalToRender) {
                    const pct = Math.min(99, Math.floor((processedCount / totalToRender) * 100));
                    const elapsedSec = (Date.now() - renderStartTime) / 1000;
                    const wps = elapsedSec > 0 ? (totalWordsRendered / elapsedSec).toFixed(1) : '0';
                    writeRenderProgress(projectId, 'render', `Paragraph ${processedCount}/${totalToRender} (${wps} words/s)`, pct);
                }

                // Periodic intermediate persistence
                if (processedCount % 10 === 0) {
                    if (db) {
                        const existing = db.get(projectId);
                        if (existing) {
                            db.update(projectId, {
                                ...existing,
                                version: 3,
                                messages: project.messages,
                                voiceMapping: project.voiceMapping,
                                source: project.source,
                                updatedAt: Date.now()
                            });
                        }
                    }
                }
            }
            stopped = true;
        }

        // Launch workers and wait for all to finish.
        const workers = [];
        for (let i = 0; i < Math.min(RENDER_CONCURRENCY, totalToRender); i++) {
            workers.push(renderWorker());
        }
        await Promise.all(workers);

        // Throughput summary
        const totalElapsedSec = (Date.now() - renderStartTime) / 1000;
        const finalWps = totalElapsedSec > 0 ? (totalWordsRendered / totalElapsedSec).toFixed(1) : '0';

        // Persist to nDB
        if (db) {
            const existing = db.get(projectId);
            if (existing) {
                db.update(projectId, {
                    ...existing,
                    version: 3,
                    messages: project.messages,
                    voiceMapping: project.voiceMapping,
                    source: project.source,
                    updatedAt: Date.now()
                });
            }
        }

        // Garbage-collect orphaned audio via nDB's bucket GC.
        // Must run AFTER db.update() so newly-referenced files are
        // visible in the persisted documents and don't get trashed.
        gcAudio();

        renderControllers.delete(projectId);

        if (stopped) {
            const alignFailed = renderedCount - alignSucceeded;
            console.log(`[v3 Render] Stopped for ${projectId}: ${renderedCount} re-rendered, ${alignSucceeded} aligned, ${alignFailed} alignment failures, ${processedCount} processed, ${finalWps} words/s (${totalElapsedSec.toFixed(1)}s)`);
            writeRenderProgress(projectId, 'stopped', `Render stopped: ${renderedCount} re-rendered, ${alignSucceeded} aligned, ${alignFailed} alignment failures`, 0);
            return res.json({ stopped: true, project, renderedCount, alignSucceeded, processedCount });
        }

        const alignFailed = renderedCount - alignSucceeded;
        console.log(`[v3 Render] Complete for ${projectId}: ${renderedCount} re-rendered, ${alignSucceeded} aligned, ${alignFailed} alignment failures, ${processedCount} processed, ${finalWps} words/s (${totalElapsedSec.toFixed(1)}s)`);
        writeRenderProgress(projectId, 'done', `Render complete: ${renderedCount} re-rendered, ${alignSucceeded} aligned, ${alignFailed} alignment failures (${finalWps} words/s)`, 100);
        res.json(project);
    } catch (err) {
        renderControllers.delete(projectId);
        console.error('[Server] v3 Render failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── v3 Stop Render ────────────────────────────────────────

app.post('/api/v3/render-stop/:id', (req, res) => {
    const projectId = req.params.id;
    const controller = renderControllers.get(projectId);
    if (!controller) {
        return res.status(409).json({ error: 'No render in progress' });
    }
    controller.abort();
    res.json({ stopped: true });
});

// ─── v3 Render Single Message ──────────────────────────────

app.post('/api/v3/render-message/:id/:msgIdx', async (req, res) => {
    try {
        const projectId = req.params.id;
        const msgIdx = parseInt(req.params.msgIdx, 10);

        if (!db) return res.status(500).json({ error: 'Database not available' });
        const doc = db.get(projectId);
        if (!doc) return res.status(404).json({ error: 'Project not found' });
        if (doc.version !== 3) return res.status(400).json({ error: 'Not a v3 project' });

        const msg = doc.messages?.[msgIdx];
        if (!msg) return res.status(400).json({ error: `Invalid message index: ${msgIdx}` });

        let nVoiceAvailable = false;
        try {
            const nvRes = await fetch(getSettings().nvoiceUrl, { signal: AbortSignal.timeout(3000), agent: tlsAgent });
            nVoiceAvailable = nvRes.ok;
        } catch {}

        let renderedCount = 0;
        let alignSucceeded = 0;

        for (let paraIdx = 0; paraIdx < msg.paragraphs.length; paraIdx++) {
            const para = msg.paragraphs[paraIdx];
            if (!para.text || para.text.trim() === '' || para.text.trim() === '...') continue;

            // Force re-render on explicit per-message click: even if
            // the paragraph is already fresh, the user asked for it.
            const result = await renderParagraph(doc, msgIdx, paraIdx, nVoiceAvailable, { force: true });
            if (result.rendered) renderedCount++;
            if (result.aligned) alignSucceeded++;
        }

        db.update(projectId, { ...doc, updatedAt: Date.now() });
        gcAudio();

        console.log(`[v3 Render] Message ${msgIdx} complete for ${projectId}: ${renderedCount} re-rendered, ${alignSucceeded} aligned`);
        res.json({ message: msg, renderedCount, alignSucceeded });
    } catch (err) {
        console.error('[Server] v3 render-message failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── v3 Render Single Paragraph ────────────────────────────

app.post('/api/v3/render-paragraph/:id/:msgIdx/:paraIdx', async (req, res) => {
    try {
        const { id: projectId, msgIdx, paraIdx } = req.params;
        const mi = parseInt(msgIdx, 10);
        const pi = parseInt(paraIdx, 10);

        if (!db) return res.status(500).json({ error: 'Database not available' });
        const doc = db.get(projectId);
        if (!doc) return res.status(404).json({ error: 'Project not found' });
        if (doc.version !== 3) return res.status(400).json({ error: 'Not a v3 project' });

        const msg = doc.messages?.[mi];
        if (!msg) return res.status(400).json({ error: `Invalid message index: ${mi}` });
        const para = msg.paragraphs?.[pi];
        if (!para) return res.status(400).json({ error: `Invalid paragraph index: ${pi}` });

        const role = msg.speaker || 'narrator';
        const voiceConfig = doc.voiceMapping?.[role] || doc.voiceMapping?.narrator || { voice: 'en-US-Male', speed: 1.0 };

        // Generate TTS. Hash must be computed from spoken text so it
        // matches what the browser expects for freshness checks.
        const spokenText = speakText(para.text);
        const renderHash = computeRenderHash(spokenText, voiceConfig.voice, voiceConfig.speed);

        console.log(`[v3 Render] Re-rendering msg${mi}/p${pi}...`);
        const ttsUrl = `${getSettings().nspeechUrl}/tts?` + new URLSearchParams({
            text: spokenText,
            voice_name: voiceConfig.voice,
            speed: (voiceConfig.speed || 1.0).toString(),
            output_format: 'mp3'
        }).toString();

        const ttsRes = await fetch(ttsUrl);
        if (!ttsRes.ok) {
            return res.status(502).json({ error: `TTS failed: HTTP ${ttsRes.status}` });
        }

        const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
        const { audioRef, audioUrl, byteLength } = storeAudio(
            `msg_${mi}_p_${pi}_${renderHash}.mp3`, audioBuffer
        );

        para.audioRef = audioRef;
        para.audioUrl = audioUrl;
        para.renderHash = renderHash;
        para.voice = voiceConfig.voice;
        para.speed = voiceConfig.speed;
        para.byteLength = byteLength;

        // Clear old alignment data
        delete para.words;
        delete para.durationMs;
        delete para.alignComplete;
        delete para.alignVersion;
        delete para.alignError;

        // Run alignment
        let nVoiceAvailable = false;
        try {
            const nvRes = await fetch(getSettings().nvoiceUrl, { signal: AbortSignal.timeout(3000), agent: tlsAgent });
            nVoiceAvailable = nvRes.ok;
        } catch {}

        if (nVoiceAvailable) {
            try {
                const alignRes = await alignParagraph(para, mi, pi);
                if (alignRes) {
                    para.words = alignRes.words;
                    para.durationMs = alignRes.durationMs;
                    para.alignComplete = alignRes.alignComplete;
                    para.alignVersion = ALIGNMENT_VERSION;
                    console.log(`[v3 Render] msg${mi}/p${pi}: aligned ${alignRes.words.length} words`);
                }
            } catch (err) {
                console.error(`[v3 Render] msg${mi}/p${pi} alignment failed:`, err.message);
                para.alignError = err.message;
            }
        }

        // Update nDB
        db.update(projectId, {
            ...doc,
            updatedAt: Date.now()
        });
        gcAudio();

        res.json(para);
    } catch (err) {
        console.error('[Server] v3 render-paragraph failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── v3 Render Progress (polling) ──────────────────────────

app.get('/api/v3/render-progress/:id', (req, res) => {
    try {
        const progressPath = getProjectRenderProgressPath(req.params.id);
        if (!fs.existsSync(progressPath)) {
            return res.json({ stage: 'idle', message: 'No active render', pct: 0 });
        }
        const data = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
        res.json(data);
    } catch (err) {
        console.error('[Server] v3 render-progress failed:', err.message);
        res.status(500).json({ stage: 'error', message: err.message, pct: 0 });
    }
});

// ─── Per-Slide Render ───────────────────────────────────────

app.post('/api/render-slide/:id/:idx', async (req, res) => {
    try {
        const projectId = req.params.id;
        const slideIdx = parseInt(req.params.idx, 10);

        if (!db) return res.status(500).json({ error: 'Database not initialized' });
        const doc = db.get(projectId);
        if (!doc) return res.status(404).json({ error: 'Project not found' });

        const deck = doc;
        if (!deck.slides || slideIdx < 0 || slideIdx >= deck.slides.length) {
            return res.status(400).json({ error: 'Invalid slide index' });
        }

        const slide = deck.slides[slideIdx];
        const text = getSpokenText(slide);
        const role = slide.speaker || 'narrator';
        const voiceConfig = deck.voiceMapping[role] || deck.voiceMapping.narrator || { voice: 'en-US-Male', speed: 1.0 };
        const renderHash = computeRenderHash(text, voiceConfig.voice, voiceConfig.speed);

        // Cache hit: audioRef exists and hash matches.
        const audioCached = slide.tts?.audioRef && slide.tts.renderHash === renderHash && audioExists(slide.tts.audioRef);

        if (!audioCached) {
            // Generate TTS
            console.log(`[Render] Slide ${slideIdx}: generating TTS...`);
            const ttsUrl = `${getSettings().nspeechUrl}/tts?` + new URLSearchParams({
                text, voice_name: voiceConfig.voice, speed: voiceConfig.speed.toString(), output_format: 'mp3'
            }).toString();

            const ttsRes = await fetch(ttsUrl);
            if (!ttsRes.ok) {
                slide.tts = { error: `TTS HTTP ${ttsRes.status}`, renderHash };
                return res.json({ slideIdx, slide, error: slide.tts.error });
            }

            const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
            const { audioRef, audioUrl, byteLength } = storeAudio(
                `slide_${String(slideIdx).padStart(3, '0')}_${renderHash}.mp3`, audioBuffer
            );

            slide.tts = {
                audioRef,
                audioUrl,
                voice: voiceConfig.voice,
                speed: voiceConfig.speed,
                byteLength,
                renderHash
            };
        } else {
            slide.tts.cached = true;
        }

        // Run alignment (always, unless words are already present and fresh)
        const needsAlignment = slide.tts.alignVersion !== ALIGNMENT_VERSION || !slide.tts.words || slide.tts.words.length === 0;

        let nVoiceAvailable = false;
        try {
            const nvRes = await fetch(getSettings().nvoiceUrl, { signal: AbortSignal.timeout(3000), agent: tlsAgent });
            nVoiceAvailable = nvRes.ok;
        } catch {}

        if (needsAlignment && nVoiceAvailable && slide.tts.audioRef) {
            try {
                const alignRes = await alignSingleSlide(slide, slideIdx);
                if (alignRes) {
                    slide.tts.words = alignRes.words;
                    slide.tts.segments = alignRes.segments;
                    slide.tts.durationMs = alignRes.durationMs;
                    slide.tts.alignComplete = alignRes.alignComplete;
                    slide.tts.sourceWordCount = alignRes.sourceWordCount;
                    slide.tts.alignedWordCount = alignRes.alignedWordCount;
                    slide.tts.alignVersion = ALIGNMENT_VERSION;
                    console.log(`[Render] Slide ${slideIdx}: aligned ${alignRes.words.length} words`);
                }
            } catch (err) {
                console.error(`[Render] Slide ${slideIdx} alignment failed:`, err.message);
                slide.tts.alignError = err.message;
            }
        }

        // Update nDB
        const existing = db.get(projectId);
        if (existing) {
            existing.slides[slideIdx] = slide;
            existing.updatedAt = Date.now();
            db.update(projectId, existing);
        }
        gcAudio();

        res.json({ slideIdx, slide });
    } catch (err) {
        console.error('[Server] Single slide render failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

async function alignSingleSlide(slide, slideIndex) {
    const text = getSpokenText(slide);
    if (!text.trim()) return null;
    if (!slide.tts || !slide.tts.audioRef) return null;

    const audioBuffer = readAudio(slide.tts.audioRef);
    const url = `${getSettings().nvoiceUrl}/align?text=${encodeURIComponent(text)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: audioBuffer,
            signal: controller.signal,
            agent: tlsAgent
        });
        clearTimeout(timeout);

        if (!response.ok) {
            throw new Error(`nVoice alignment failed: HTTP ${response.status}`);
        }

        const data = await response.json();

        if (!Array.isArray(data.segments) || data.segments.length === 0) return null;

        const segments = [];
        const rawWords = [];
        let previousWord = null;
        for (let segmentIndex = 0; segmentIndex < data.segments.length; segmentIndex++) {
            const seg = data.segments[segmentIndex];
            const segment = {
                index: segmentIndex,
                text: seg.text || '',
                startMs: Math.round(seg.start * 1000),
                endMs: Math.round(seg.end * 1000),
                words: []
            };
            if (Array.isArray(seg.words)) {
                for (const w of seg.words) {
                    const word = {
                        word: String(w.word).trim(),
                        startMs: Math.round(w.start * 1000),
                        endMs: Math.round(w.end * 1000),
                        probability: w.probability || 1.0,
                        segmentIndex
                    };
                    if (isImmediateDuplicateWord(previousWord, word)) continue;
                    segment.words.push(word);
                    rawWords.push(word);
                    previousWord = word;
                }
            }
            segments.push(segment);
        }
        if (rawWords.length === 0) return null;

        const durationMs = segments[segments.length - 1].endMs;
        const sourceWordCount = text.split(/\s+/).filter(w => w.length > 0).length;
        const alignedWordCount = rawWords.length;
        const alignComplete = alignedWordCount >= Math.floor(sourceWordCount * 0.85);

        return {
            words: rawWords,
            segments,
            durationMs,
            segmentCount: segments.length,
            sourceWordCount,
            alignedWordCount,
            alignComplete
        };
    } catch (err) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
            throw new Error('nVoice alignment timed out after 60s');
        }
        throw err;
    }
}

async function alignParagraph(paragraph, msgIdx, paraIdx, options = {}) {
    const text = paragraph.text;
    if (!text || !text.trim()) return null;
    if (!paragraph.audioRef || !audioExists(paragraph.audioRef)) return null;

    // Use the same spoken-text normalization as TTS so alignment is asked
    // to match exactly what was synthesized. This must stay in sync with
    // speakText() in pipeline/speak-text.js.
    const spokenText = speakText(text);
    const audioBuffer = readAudio(paragraph.audioRef);
    const url = `${getSettings().nvoiceUrl}/align?text=${encodeURIComponent(spokenText)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    const signal = options.signal;
    if (signal) {
        const onAbort = () => controller.abort();
        signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: audioBuffer,
            signal: controller.signal,
            agent: tlsAgent
        });
        clearTimeout(timeout);

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            console.error(`[v3 Render] msg${msgIdx}/p${paraIdx} nVoice align HTTP ${response.status}: ${body.slice(0, 200)}`);
            throw new Error(`nVoice alignment failed: HTTP ${response.status}`);
        }

        const data = await response.json();
        if (!Array.isArray(data.segments) || data.segments.length === 0) {
            throw new Error('nVoice alignment returned no segments');
        }

        const rawWords = [];
        let previousWord = null;
        for (const seg of data.segments) {
            if (!Array.isArray(seg.words)) continue;
            for (const w of seg.words) {
                const word = {
                    word: String(w.word).trim(),
                    startMs: Math.round(w.start * 1000),
                    endMs: Math.round(w.end * 1000),
                    probability: w.probability || 1.0
                };
                if (isImmediateDuplicateWord(previousWord, word)) continue;
                rawWords.push(word);
                previousWord = word;
            }
        }
        if (rawWords.length === 0) {
            throw new Error('nVoice alignment returned no words');
        }

        const durationMs = rawWords[rawWords.length - 1].endMs;
        const sourceWordCount = spokenText.split(/\s+/).filter(w => w.length > 0).length;
        const alignedWordCount = rawWords.length;
        const alignComplete = alignedWordCount >= Math.floor(sourceWordCount * 0.85);

        return { words: rawWords, durationMs, sourceWordCount, alignedWordCount, alignComplete };
    } catch (err) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
            throw new Error('nVoice alignment timed out after 60s');
        }
        throw err;
    }
}

// ─── Realtime TTS Preview ───────────────────────────────────

app.post('/api/tts-preview', async (req, res) => {
    try {
        const { text, voice, speed } = req.body;
        if (!text) return res.status(400).json({ error: 'Missing text' });

        // Strip *emphasis* markers via the shared speakText() helper so
        // the preview matches what the deck's rendered TTS will say.
        const spokenText = speakText(text);
        const ttsUrl = `${getSettings().nspeechUrl}/tts?` + new URLSearchParams({
            text: spokenText,
            voice_name: voice || 'en-US-Male',
            speed: (speed || 1.0).toString(),
            output_format: 'mp3'
        }).toString();

        const ttsRes = await fetch(ttsUrl);
        if (!ttsRes.ok) {
            return res.status(502).json({ error: `TTS failed: HTTP ${ttsRes.status}` });
        }

        // Stream the response body to the client so MediaSource can
        // start playing immediately. fetch().body is a Web ReadableStream
        // (since Node 18+); we have to read it as chunks and write to
        // the Node response, since .pipe() doesn't exist on Web streams.
        res.setHeader('Content-Type', 'audio/mpeg');
        const reader = ttsRes.body.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!res.write(value)) {
                    await new Promise(r => res.once('drain', r));
                }
            }
        } finally {
            res.end();
        }
    } catch (err) {
        console.error('[Server] TTS preview failed:', err.message);
        if (!res.headersSent) res.status(500).json({ error: err.message });
        else try { res.end(); } catch {}
    }
});

// In development, force-revalidate our own JS/CSS/HTML so edits are picked
// up on the next page load without manually clearing the browser cache.
// NUI library code under /nui/ and rendered audio under /cache/ are
// left to the browser's default caching (they don't change between
// server restarts unless the underlying files change). Audio files are
// content-addressed by render hash, so a stale cache is harmless.
if (process.env.NODE_ENV !== 'production') {
    app.use((req, res, next) => {
        const p = req.path;
        if (p.startsWith('/js/') || p.startsWith('/css/') || p.startsWith('/pages/') || p === '/' || p === '/index.html') {
            res.setHeader('Cache-Control', 'no-store, must-revalidate');
        }
        next();
    });
}

// Serve the static web directory (NUI-based management UI)
app.use(express.static(path.join(__dirname, '../web')));

// Serve the NUI components directly mapping to /nui
app.use('/nui', express.static(path.join(__dirname, '../modules/nui_wc2/NUI')));

// Serve modules (for nui addon imports from web/)
app.use('/modules', express.static(path.join(__dirname, '../modules')));

// Serve render cache audio files
// Serve rendered audio from the nDB file bucket. The URL format
// /audio/:bucket/:id.:ext matches the audioUrl stored on paragraphs
// and slides. The bucket stores files by SHA-256 content hash.
app.get('/audio/:bucket/:id.:ext', (req, res) => {
    try {
        const { bucket, id, ext } = req.params;
        const buffer = db.getFile(bucket, id, ext);
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.send(buffer);
    } catch (err) {
        res.status(404).json({ error: 'Audio not found' });
    }
});

// Serve pipeline output for playback testing
app.use('/pipeline', express.static(path.join(__dirname, '../pipeline')));

// Fallback to index.html for SPA routing (only for non-API, non-asset routes)
app.use((req, res) => {
    const p = req.path;
    // Don't serve index.html for API calls or file assets
    if (p.startsWith('/api/') || p.startsWith('/audio/') || p.startsWith('/cache/') || p.startsWith('/pipeline/') ||
        p.startsWith('/pages/') || p.startsWith('/js/') || p.startsWith('/css/') ||
        p.startsWith('/nui/') || p.startsWith('/modules/') || p === '/config.js') {
        return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(__dirname, '../web/index.html'));
});

app.listen(PORT, () => {
    console.log(`[Server] Slideshow backend running on http://localhost:${PORT}`);
    console.log(`[Server] Serving frontend from: ${path.join(__dirname, '../web')}`);
});
