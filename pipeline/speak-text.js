// ─── Spoken-text normalization (single source of truth) ───────
//
// Markdown-style *emphasis* and *stage-direction* markers are spoken by
// nSpeech as literal "asterisk" tokens. This helper rewrites them for
// natural TTS delivery and strips any stray asterisks. The on-screen
// slide.text / para.text keeps the marks; only the SPOKEN text is cleaned.
//
// Transformation order:
//   1. `*content*` → `(content)` — action beats like *pauses*, *stays*,
//      *laughs* become parenthetical, so Kokoro reads them with natural
//      cadence instead of "asterisk pauses asterisk".
//   2. Remaining stray `*` → removed (unpaired emphasis marks, etc.).
//
// Contract: always returns a string. null/undefined → ''.
// Fail-fast: no silent null-preservation. TTS needs a string.

function speakText(text) {
    return String(text || '')
        .replace(/\*+([^*]+?)\*+/g, '($1)')
        .replace(/\*+/g, '');
}

module.exports = { speakText };

