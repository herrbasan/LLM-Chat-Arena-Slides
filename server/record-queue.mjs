#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Queue runner for OBS-capture recording runs.
//
// Orchestrates three actors, none of which it owns the internals of:
//   1. the app server's /api/record/* session (queue, door gate, progress)
//   2. a kiosk Chrome that plays decks autonomously (recording=1 in URL)
//   3. OBS via obs-websocket 5 (StartRecord / StopRecord / events)
//
// Per deck: page paints → POST ready → runner StartRecord → OBS STARTED
// event → 1s pre-roll → door open → page plays → progress heartbeats →
// page's last word + 2s post-roll → POST done → runner StopRecord →
// STOPPED event (outputPath) → file finalized into RECORD_DIR → advance.
//
// Watchdogs: ready timeout, heartbeat timeout, stop timeout, OBS death,
// browser death → deck retried (MAX_ATTEMPTS), then skipped. Every event
// lands in the run log (JSONL) next to the recordings.
//
// Usage:  node record-queue.mjs [--only <id>[,<id>...]]
// Env (server/.env): OBS_WS_PASSWORD (required), OBS_WS_URL, APP_URL,
//                    OBS_PATH, CHROME_PATH, RECORD_DIR, RECORD_WIDTH,
//                    RECORD_HEIGHT
// ─────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// .env then .env.local — same precedence the server uses.
dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.join(__dirname, '.env.local'), override: true });

// ── Config ──
const APP_URL = process.env.APP_URL ?? 'http://localhost:3600';
const OBS_WS_URL = process.env.OBS_WS_URL ?? 'ws://127.0.0.1:4455';
const OBS_WS_PASSWORD = process.env.OBS_WS_PASSWORD;
const RECORD_DIR = path.resolve(__dirname, process.env.RECORD_DIR ?? '../captures');
// The kiosk profile stays LOCAL even when RECORD_DIR is a network share —
// a Chrome profile is chatty small-file IO with exclusive locks, which
// belongs on a local disk. Recordings/logs are the only things that go
// to RECORD_DIR.
const CHROME_PROFILE_DIR = path.resolve(__dirname, '../captures/chrome-profile');
const RECORD_WIDTH = process.env.RECORD_WIDTH ?? '3840';
const RECORD_HEIGHT = process.env.RECORD_HEIGHT ?? '2160';

// Tuning (ms / attempts) — generous because overnight runs must not
// abort on one slow paint or a hiccup.
const POLL_MS = 1000;
const PREROLL_MS = 1000;          // runner-side: OBS STARTED → door open
const READY_TIMEOUT_MS = 120_000;  // current deck never posted ready
const HEARTBEAT_TIMEOUT_MS = 30_000; // page went silent mid-deck
const STOP_TIMEOUT_MS = 60_000;   // StopRecord without STOPPED event
const OBS_START_TIMEOUT_MS = 15_000; // StartRecord without STARTED event
const MAX_ATTEMPTS = 2;           // retries per deck after the first try

if (!OBS_WS_PASSWORD) {
    console.error('[runner] OBS_WS_PASSWORD is not set — enable obs-websocket in OBS (Tools > WebSocket Server Settings), set a password, and put it in server/.env');
    process.exit(1);
}

// ── Run log (JSONL next to the recordings) ──
fs.mkdirSync(RECORD_DIR, { recursive: true });
const runId = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 17);
const logPath = path.join(RECORD_DIR, `run-${runId}.jsonl`);
const log = (ev) => {
    const line = JSON.stringify({ t: new Date().toISOString(), ...ev });
    fs.appendFileSync(logPath, line + '\n');
    const human = ev.deck ? ` [${ev.deck}]` : '';
    console.log(`[runner${human}] ${ev.msg ?? ev.event ?? ''}${ev.detail ? ` — ${ev.detail}` : ''}`);
};

