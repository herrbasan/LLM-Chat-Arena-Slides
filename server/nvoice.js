// server/nvoice.js
// Alignment client — historically nVoice, now nSpeech's forced alignment.
// The module name is kept to avoid changing 30+ call sites.
//
// nSpeech /v1/audio/align (torchaudio MMS_FA) is text-constrained forced
// alignment: word count in === word count out, no hallucination, no drops.
// Accepts MP3 directly (ffmpeg-decoded server-side).

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
        const err = new Error(`nSpeech align HTTP ${res.status}: ${body.slice(0, 200)}`);
        err.status = res.status;
        throw err;
    }
    const data = await res.json();
    if (!Array.isArray(data.words) || data.words.length === 0) {
        throw new Error('nSpeech align returned no words');
    }
    return data; // { text, duration, words: [{ word, start, end, probability }] }
}

async function health(baseUrl) {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    return res; // caller inspects status — 503 means model still loading
}

module.exports = { align, health };
