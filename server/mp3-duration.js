// server/mp3-duration.js
// Compute MP3 duration by walking frame headers. No dependency, no decode —
// just header math. Used to set paragraph/slide durationMs to the REAL audio
// length (nVoice's last-word-end under-reports because of trailing silence
// the aligner doesn't cover). The player chains paragraphs and drives the
// progress bar from durationMs, so it must match the actual file.
//
// Handles MPEG 1/2/2.5 Layer III (what ffmpeg's libmp3lame emits).
// Skips ID3v2. Returns milliseconds (integer).

const BITRATES = {
    1:   [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    2:   [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    2.5: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
};
const SAMPLE_RATES = {
    1:   [44100, 48000, 32000],
    2:   [22050, 24000, 16000],
    2.5: [11025, 12000, 8000]
};

function mp3DurationMs(buf) {
    let i = 0;
    // Skip ID3v2 tag if present.
    if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
        const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
        i = 10 + size;
    }
    let totalMs = 0;
    let frames = 0;
    while (i + 4 < buf.length) {
        if (buf[i] === 0xFF && (buf[i + 1] & 0xE0) === 0xE0) {
            const verBits = (buf[i + 1] >> 3) & 0x03;
            const layerBits = (buf[i + 1] >> 1) & 0x03;
            const brIdx = (buf[i + 2] >> 4) & 0x0F;
            const srIdx = (buf[i + 2] >> 2) & 0x03;
            const pad = (buf[i + 2] >> 1) & 0x01;
            const ver = verBits === 3 ? 1 : verBits === 2 ? 2 : verBits === 0 ? 2.5 : null;
            if (!ver || layerBits !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) { i++; continue; }
            const br = BITRATES[ver][brIdx] * 1000;
            const sr = SAMPLE_RATES[ver][srIdx];
            const samples = ver === 1 ? 1152 : 576;
            const frameLen = Math.floor((samples / 8 * br) / sr) + pad * (ver === 1 ? 4 : 1);
            totalMs += (samples / sr) * 1000;
            frames++;
            i += frameLen;
        } else {
            i++;
        }
    }
    if (frames === 0) throw new Error('No MP3 frames found — not an MP3 buffer');
    return Math.round(totalMs);
}

module.exports = { mp3DurationMs };