// ── HTTP helpers ──
const api = async (p, opts) => {
    const res = await fetch(APP_URL + p, opts);
    if (!res.ok) throw new Error(`${p} → HTTP ${res.status}: ${await res.text()}`);
    return res.json();
};
const post = (p, body) => api(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

// ── obs-websocket 5 client (Node-native WebSocket) ──
function obsConnect() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(OBS_WS_URL);
        const pending = new Map();
        let reqId = 0;
        const waiters = { started: [], stopped: [] };
        const client = {
            ws,
            request(requestType, requestData) {
                const id = `r${++reqId}`;
                return new Promise((res, rej) => {
                    pending.set(id, { res, rej, requestType });
                    setTimeout(() => {
                        if (pending.delete(id)) rej(new Error(`OBS request ${requestType} timed out`));
                    }, 10_000);
                    ws.send(JSON.stringify({ op: 6, d: { requestType, requestId: id, requestData: requestData ?? {} } }));
                });
            },
            onStarted(fn) { waiters.started.push(fn); },
            onStopped(fn) { waiters.stopped.push(fn); },
        };
        const dead = { onExit: null };
        client.onExit = (fn) => { dead.onExit = fn; };

        ws.addEventListener('message', (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.op === 0) { // Hello → Identify
                const d = { rpcVersion: 1, eventSubscriptions: 1 | 64 }; // General | Outputs
                if (msg.d.authentication) {
                    const { challenge, salt } = msg.d.authentication;
                    const sha256b64 = (s) => createHash('sha256').update(s).digest('base64');
                    d.authentication = sha256b64(sha256b64(OBS_WS_PASSWORD + salt) + challenge);
                }
                ws.send(JSON.stringify({ op: 1, d }));
            } else if (msg.op === 2) { // Identified
                resolve(client);
            } else if (msg.op === 5) { // Event
                const { eventType, eventData } = msg.d;
                if (eventType === 'RecordStateChanged') {
                    if (eventData.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') waiters.started.forEach(fn => fn(eventData));
                    if (eventData.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') waiters.stopped.forEach(fn => fn(eventData));
                }
                if (eventType === 'ExitStarted' && dead.onExit) dead.onExit();
            } else if (msg.op === 7) { // RequestResponse
                const p = pending.get(msg.d.requestId);
                if (!p) return;
                pending.delete(msg.d.requestId);
                if (msg.d.requestStatus.result) p.res(msg.d.responseData ?? {});
                else p.rej(new Error(`OBS ${p.requestType} failed: ${msg.d.requestStatus.code} ${msg.d.requestStatus.comment ?? ''}`));
            }
        });
        ws.addEventListener('close', () => {
            if (dead.onExit) dead.onExit();
            reject(new Error('obs-websocket connection closed before identification'));
        });
        ws.addEventListener('error', () => reject(new Error(`cannot reach OBS websocket at ${OBS_WS_URL}`)));
    });
}

// ── Process management ──
const findExe = (envVar, candidates) => {
    if (process.env[envVar]) {
        if (!fs.existsSync(process.env[envVar])) throw new Error(`${envVar}=${process.env[envVar]} does not exist`);
        return process.env[envVar];
    }
    for (const c of candidates) if (fs.existsSync(c)) return c;
    throw new Error(`could not find executable — set ${envVar} in server/.env. Tried: ${candidates.join(', ')}`);
};

let chromeProc = null;
function launchChrome() {
    const exe = findExe('CHROME_PATH', [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
    ]);
    const profileDir = CHROME_PROFILE_DIR;
    const url = `${APP_URL}/#page=render&recording=1`;
    chromeProc = spawn(exe, [
        // F11-style fullscreen, not kiosk: normal window semantics (the
        // exact-title binding is unaffected — title stays
        // "Arena Slideshow - Google Chrome"). F11 toggles it back out.
        '--start-fullscreen',
        `--window-position=0,0`,
        `--window-size=${RECORD_WIDTH},${RECORD_HEIGHT}`,
        '--autoplay-policy=no-user-gesture-required',
        '--no-first-run', '--no-default-browser-check',
        '--disable-session-crashed-bubble', '--hide-crash-restore-bubble',
        `--user-data-dir=${profileDir}`,
        url,
    ], { stdio: 'ignore' });
    chromeProc.on('exit', (code) => log({ event: 'chrome-exit', code }));
    log({ event: 'chrome-launched', detail: url });
}
const killChrome = () => {
    if (chromeProc && chromeProc.exitCode === null) {
        try { chromeProc.kill(); } catch { /* already gone */ }
    }
};

