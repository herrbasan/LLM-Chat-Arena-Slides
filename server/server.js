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

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Global CSP header (replaces meta tag to avoid browser placement warnings)
app.use((req, res, next) => {
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; img-src 'self' data:;"
    );
    next();
});

// Explicit Configuration Validation
const requiredEnvVars = ['PORT', 'LLM_GATEWAY_URL', 'NSPEECH_URL', 'NVOICE_URL', 'NDB_DATA_PATH'];
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

// ─── Render Cache ───────────────────────────────────────────
// Each project gets its own render cache directory.
// Audio files are stored per-slide and keyed by renderHash.
const RENDER_CACHE_ROOT = path.join(dbPath, 'render_cache');
fs.mkdirSync(RENDER_CACHE_ROOT, { recursive: true });

// Per-project render abort controllers so the user can stop a
// long-running Render All operation without restarting the server.
const renderControllers = new Map();

function getProjectCacheDir(projectId) {
    const dir = path.join(RENDER_CACHE_ROOT, projectId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getProjectRenderProgressPath(projectId) {
    return path.join(getProjectCacheDir(projectId), 'render-progress.json');
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

async function renderParagraph(project, msgIdx, paraIdx, cacheDir, nVoiceAvailable) {
    const msg = project.messages[msgIdx];
    const para = msg.paragraphs[paraIdx];
    const role = msg.speaker || 'narrator';
    const voiceConfig = project.voiceMapping?.[role] || project.voiceMapping?.narrator || { voice: 'en-US-Male', speed: 1.0 };
    const renderHash = computeRenderHash(para.text, voiceConfig.voice, voiceConfig.speed);
    const projectId = path.basename(cacheDir);
    const audioFile = `msg_${msgIdx}_p_${paraIdx}_${renderHash}.mp3`;
    const audioPath = path.join(cacheDir, audioFile);
    const audioUrl = `/cache/audio/${projectId}/${audioFile}`;

    // Paragraph is fresh if its stored hash matches current text/voice/speed,
    // the audio file exists, and alignment is at the current version.
    const isFresh = para.renderHash === renderHash
        && para.audioPath
        && fs.existsSync(para.audioPath)
        && para.alignVersion === ALIGNMENT_VERSION
        && para.words?.length > 0;

    if (isFresh) {
        return { rendered: false, aligned: false };
    }

    // Clear stale render data for this paragraph. Old audio file will be
    // overwritten or cleaned up later.
    delete para.audioUrl;
    delete para.audioFile;
    delete para.audioPath;
    delete para.words;
    delete para.durationMs;
    delete para.alignComplete;
    delete para.alignVersion;
    delete para.alignError;
    delete para.ttsError;

    // Generate TTS
    console.log(`[v3 Render] msg${msgIdx}/p${paraIdx}: generating TTS...`);
    const ttsUrl = `${process.env.NSPEECH_URL}/tts?` + new URLSearchParams({
        text: para.text,
        voice_name: voiceConfig.voice,
        speed: (voiceConfig.speed || 1.0).toString(),
        output_format: 'mp3'
    }).toString();

    const ttsRes = await fetch(ttsUrl);
    if (!ttsRes.ok) {
        console.error(`[v3 Render] msg${msgIdx}/p${paraIdx} TTS failed: HTTP ${ttsRes.status}`);
        para.renderHash = renderHash;
        para.ttsError = `TTS HTTP ${ttsRes.status}`;
        return { rendered: false, aligned: false, error: para.ttsError };
    }

    const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
    fs.writeFileSync(audioPath, audioBuffer);

    para.audioFile = audioFile;
    para.audioPath = audioPath;
    para.audioUrl = audioUrl;
    para.renderHash = renderHash;
    para.voice = voiceConfig.voice;
    para.speed = voiceConfig.speed;
    para.byteLength = audioBuffer.length;

    // Align immediately while the audio is fresh.
    let aligned = false;
    if (nVoiceAvailable) {
        try {
            const alignRes = await alignParagraph(para, msgIdx, paraIdx);
            if (alignRes) {
                para.words = alignRes.words;
                para.durationMs = alignRes.durationMs;
                para.alignComplete = alignRes.alignComplete;
                para.alignVersion = ALIGNMENT_VERSION;
                aligned = true;
                console.log(`[v3 Render] msg${msgIdx}/p${paraIdx}: aligned ${alignRes.words.length} words`);
            }
        } catch (err) {
            console.error(`[v3 Render] msg${msgIdx}/p${paraIdx} alignment failed:`, err.message);
            para.alignError = err.message;
        }
    }

    return { rendered: true, aligned };
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
    // Markdown-style *emphasis* markers are spoken by nSpeech as literal
    // "asterisk" tokens. Strip them from the SPOKEN text only; on-screen
    // slide.text keeps the marks. Mirrors stripEmphasisForSpeech in
    // web/js/pages/render.js — keep the two in sync.
    return text ? text.toString().replace(/\*+/g, '') : text;
}

function normalizeAlignedWord(word) {
    return String(word).replace(/[^\w]/g, '').toLowerCase();
}

function isImmediateDuplicateWord(previousWord, word) {
    if (!previousWord) return false;
    if (word.startMs - previousWord.endMs > 250) return false;
    return normalizeAlignedWord(previousWord.word) === normalizeAlignedWord(word.word);
}

function getSlideAudioPath(projectId, slideIndex, renderHash) {
    return path.join(getProjectCacheDir(projectId), `slide_${String(slideIndex).padStart(3, '0')}_${renderHash}.mp3`);
}

function getSlideCacheMeta(projectId) {
    const metaPath = path.join(getProjectCacheDir(projectId), 'cache_meta.json');
    if (fs.existsSync(metaPath)) {
        try {
            return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        } catch { return {}; }
    }
    return {};
}

function setSlideCacheMeta(projectId, meta) {
    const metaPath = path.join(getProjectCacheDir(projectId), 'cache_meta.json');
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
}

// Serve Client Config dynamically to avoid hardcoding frontend
app.get('/js/config.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    const configScript = `
// ============================================
// Dynamically Generated Slideshow Configuration
// ============================================
window.SLIDESHOW_CONFIG = {
    GATEWAY_URL: ${JSON.stringify(process.env.LLM_GATEWAY_URL)},
    NSPEECH_URL: ${JSON.stringify(process.env.NSPEECH_URL)},
    NVOICE_URL: ${JSON.stringify(process.env.NVOICE_URL)},
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

    // v2 projects: merge render cache from deck.json
    const deckPath = path.join(getProjectCacheDir(req.params.id), 'deck.json');
    if (fs.existsSync(deckPath)) {
        const cached = JSON.parse(fs.readFileSync(deckPath, 'utf-8'));
        if (cached.slides && doc.slides) {
            for (let i = 0; i < doc.slides.length; i++) {
                const cacheSlide = cached.slides[i];
                if (!cacheSlide || !cacheSlide.tts) continue;
                if (!doc.slides[i].tts) doc.slides[i].tts = {};
                // Merge alignment data from cache
                if (cacheSlide.tts.words) {
                    doc.slides[i].tts.words = cacheSlide.tts.words;
                }
                if (cacheSlide.tts.segments) {
                    doc.slides[i].tts.segments = cacheSlide.tts.segments;
                }
                if (cacheSlide.tts.durationMs) {
                    doc.slides[i].tts.durationMs = cacheSlide.tts.durationMs;
                }
                if (cacheSlide.tts.alignVersion) {
                    doc.slides[i].tts.alignVersion = cacheSlide.tts.alignVersion;
                }
                if (cacheSlide.tts.alignComplete !== undefined) {
                    doc.slides[i].tts.alignComplete = cacheSlide.tts.alignComplete;
                }
                if (cacheSlide.tts.sourceWordCount) {
                    doc.slides[i].tts.sourceWordCount = cacheSlide.tts.sourceWordCount;
                }
                if (cacheSlide.tts.alignedWordCount) {
                    doc.slides[i].tts.alignedWordCount = cacheSlide.tts.alignedWordCount;
                }
                // Ensure audioUrl is present (may be missing in nDB after import)
                if (cacheSlide.tts.audioUrl && !doc.slides[i].tts.audioUrl) {
                    doc.slides[i].tts.audioUrl = cacheSlide.tts.audioUrl;
                }
            }
        }
    }

    res.json(doc);
});

app.get('/api/voices', async (req, res) => {
    try {
        const response = await fetch(`${process.env.NSPEECH_URL}/voices`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error('[Server] Failed to fetch voices from nSpeech:', err);
        res.status(500).json({ error: err.message });
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
    res.json({ status: 'updated' });
});

app.delete('/api/projects/:id', (req, res) => {
    if (!db) return res.status(500).json({ error: 'Database not initialized' });
    db.delete(req.params.id);
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
            const project = await buildProject(arenaData, null, null, { skipClean: false });
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
        }, { skipClean: false });
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
    const gatewayUrl = process.env.LLM_GATEWAY_URL;
    if (!gatewayUrl) {
        res.status(500).json({ error: 'LLM_GATEWAY_URL is not configured' });
        return;
    }

    // Force stream=true on the wire regardless of what the client
    // sent; the editor's GatewayClient always wants streaming.
    const bodyParams = { ...(req.body || {}), stream: true };
    delete bodyParams.session_id; // server assigns its own
    const url = `${gatewayUrl.replace(/\/+$/, '')}/v1/chat/completions`;

    const headers = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
    if (process.env.LLM_GATEWAY_API_KEY) {
        headers['Authorization'] = `Bearer ${process.env.LLM_GATEWAY_API_KEY}`;
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

        // Always start fresh — delete any cached audio from previous
        // renders. The cleaning prompt and TTS config change too often
        // during development for stale-cache logic to be worth the bugs.
        const cacheDir = getProjectCacheDir(projectId);
        if (fs.existsSync(cacheDir)) {
            fs.rmSync(cacheDir, { recursive: true, force: true });
        }
        fs.mkdirSync(cacheDir, { recursive: true });
        const cacheMeta = {};
        let reRendered = 0;
        let cached = 0; // always 0 now — cache is cleared above, but keep for log lines

        // Load existing render cache to preserve alignment data for cache-hit slides
        const deckPath = path.join(cacheDir, 'deck.json');
        let prevDeck = null;
        if (fs.existsSync(deckPath)) {
            try { prevDeck = JSON.parse(fs.readFileSync(deckPath, 'utf-8')); } catch {}
        }

        for (let i = 0; i < deck.slides.length; i++) {
            const slide = deck.slides[i];
            const text = getSpokenText(slide);
            const role = slide.speaker || 'narrator';
            const voiceConfig = deck.voiceMapping[role] || deck.voiceMapping.narrator || { voice: 'en-US-Male', speed: 1.0 };
            const renderHash = computeRenderHash(text, voiceConfig.voice, voiceConfig.speed);

            const cachedHash = cacheMeta[i];
            const audioPath = getSlideAudioPath(projectId, i, renderHash);
            const audioUrl = `/cache/audio/${projectId}/slide_${String(i).padStart(3, '0')}_${renderHash}.mp3`;

            if (cachedHash === renderHash && fs.existsSync(audioPath)) {
                // Cache hit — reuse existing audio, preserve alignment data from previous render
                const prevSlide = prevDeck?.slides?.[i];
                const prevTts = prevSlide?.tts;
                slide.tts = {
                    audioFile: path.basename(audioPath),
                    audioPath: audioPath,
                    audioUrl: audioUrl,
                    voice: voiceConfig.voice,
                    speed: voiceConfig.speed,
                    renderHash: renderHash,
                    cached: true,
                    // Preserve alignment data if the text hasn't changed
                    ...(prevTts?.renderHash === renderHash && prevTts.alignVersion === ALIGNMENT_VERSION && prevTts.words ? {
                        words: prevTts.words,
                        segments: prevTts.segments,
                        durationMs: prevTts.durationMs,
                        alignComplete: prevTts.alignComplete,
                        sourceWordCount: prevTts.sourceWordCount,
                        alignedWordCount: prevTts.alignedWordCount,
                        alignVersion: prevTts.alignVersion,
                    } : {})
                };
                cached++;
                continue;
            }

            // Cache miss — generate TTS
            console.log(`[Render] Slide ${i}: cache miss, generating TTS...`);
            const ttsUrl = `${process.env.NSPEECH_URL}/tts?` + new URLSearchParams({
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
            fs.writeFileSync(audioPath, audioBuffer);

            slide.tts = {
                audioFile: path.basename(audioPath),
                audioPath: audioPath,
                audioUrl: audioUrl,
                voice: voiceConfig.voice,
                speed: voiceConfig.speed,
                byteLength: audioBuffer.length,
                renderHash
            };

            cacheMeta[i] = renderHash;
            reRendered++;
        }

        setSlideCacheMeta(projectId, cacheMeta);

        // Save deck before alignment (so we have a checkpoint)
        fs.writeFileSync(deckPath, JSON.stringify(deck, null, 2), 'utf-8');

        // Ensure audioPath is set for all slides (client may only send audioUrl)
        for (let i = 0; i < deck.slides.length; i++) {
            const slide = deck.slides[i];
            if (slide.tts && slide.tts.audioUrl && !slide.tts.audioPath) {
                const audioFile = path.basename(slide.tts.audioUrl);
                slide.tts.audioPath = path.join(RENDER_CACHE_ROOT, projectId, audioFile);
            }
        }

        // Quick nVoice health check before attempting alignment
        let nVoiceAvailable = false;
        try {
            const nvRes = await fetch(process.env.NVOICE_URL, { signal: AbortSignal.timeout(3000), agent: tlsAgent });
            nVoiceAvailable = nvRes.ok;
        } catch { /* nVoice not available */ }

        if (nVoiceAvailable) {
            console.log(`[Render] ${reRendered} generated, ${cached} cached. Running alignment...`);
            let alignAttempted = 0;
            // Align all slides that have audio but no word timing data
            for (let i = 0; i < deck.slides.length; i++) {
                const slide = deck.slides[i];
                const hasTTS = !!slide.tts;
                const hasError = slide.tts?.error;
                const hasAudioPath = slide.tts?.audioPath;
                const audioExists = hasAudioPath ? fs.existsSync(slide.tts.audioPath) : false;
                const hasWords = slide.tts?.words?.length > 0;
                console.log(`[Render] Slide ${i}: hasTTS=${hasTTS} hasError=${!!hasError} audioPath=${hasAudioPath} audioExists=${audioExists} hasWords=${hasWords}`);
                if (!slide.tts || slide.tts.error || !slide.tts.audioPath) continue;
                if (!fs.existsSync(slide.tts.audioPath)) continue;
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

        // Save updated deck with alignment data to render cache
        fs.writeFileSync(deckPath, JSON.stringify(deck, null, 2), 'utf-8');

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
        const project = req.body;
        if (!project || !project.messages || !Array.isArray(project.messages)) {
            return res.status(400).json({ error: 'Invalid v3 project: missing messages array' });
        }
        if (project.version !== 3) {
            return res.status(400).json({ error: `Expected version 3, got ${project.version}` });
        }

        const controller = new AbortController();
        renderControllers.set(projectId, controller);

        const cacheDir = getProjectCacheDir(projectId);
        const projectPath = path.join(cacheDir, 'project_v3.json');
        fs.mkdirSync(cacheDir, { recursive: true });

        const targets = req.body.targets;
        const totalParagraphs = project.messages.reduce((sum, m) => sum + m.paragraphs.length, 0);

        // Check nVoice availability once up front.
        let nVoiceAvailable = false;
        try {
            const nvRes = await fetch(process.env.NVOICE_URL, { signal: AbortSignal.timeout(3000), agent: tlsAgent });
            nVoiceAvailable = nvRes.ok;
        } catch {}

        let processedCount = 0;
        let renderedCount = 0;
        let alignSucceeded = 0;
        let stopped = false;

        writeRenderProgress(projectId, 'render', 'Starting render...', 0);

        for (let msgIdx = 0; msgIdx < project.messages.length && !controller.signal.aborted; msgIdx++) {
            const msg = project.messages[msgIdx];

            for (let paraIdx = 0; paraIdx < msg.paragraphs.length && !controller.signal.aborted; paraIdx++) {
                const para = msg.paragraphs[paraIdx];
                if (!para.text || para.text.trim() === '' || para.text.trim() === '...') continue;

                // If targets are specified, skip paragraphs not in the target list.
                if (targets && !targets.some(t => t.msgIdx === msgIdx && t.paraIdx === paraIdx)) {
                    continue;
                }

                processedCount++;
                const result = await renderParagraph(project, msgIdx, paraIdx, cacheDir, nVoiceAvailable);
                if (result.rendered) renderedCount++;
                if (result.aligned) alignSucceeded++;

                if (controller.signal.aborted) {
                    stopped = true;
                    break;
                }

                if (processedCount % 5 === 0 || processedCount === totalParagraphs) {
                    const pct = Math.min(99, Math.floor((processedCount / totalParagraphs) * 100));
                    writeRenderProgress(projectId, 'render', `Paragraph ${processedCount}/${totalParagraphs}`, pct);
                }

                // Persist intermediate state so the UI can refresh status dots.
                if (processedCount % 10 === 0) {
                    fs.writeFileSync(projectPath, JSON.stringify(project, null, 2), 'utf-8');
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
        }

        // Garbage-collect orphaned audio files: any file whose hash no longer
        // matches a current paragraph's render hash is deleted.
        const validHashes = new Set();
        for (let msgIdx = 0; msgIdx < project.messages.length; msgIdx++) {
            const msg = project.messages[msgIdx];
            const role = msg.speaker || 'narrator';
            const voiceConfig = project.voiceMapping?.[role] || project.voiceMapping?.narrator || { voice: 'en-US-Male', speed: 1.0 };
            for (let paraIdx = 0; paraIdx < msg.paragraphs.length; paraIdx++) {
                const para = msg.paragraphs[paraIdx];
                if (!para.text || para.text.trim() === '' || para.text.trim() === '...') continue;
                validHashes.add(computeRenderHash(para.text, voiceConfig.voice, voiceConfig.speed));
            }
        }
        if (fs.existsSync(cacheDir)) {
            for (const file of fs.readdirSync(cacheDir)) {
                if (!file.endsWith('.mp3')) continue;
                const hashMatch = file.match(/_([a-f0-9]{16})\.mp3$/);
                if (hashMatch && !validHashes.has(hashMatch[1])) {
                    fs.unlinkSync(path.join(cacheDir, file));
                }
            }
        }

        // Save final state with alignment data
        fs.writeFileSync(projectPath, JSON.stringify(project, null, 2), 'utf-8');

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

        renderControllers.delete(projectId);

        if (stopped) {
            console.log(`[v3 Render] Stopped for ${projectId}: ${renderedCount} re-rendered, ${alignSucceeded} aligned, ${processedCount} processed`);
            writeRenderProgress(projectId, 'stopped', `Render stopped: ${renderedCount} re-rendered, ${alignSucceeded} aligned`, 0);
            return res.json({ stopped: true, project, renderedCount, alignSucceeded, processedCount });
        }

        console.log(`[v3 Render] Complete for ${projectId}: ${renderedCount} re-rendered, ${alignSucceeded} aligned, ${processedCount} processed`);
        writeRenderProgress(projectId, 'done', `Render complete: ${renderedCount} re-rendered, ${alignSucceeded} aligned`, 100);
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

        const cacheDir = getProjectCacheDir(projectId);
        const projectPath = path.join(cacheDir, 'project_v3.json');

        let nVoiceAvailable = false;
        try {
            const nvRes = await fetch(process.env.NVOICE_URL, { signal: AbortSignal.timeout(3000), agent: tlsAgent });
            nVoiceAvailable = nvRes.ok;
        } catch {}

        let renderedCount = 0;
        let alignSucceeded = 0;

        for (let paraIdx = 0; paraIdx < msg.paragraphs.length; paraIdx++) {
            const para = msg.paragraphs[paraIdx];
            if (!para.text || para.text.trim() === '' || para.text.trim() === '...') continue;

            const result = await renderParagraph(doc, msgIdx, paraIdx, cacheDir, nVoiceAvailable);
            if (result.rendered) renderedCount++;
            if (result.aligned) alignSucceeded++;
        }

        fs.writeFileSync(projectPath, JSON.stringify(doc, null, 2), 'utf-8');
        db.update(projectId, { ...doc, updatedAt: Date.now() });

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

        const cacheDir = getProjectCacheDir(projectId);
        const role = msg.speaker || 'narrator';
        const voiceConfig = doc.voiceMapping?.[role] || doc.voiceMapping?.narrator || { voice: 'en-US-Male', speed: 1.0 };
        const renderHash = computeRenderHash(para.text, voiceConfig.voice, voiceConfig.speed);
        const audioFile = `msg_${mi}_p_${pi}_${renderHash}.mp3`;
        const audioPath = path.join(cacheDir, audioFile);
        const audioUrl = `/cache/audio/${projectId}/${audioFile}`;

        // Generate TTS
        console.log(`[v3 Render] Re-rendering msg${mi}/p${pi}...`);
        const ttsUrl = `${process.env.NSPEECH_URL}/tts?` + new URLSearchParams({
            text: para.text,
            voice_name: voiceConfig.voice,
            speed: (voiceConfig.speed || 1.0).toString(),
            output_format: 'mp3'
        }).toString();

        const ttsRes = await fetch(ttsUrl);
        if (!ttsRes.ok) {
            return res.status(502).json({ error: `TTS failed: HTTP ${ttsRes.status}` });
        }

        const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
        fs.writeFileSync(audioPath, audioBuffer);

        para.audioFile = audioFile;
        para.audioPath = audioPath;
        para.audioUrl = audioUrl;
        para.renderHash = renderHash;
        para.voice = voiceConfig.voice;
        para.speed = voiceConfig.speed;
        para.byteLength = audioBuffer.length;

        // Clear old alignment data
        delete para.words;
        delete para.durationMs;
        delete para.alignComplete;
        delete para.alignVersion;
        delete para.alignError;

        // Run alignment
        let nVoiceAvailable = false;
        try {
            const nvRes = await fetch(process.env.NVOICE_URL, { signal: AbortSignal.timeout(3000), agent: tlsAgent });
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

        // Save updated project
        const projectPath = path.join(cacheDir, 'project_v3.json');
        fs.writeFileSync(projectPath, JSON.stringify(doc, null, 2), 'utf-8');

        // Update nDB
        db.update(projectId, {
            ...doc,
            updatedAt: Date.now()
        });

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

        const cacheMeta = getSlideCacheMeta(projectId);
        const cacheDir = getProjectCacheDir(projectId);
        const audioPath = getSlideAudioPath(projectId, slideIdx, renderHash);
        const audioUrl = `/cache/audio/${projectId}/slide_${String(slideIdx).padStart(3, '0')}_${renderHash}.mp3`;
        const deckPath = path.join(cacheDir, 'deck.json');

        // Load existing cache for alignment preservation
        let existingSlide = null;
        if (fs.existsSync(deckPath)) {
            try {
                const cached = JSON.parse(fs.readFileSync(deckPath, 'utf-8'));
                existingSlide = cached.slides?.[slideIdx];
            } catch {}
        }

        // Check audio cache hit (reuse existing TTS audio if hash matches)
        const audioCached = cacheMeta[slideIdx] === renderHash && fs.existsSync(audioPath);

        if (!audioCached) {
            // Generate TTS
            console.log(`[Render] Slide ${slideIdx}: generating TTS...`);
            const ttsUrl = `${process.env.NSPEECH_URL}/tts?` + new URLSearchParams({
                text, voice_name: voiceConfig.voice, speed: voiceConfig.speed.toString(), output_format: 'mp3'
            }).toString();

            const ttsRes = await fetch(ttsUrl);
            if (!ttsRes.ok) {
                slide.tts = { error: `TTS HTTP ${ttsRes.status}`, renderHash };
                return res.json({ slideIdx, slide, error: slide.tts.error });
            }

            const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
            fs.writeFileSync(audioPath, audioBuffer);

            slide.tts = {
                audioFile: path.basename(audioPath),
                audioPath,
                audioUrl,
                voice: voiceConfig.voice,
                speed: voiceConfig.speed,
                byteLength: audioBuffer.length,
                renderHash
            };

            cacheMeta[slideIdx] = renderHash;
            setSlideCacheMeta(projectId, cacheMeta);
        } else {
            // Audio cache hit — reuse, but check for alignment data
            slide.tts = {
                audioFile: path.basename(audioPath),
                audioPath,
                audioUrl,
                voice: voiceConfig.voice,
                speed: voiceConfig.speed,
                renderHash,
                cached: true,
                ...(existingSlide?.tts?.renderHash === renderHash && existingSlide.tts.alignVersion === ALIGNMENT_VERSION && existingSlide.tts.words ? {
                    words: existingSlide.tts.words,
                    segments: existingSlide.tts.segments,
                    durationMs: existingSlide.tts.durationMs,
                    alignComplete: existingSlide.tts.alignComplete,
                    sourceWordCount: existingSlide.tts.sourceWordCount,
                    alignedWordCount: existingSlide.tts.alignedWordCount,
                    alignVersion: existingSlide.tts.alignVersion,
                } : {})
            };
        }

        // Save deck checkpoint
        if (!fs.existsSync(deckPath)) {
            fs.writeFileSync(deckPath, JSON.stringify({ slides: [] }, null, 2), 'utf-8');
        }
        const cachedDeck = JSON.parse(fs.readFileSync(deckPath, 'utf-8'));
        if (!cachedDeck.slides) cachedDeck.slides = [];
        cachedDeck.slides[slideIdx] = structuredClone(slide);
        fs.writeFileSync(deckPath, JSON.stringify(cachedDeck, null, 2), 'utf-8');

        // Run alignment (always, unless words are already present and fresh)
        const needsAlignment = slide.tts.alignVersion !== ALIGNMENT_VERSION || !slide.tts.words || slide.tts.words.length === 0;

        let nVoiceAvailable = false;
        try {
            const nvRes = await fetch(process.env.NVOICE_URL, { signal: AbortSignal.timeout(3000), agent: tlsAgent });
            nVoiceAvailable = nvRes.ok;
        } catch {}

        if (needsAlignment && nVoiceAvailable && slide.tts.audioPath && fs.existsSync(slide.tts.audioPath)) {
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

        // Save final deck to cache
        const finalDeck = JSON.parse(fs.readFileSync(deckPath, 'utf-8'));
        finalDeck.slides[slideIdx] = structuredClone(slide);
        fs.writeFileSync(deckPath, JSON.stringify(finalDeck, null, 2), 'utf-8');

        // Update nDB
        const existing = db.get(projectId);
        if (existing) {
            existing.slides[slideIdx] = slide;
            existing.updatedAt = Date.now();
            db.update(projectId, existing);
        }

        res.json({ slideIdx, slide });
    } catch (err) {
        console.error('[Server] Single slide render failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

async function alignSingleSlide(slide, slideIndex) {
    const text = getSpokenText(slide);
    if (!text.trim()) return null;
    if (!slide.tts || !slide.tts.audioPath) return null;

    const audioBuffer = fs.readFileSync(slide.tts.audioPath);
    const url = `${process.env.NVOICE_URL}/align?text=${encodeURIComponent(text)}`;

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

async function alignParagraph(paragraph, msgIdx, paraIdx) {
    const text = paragraph.text;
    if (!text || !text.trim()) return null;
    if (!paragraph.audioPath || !fs.existsSync(paragraph.audioPath)) return null;

    // Strip *emphasis* markers for alignment
    const spokenText = text.replace(/\*([^*]+)\*/g, '$1');
    const audioBuffer = fs.readFileSync(paragraph.audioPath);
    const url = `${process.env.NVOICE_URL}/align?text=${encodeURIComponent(spokenText)}`;

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
        if (rawWords.length === 0) return null;

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

        // Strip *emphasis* markers from the preview text so what the
        // user hears matches what the deck's rendered TTS will say.
        // Same rule as getSpokenText in the per-slide render path.
        const spokenText = String(text).replace(/\*+/g, '');

        const ttsUrl = `${process.env.NSPEECH_URL}/tts?` + new URLSearchParams({
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
app.use('/cache/audio', express.static(RENDER_CACHE_ROOT));

// Serve pipeline output for playback testing
app.use('/pipeline', express.static(path.join(__dirname, '../pipeline')));

// Fallback to index.html for SPA routing (only for non-API, non-asset routes)
app.use((req, res) => {
    const p = req.path;
    // Don't serve index.html for API calls or file assets
    if (p.startsWith('/api/') || p.startsWith('/cache/') || p.startsWith('/pipeline/') ||
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
