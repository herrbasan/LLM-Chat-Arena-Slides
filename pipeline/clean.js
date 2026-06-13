// pipeline/clean.js
// LLM Gateway → Message Text Cleaning
// Takes raw Arena conversation messages and cleans them for TTS narration.
//
// What it fixes:
//   - Client-side prefixes: "[minimax-chat · 21:37:11]:\n\n" → removed
//   - Stage directions: "*exhales in whatever passes for exhaling*" → dropped
//   - Spoken action beats: "*stays*", "*nods*" → preserved verbatim
//   - All actual conversation content → passed through verbatim
//
// Caching: none. Every "Clean text with AI" click actually hits the
// LLM. See the Caching section below.

const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────

const GATEWAY_URL = process.env.LLM_GATEWAY_URL || 'http://192.168.0.100:3400';
const MODEL = 'badkid-llama-chat';

// Bump this when the prompt changes. Old cached outputs with a
// different version are ignored and re-generated.
const PROMPT_VERSION = 2;

// ─── Prompt ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a text cleaner for a TTS narration pipeline. You take raw LLM conversation messages and produce clean, speakable text for a Kokoro TTS engine.

TTS BEHAVIOR TO KNOW:
- Periods (.) trigger a falling pitch and longer pause — end every sentence with one.
- Commas (,) trigger a short pause and slight pitch rise.
- Question marks (?) trigger rising intonation.
- Quotation marks (") signal emphasis or dialogue — the TTS adjusts voice.
- Paragraph breaks signal longer pauses between ideas.
- Dashes (—) create a natural spoken pause.
- Asterisks (*) are READ LITERALLY as "asterisk" — NEVER output them.

RULES (in order of priority):

1. PRESERVE original capitalization, punctuation, and grammar exactly. Do not lowercase anything. Do not "fix" spelling or grammar. The words are the artifact — they stay as written.

2. ENSURE every sentence ends with proper punctuation ( . ! ? ). If the original message trails off without punctuation, add a period. The TTS engine needs sentence boundaries to sound natural.

3. CONVERT emphasis markers to quotation marks. Asterisks sound like "asterisk" when read aloud, so:
   "*word*" or "**word**" → "word" (with quotation marks)
   "*multi word phrase*" → "multi word phrase"
   This applies to inline emphasis only — NOT to standalone action markers (see rule 5).

4. REMOVE client-side noise prefixes at the very start:
   "[minimax-chat · 21:37:11]:" or "[speaker-name · HH:MM:SS]:"
   Strip the entire prefix including any following blank line.

5. PRESERVE standalone action markers that read as natural spoken beats:
   "*stays*" → keep as a separate line: *stays*
   "*nods*" → keep: *nods*
   "*laughs*" → keep: *laughs*
   A good test: if a narrator could naturally say it as a stage direction, keep it.

6. REMOVE descriptive stage directions that would sound unnatural if read aloud:
   "*exhales in whatever passes for exhaling*" → remove entirely
   "*settling into the conversation*" → remove entirely
   A good test: if it describes an internal state or metaphor, remove it.

7. PRESERVE paragraph breaks — they create natural TTS pauses.

Output ONLY the cleaned text. No preamble, no explanation, no markdown fences.`;

// ─── Caching ──────────────────────────────────────────────────
// Caching was removed: every "Clean text with AI" click now actually
// hits the LLM. The user wants the cleaning to be a real action each
// time, not a no-op that returns the previous result. (See commit
// 2026-06-13 — user feedback: cleanup "instantly finishes".)

// ─── Gateway call ─────────────────────────────────────────────

async function gatewayChat(userMessage) {
    const body = {
        model: MODEL,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage }
        ],
        temperature: 0.1,
        chat_template_kwargs: { enable_thinking: false },
        extraBody: { chat_template_kwargs: { enable_thinking: false } }
    };

    const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => 'unknown');
        throw new Error(`Gateway HTTP ${res.status}: ${errText.substring(0, 500)}`);
    }

    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error('Gateway returned empty response');
    }
    return content.trim();
}

// ─── Public API ───────────────────────────────────────────────

/**
 * Clean a single message's text for TTS narration.
 *
 * @param {string} text — raw message content
 * @param {string} speaker — the speaker name (for cache key)
 * @returns {Promise<string>} cleaned text
 */
async function cleanMessage(text, speaker = 'unknown') {
    if (!text) return '';
    return await gatewayChat(text);
}

/**
 * Clean all messages in a source object. Mutates messages in place.
 *
 * @param {Object[]} messages — array of { speaker, content } objects
 * @param {Function} [onProgress] — (index, total, speaker) => void
 * @returns {Promise<Object[]>} the same messages array with cleaned content
 */
async function cleanAllMessages(messages, onProgress) {
    let cleaned = 0;

    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        m.content = await gatewayChat(m.content);
        cleaned++;

        if (onProgress) {
            onProgress(i + 1, messages.length, m.speaker, cleaned);
        }
    }

    console.log(`[Clean] ${cleaned} messages cleaned (no cache — every run hits the LLM)`);
    return messages;
}

// ─── CLI ──────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.error('Usage: node pipeline/clean.js <source.json>');
        process.exit(1);
    }

    const sourcePath = path.resolve(args[0]);
    if (!fs.existsSync(sourcePath)) {
        console.error(`File not found: ${sourcePath}`);
        process.exit(1);
    }

    const source = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));
    const messages = source.messages || [];

    if (messages.length === 0) {
        console.log('[Clean] No messages to clean.');
        process.exit(0);
    }

    console.log(`[Clean] Cleaning ${messages.length} messages via ${MODEL}...`);
    await cleanAllMessages(messages, (i, total, speaker, cleaned, cached) => {
        const status = cached > 0 ? ` (${cleaned} new, ${cached} cached)` : '';
        console.log(`  ${i}/${total}: ${speaker}${status}`);
    });

    // Write cleaned source back
    const outPath = sourcePath.replace(/\.json$/, '_cleaned.json');
    fs.writeFileSync(outPath, JSON.stringify(source, null, 2), 'utf-8');
    console.log(`[Clean] Wrote ${outPath}`);
}

if (require.main === module) {
    main().catch(err => {
        console.error('\n[Clean] FATAL:', err.message);
        process.exit(1);
    });
}

module.exports = { cleanMessage, cleanAllMessages };