let obsProc = null;
let obsOwned = false;
async function ensureObs() {
    // Already running? Attach to it. The returned client is the single
    // connection used for the whole run — no probe leaks.
    try {
        const c = await obsConnect();
        log({ event: 'obs-attached', detail: 'already running (not owned — OBS death aborts the run)' });
        return c;
    } catch { /* not up — launch it */ }
    const exe = findExe('OBS_PATH', [
        'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
        'C:\\Program Files (x86)\\obs-studio\\bin\\64bit\\obs64.exe',
    ]);
    obsProc = spawn(exe, ['--disable-shutdown-check', '--minimize-to-tray'], { cwd: path.dirname(exe), stdio: 'ignore' });
    obsOwned = true;
    obsProc.on('exit', (code) => log({ event: 'obs-exit', code }));
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        try { const c = await obsConnect(); log({ event: 'obs-launched' }); return c; }
        catch { await sleep(2000); }
    }
    throw new Error('OBS was launched but its websocket never came up within 60s');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, timeoutMs, what) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fn()) return;
        await sleep(100);
    }
    throw new Error(`timeout waiting for ${what}`);
};

// ── File finalization ──
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
function finalizeRecording(srcPath, nn, slug, attempt) {
    fs.mkdirSync(RECORD_DIR, { recursive: true });
    // Extension follows whatever OBS produced (mp4 / hybrid mp4 / mkv) —
    // the container is OBS's choice, the runner just names the file.
    const ext = path.extname(srcPath) || '.mkv';
    let target = path.join(RECORD_DIR, `${String(nn).padStart(2, '0')}-${slug}${ext}`);
    if (attempt > 1) target = target.replace(ext, `-attempt${attempt}${ext}`);
    if (fs.existsSync(target)) target = target.replace('.mkv', `-${Date.now()}.mkv`);
    try {
        fs.renameSync(srcPath, target);
    } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        fs.copyFileSync(srcPath, target); // cross-volume: copy then drop the original
        fs.unlinkSync(srcPath);
    }
    const mb = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
    log({ event: 'file-finalized', detail: `${target} (${mb} MB)` });
    return target;
}

// Force the Window Capture source to re-acquire now that the capture
// window exists. Attaching to an OBS that has been running with its source
// unbound (e.g. left over from an aborted run) otherwise records the wrong
// window until the source happens to rebind mid-capture (2026-10-06:
// exactly that — file started wrong, then corrected). Re-applying the
// input's own settings re-runs its window matching immediately.
async function rebindWindowCapture(obs) {
    try {
        const { sceneName } = await obs.request('GetCurrentProgramScene');
        const { sceneItems } = await obs.request('GetSceneItemList', { sceneName });
        const cap = sceneItems.find(it => (it.inputKind || '').includes('window_capture'));
        if (!cap) {
            log({ event: 'capture-rebind', detail: `no window_capture input in scene "${sceneName}" — check OBS setup` });
            return;
        }
        const { inputSettings } = await obs.request('GetInputSettings', { inputName: cap.sourceName });
        await obs.request('SetInputSettings', { inputName: cap.sourceName, inputSettings, overlay: false });
        await sleep(1500);
        log({ event: 'capture-rebind', detail: `${cap.sourceName} settings re-applied — forced re-acquire` });
    } catch (err) {
        log({ event: 'capture-rebind', detail: `failed: ${err.message}` });
    }
}

// ── Main ──
const onlyArg = process.argv.find(a => a.startsWith('--only'));
const onlyIds = onlyArg ? onlyArg.split('=')[1]?.split(',') ?? process.argv[process.argv.indexOf(onlyArg) + 1]?.split(',') : null;
// Test mode: cut the capture after this many ms and finalize through the
// normal path (StopRecord → STOPPED event → rename → advance). Exercises
// the whole pipeline without playing a full deck.
const stopAfterArg = process.argv.find(a => a.startsWith('--stop-after='));
const stopAfterMs = stopAfterArg ? parseInt(stopAfterArg.split('=')[1], 10) : null;
if (stopAfterMs !== null && (!Number.isFinite(stopAfterMs) || stopAfterMs < 10_000)) {
    console.error('[runner] --stop-after must be >= 10000 (ms)');
    process.exit(1);
}
// File numbering: the video series in RECORD_DIR is continuous across
// batches (batch 2 continues at 06 after batch 1's 01-05). Default starts
// at 01; pass --start-num=9 for the next batch. No auto-detection — the
// human owns the series order, the runner just needs the starting point.
const startNumArg = process.argv.find(a => a.startsWith('--start-num='));
const startNum = startNumArg ? parseInt(startNumArg.split('=')[1], 10) : 1;
if (!Number.isFinite(startNum) || startNum < 1 || startNum > 99) {
    console.error('[runner] --start-num must be 1..99');
    process.exit(1);
}

