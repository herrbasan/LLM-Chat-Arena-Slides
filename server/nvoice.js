// server/nvoice.js
// nVoice V3 client — the ONLY place in this project that knows the V3
// wire format. Everything else calls these helpers.
//
// V3 surface used here (see reference/nVoice_API.md):
//   POST /v1/audio/align — multipart: file + text → { text, duration, words[] }
//   GET  /health         — { status, version, engine }
//
// NOTE: /v1/audio/align returns a FLAT word list (no segments[]). The old
// /transcribe-style segment structure is gone. Guardrail G5: the supplied
// text is NOT used as initial_prompt — the worker transcribes with word
// timestamps and the caller consumes them directly.

async function align(baseUrl, { audioBuffer, text, filename = 'audio.mp3', signal }) {
    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: 'audio/mpeg' }), filename);
    form.append('text', text);

    const res = await fetch(`${baseUrl}/v1/audio/align`, {
        method: 'POST',
        body: form,
        signal
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`nVoice align HTTP ${res.status}: ${body.slice(0, 200)}`);
        err.status = res.status;
        throw err;
    }
    const data = await res.json();
    if (!Array.isArray(data.words) || data.words.length === 0) {
        throw new Error('nVoice align returned no words');
    }
    return data; // { text, duration, words: [{ word, start, end, probability? }] }
}

async function health(baseUrl) {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    return res; // caller inspects status — 503 means model still loading
}

module.exports = { align, health };
