// server/nspeech.js
// nSpeech V3 client — the ONLY place in this project that knows the V3
// wire format. Everything else calls these helpers.
//
// V3 surface used here (see reference/nSpeech_API.md):
//   POST /v1/audio/speech   — OpenAI-compatible TTS, raw audio bytes out
//   GET  /v1/voices?engine= — voices for an engine
//   GET  /v1/admin/engines  — engine list with loaded/health state
//   GET  /health            — { status, version, engine }
//
// The `model` field selects the provider: "nspeech" = dashboard-selected
// local engine; "minimax" | "elevenlabs" | "gemini" | "xai" = cloud.
// Old local engine names (kokoro, dots, ...) are REJECTED by V3 — never
// pass them as `model`.

// Batch mode: render the full audio before the first byte. For slideshow
// rendering we always want this — the file is consumed whole anyway, and
// progressive streaming only adds failure surface.
async function tts(baseUrl, { text, voice, speed = 1.0, engine = 'nspeech', signal }) {
    const res = await fetch(`${baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: engine,
            input: text,
            voice,
            speed,
            response_format: 'mp3',
            extra_body: { batch: true }
        }),
        signal
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`nSpeech TTS HTTP ${res.status}: ${body.slice(0, 200)}`);
        err.status = res.status;
        throw err;
    }
    return Buffer.from(await res.arrayBuffer());
}

async function listVoices(baseUrl, engine) {
    const qs = engine ? `?engine=${encodeURIComponent(engine)}` : '';
    const res = await fetch(`${baseUrl}/v1/voices${qs}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`nSpeech /v1/voices HTTP ${res.status}`);
    return res.json(); // { voices: [{ voice_id, name, category, voice_type, engine, ... }] }
}

async function listEngines(baseUrl) {
    const res = await fetch(`${baseUrl}/v1/admin/engines`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`nSpeech /v1/admin/engines HTTP ${res.status}`);
    return res.json(); // { current, engines: [...] }
}

async function health(baseUrl) {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`nSpeech /health HTTP ${res.status}`);
    return res.json(); // { status: "ok", version, engine }
}

module.exports = { tts, listVoices, listEngines, health };