// 1. Server must be up.
let projects;
try {
    projects = (await api('/api/projects')).projects;
} catch (err) {
    console.error(`[runner] app server unreachable at ${APP_URL} — start it first (node server.js from server/): ${err.message}`);
    process.exit(1);
}

// 2. Deck queue: as the projects API orders them (date desc). Recording
// order is cosmetic — each file is named by queue position regardless.
let decks = projects
    .filter(p => onlyIds ? onlyIds.includes(p._id) : true)
    .map(p => ({ id: p._id, title: p.source?.topic ?? 'Untitled', slug: slugify(p.source?.topic ?? 'untitled') }));
if (decks.length === 0) {
    console.error('[runner] no decks selected — check --only ids against GET /api/projects');
    process.exit(1);
}
log({ event: 'run-start', detail: `${decks.length} decks → ${RECORD_DIR}`, decks });

// 3. Register the session, start Chrome + OBS — kiosk FIRST. The Window
// Capture source binds at OBS startup; if OBS starts before the kiosk
// window exists, the source initializes unbound and records black
// (2026-10-06, exactly that failure). The window must exist first.
await post('/api/record/reset', {});
await post('/api/record/queue', { decks });
launchChrome();
await sleep(3000); // window creation + first paint before OBS binds
const obs = await ensureObs();
await rebindWindowCapture(obs);

let obsRecording = false;
let lastStopOutputPath = null;
let runAborted = false;
obs.onStarted(() => { obsRecording = true; });
obs.onStopped((ev) => { obsRecording = false; lastStopOutputPath = ev.outputPath; });
obs.onExit(async () => {
    runAborted = true;
    log({ event: 'obs-dead', msg: 'OBS exited or websocket dropped — aborting run' });
});

// Supervision state
let phase = 'idle';            // idle | starting | recording | stopping
let currentDeckSince = 0;      // when the current deck became current
let recordingDeckIdx = -1;     // queue idx currently being captured
let recordingStartedAt = 0;
let attempt = 1;
let lastLoggedDeck = -1;
const attemptsByDeck = new Map();
let statsSince = 0;

const failDeck = async (reason) => {
    // The deck being captured if we got that far, else the deck on deck.
    const idx = phase === 'idle' ? currentIdxFromState : recordingDeckIdx;
    const deck = decks[Math.min(Math.max(idx, 0), decks.length - 1)];
    log({ event: 'fault', deck: deck.slug, detail: reason });
    // Best-effort clean stop — a partial file may exist; it is left in
    // OBS's own recording directory for inspection but never counted.
    if (obsRecording) {
        try { await obs.request('StopRecord'); await waitFor(() => !obsRecording, 10_000, 'StopRecord after fault'); } catch { /* logged above */ }
    }
    // Clear the per-deck signals so the relaunched page gets a clean
    // start (a stale readyAt would start the next capture against a corpse).
    await post('/api/record/fault', {}).catch(() => {});
    killChrome();
    const tries = (attemptsByDeck.get(deck.id) ?? 0) + 1;
    attemptsByDeck.set(deck.id, tries);
    if (tries > MAX_ATTEMPTS) {
        log({ event: 'deck-skipped', deck: deck.slug, detail: `${tries - 1} failed attempts` });
        await post('/api/record/advance', {}).catch(() => {});
        phase = 'idle';
    } else {
        log({ event: 'deck-retry', deck: deck.slug, detail: `attempt ${tries + 1}` });
        phase = 'idle'; // door closed; the relaunched page restarts the deck
    }
    // Give the dead chrome a moment before relaunch.
    await sleep(2000);
    if (!runAborted) launchChrome();
};

let currentIdxFromState = 0;

// SIGINT must be registered BEFORE the supervision loop — Ctrl+C during a
// run stops the capture cleanly instead of orphaning OBS recording.
process.on('SIGINT', async () => {
    runAborted = true;
    log({ event: 'sigint', msg: 'interrupted — stopping capture cleanly' });
    if (obsRecording) {
        try { await obs.request('StopRecord'); await waitFor(() => !obsRecording, 8000, 'StopRecord on SIGINT'); } catch { /* best effort */ }
    }
    await post('/api/record/door', { open: false }).catch(() => {});
    killChrome();
    if (obsOwned && obsProc && obsProc.exitCode === null) { try { obsProc.kill(); } catch { } }
    log({ event: 'run-end', detail: 'interrupted by user' });
    process.exit(130);
});

log({ event: 'supervising' });
while (!runAborted) {
    let st;
    try {
        st = await api('/api/record/state');
    } catch (err) {
        log({ event: 'server-unreachable', detail: err.message });
        await sleep(3000);
        continue;
    }
    currentIdxFromState = st.idx;

    if (st.finishedAt && phase === 'idle') {
        log({ event: 'run-complete', detail: `${decks.length} decks processed` });
        break;
    }

    const cur = st.current;
    if (cur && cur.id !== lastLoggedDeck) {
        lastLoggedDeck = cur.id;
        currentDeckSince = Date.now();
        attempt = (attemptsByDeck.get(cur.id) ?? 0) + 1;
        log({ event: 'deck-current', deck: cur.slug, detail: `queue ${st.idx + 1}/${decks.length}, attempt ${attempt}` });
    }

    try {
        // Start capture once the page has painted this deck.
        if (phase === 'idle' && cur && st.readyAt && !st.doneAt && !obsRecording) {
            phase = 'starting';
            recordingDeckIdx = st.idx;
            await obs.request('StartRecord');
            await waitFor(() => obsRecording, OBS_START_TIMEOUT_MS, 'OBS STARTED event');
            await sleep(PREROLL_MS); // pre-roll: first slide on camera before the first word
            await post('/api/record/door', { open: true });
            recordingStartedAt = Date.now();
            phase = 'recording';
            log({ event: 'recording-started', deck: cur.slug });
        }

        // Page finished (post-roll included) — or test cut — stop and
        // finalize through the same path either way.
        const testCut = stopAfterMs !== null && Date.now() - recordingStartedAt >= stopAfterMs;
        if (phase === 'recording' && (st.doneAt || testCut)) {
            if (testCut) log({ event: 'test-cut', deck: cur.slug, detail: `--stop-after ${stopAfterMs}ms reached` });
            phase = 'stopping';
            lastStopOutputPath = null;
            await obs.request('StopRecord');
            await waitFor(() => lastStopOutputPath !== null, STOP_TIMEOUT_MS, 'OBS STOPPED event with outputPath');
            const durS = Math.round((Date.now() - recordingStartedAt) / 1000);
            const target = finalizeRecording(lastStopOutputPath, startNum + recordingDeckIdx, decks[recordingDeckIdx].slug, attempt);
            await post('/api/record/door', { open: false });
            await post('/api/record/advance', {});
            log({ event: 'deck-done', deck: decks[recordingDeckIdx].slug, detail: `${durS}s → ${path.basename(target)}` });
            phase = 'idle';
        }

        // Watchdog: page never painted the current deck.
        if (phase === 'idle' && cur && !st.readyAt && Date.now() - currentDeckSince > READY_TIMEOUT_MS) {
            await failDeck('page never posted ready');
        }
        // Watchdog: heartbeat went silent while we are capturing.
        if (phase === 'recording' && st.progress && Date.now() - st.progress.ts > HEARTBEAT_TIMEOUT_MS) {
            await failDeck(`page heartbeat silent for ${Math.round((Date.now() - st.progress.ts) / 1000)}s`);
        }
        if (phase === 'recording' && !st.progress && Date.now() - recordingStartedAt > HEARTBEAT_TIMEOUT_MS + 5000) {
            await failDeck('no progress ping ever arrived after door opened');
        }
    } catch (err) {
        await failDeck(err.message);
    }

    // Stats sampling while capturing — fps dips are logged, not fatal;
    // the recording is still valid, David judges the quality.
    if (obsRecording && Date.now() - statsSince > 10_000) {
        statsSince = Date.now();
        try {
            const s = await obs.request('GetStats');
            const warn = s.activeFps < 57 ? ' ⚠ FPS BELOW 57' : '';
            log({ event: 'stats', deck: decks[recordingDeckIdx]?.slug, detail: `fps ${s.activeFps.toFixed(1)}, skipped ${s.renderSkippedFrames}, disk ${Math.round(s.availableDiskSpace / 1024)} GB free${warn}` });
        } catch { /* stats are best-effort */ }
    }

    await sleep(POLL_MS);
}

// ── Shutdown ──
killChrome();
if (obsOwned && obsProc && obsProc.exitCode === null) {
    try { obsProc.kill(); } catch { /* already gone */ }
}
log({ event: 'run-end', detail: runAborted ? 'ABORTED — see faults above' : 'complete' });
process.exit(runAborted ? 1 : 0);
