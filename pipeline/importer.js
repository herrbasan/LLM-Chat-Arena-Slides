// pipeline/importer.js
// Arena Export JSON → Source Object
// Thin parser — extracts the seed prompt, normalizes participants, strips
// the moderator from messages, and returns a clean source object the
// rest of the pipeline consumes. No text cleaning, no slide creation —
// that's llm-clean.js.
//
// Supports both legacy (v1) and current (v2, mode: "arena") formats.
// The v2 format has participants as objects with name/model/role and
// messages with extra metadata (id, usage, streamStats). The first
// message is typically a `moderator` system prompt that sets the topic.
//
// The full source (settings, summary, chatInfo, etc.) is preserved on
// the deck record. This module just extracts the fields the pipeline
// actually needs.

const fs = require('fs');
const path = require('path');

// Parse the chat-app export shape and return the same source object
// that parseArenaExport would have produced for a canonical Arena export.
// The chat export has `messages` at the top level (same as canonical)
// but all metadata is under `session.*` (id, summary, arenaConfig).
// It does NOT preserve per-message timestamps, and the `model` field
// per message is unreliable across recording modes (sometimes null,
// sometimes swapped with `speaker`, sometimes a truncated label).
// We trust `speaker` as the per-message identity.
function parseChatExport(arenaData) {
    const session = arenaData.session;
    const config = session.arenaConfig || {};
    const messages = arenaData.messages;

    // exportedAt: session.id encodes the session timestamp. The chat
    // app uses either "arena-<ms>-<rand>" (its own session id) or
    // "chat_<ms>_<rand>" (canonical Arena export id). Both encode a
    // millisecond timestamp as the second component. Falls back to
    // "now" if the pattern doesn't match — e.g. chat-id-only files
    // without a timestamp prefix.
    const idMs = (session.id || '').match(/^(?:arena-|chat_)(\d+)/);
    const exportedAt = idMs
        ? new Date(parseInt(idMs[1], 10)).toISOString()
        : new Date().toISOString();

    // participants: from arenaConfig.modelA + modelB. Hard-filter
    // `moderator` even though the chat export doesn't put it there.
    const participants = [config.modelA, config.modelB]
        .filter(Boolean)
        .filter(p => p.toLowerCase() !== 'moderator');

    // Locate the moderator. The first message is normally the seed
    // prompt, but chat-exported sessions allow the moderator to
    // interject mid-conversation. We take the first moderator message
    // as the seed prompt and strip ALL moderator messages from the
    // conversation (the renderer never sees them).
    const moderatorIndices = [];
    let firstModerator = null;
    for (let i = 0; i < messages.length; i++) {
        if ((messages[i].speaker || '').toLowerCase() === 'moderator') {
            moderatorIndices.push(i);
            if (firstModerator === null) firstModerator = messages[i];
        }
    }
    const moderatorMessage = firstModerator;
    const seedPrompt = moderatorMessage
        ? (moderatorMessage.content || '').replace(/^\s*Topic:\s*/i, '').trim()
        : null;

    // Strip  blocks (kimi-cli-chat / kimi-chat sessions leak the
    // model's reasoning trace into the recorded content). Drop empty
    // messages defensively. createdAt is null for every message because
    // the chat export doesn't preserve per-message timestamps.
    const modSet = new Set(moderatorIndices);
    const cleaned = messages
        .filter((_, i) => !modSet.has(i))
        .map(m => {
            const content = (m.content || '')
                .replace(/<think[\s\S]*?<\/think>/g, '')
                .trim();
            return {
                speaker: m.speaker || 'Unknown',
                role: m.role || 'assistant',
                content: content,
                createdAt: null,
                model: null
            };
        })
        .filter(m => m.content.length > 0);



    return {
        id: session.id || 'unknown',
        exportedAt: exportedAt,
        topic: (session.summary && session.summary.title) || 'Untitled Conversation',
        seedPrompt: seedPrompt,
        seedPromptRaw: moderatorMessage ? (moderatorMessage.content || '').trim() : null,
        participants: participants,
        messages: cleaned,
        renderedAt: exportedAt
    };
}

function parseArenaExport(arenaData) {
    if (!arenaData || !Array.isArray(arenaData.messages)) {
        throw new Error('Invalid Arena export: missing messages array');
    }

    // Chat-export shape: { messages: [...], session: { id, summary,
    // arenaConfig, ... } }. The chat app stores metadata under session.*
    // and the messages at the top level. Detect by the presence of
    // `session` and hoist.
    if (arenaData.session) {
        return parseChatExport(arenaData);
    }

    // Idempotent guard: if the input is ALREADY a parsed source object
    // (e.g. the editor's "Generate with AI" re-sends deck.source, which
    // has no moderator message and already has seedPrompt set), pass it
    // through. Re-parsing would lose the seedPrompt (the moderator is
    // already stripped from messages) and the topic slide would fall
    // back to the AI-generated summary.
    const hasModerator = arenaData.messages.some(
        m => (m.speaker || '').toLowerCase() === 'moderator'
    );
    if (!hasModerator && arenaData.seedPrompt) {
        return {
            id: arenaData.id || arenaData.source?.id || 'unknown',
            exportedAt: arenaData.exportedAt || arenaData.source?.exportedAt || new Date().toISOString(),
            topic: arenaData.topic || arenaData.source?.topic || 'Untitled Conversation',
            seedPrompt: arenaData.seedPrompt,
            seedPromptRaw: arenaData.seedPromptRaw || arenaData.seedPrompt,
            participants: (arenaData.participants || arenaData.source?.participants || []).map(p =>
                typeof p === 'string' ? p : (p && p.name) || null
            ).filter(Boolean),
            messages: arenaData.messages || arenaData.source?.messages || [],
            // renderedAt is optional; absent on a fresh parse, set by
            // the deck-creation caller.
            renderedAt: arenaData.renderedAt || arenaData.source?.renderedAt || null
        };
    }

    // Normalize participants to a flat array of name strings.
    // v1: ['glm5-chat', 'minimax-m3-chat']
    // v2: [{ name: 'glm5-chat', model: 'glm5-chat', role: 'assistant' }, ...]
    let participants = (arenaData.participants || [])
        .map(p => {
            if (typeof p === 'string') return p;
            if (p && typeof p === 'object' && p.name) return p.name;
            return null;
        })
        .filter(Boolean);

    // Fallback: derive participants from the speaker set in messages.
    if (participants.length === 0) {
        const speakers = new Set();
        for (const m of arenaData.messages) {
            if (m.speaker) speakers.add(m.speaker);
        }
        participants = [...speakers];
    }

    // The moderator's first message is the SEED PROMPT — the literal text
    // sent to participantA. We extract it and expose it as `seedPrompt`
    // (without the "Topic:" prefix) and `seedPromptRaw` (with it).
    // The `topic` field on the Arena export is the AI-generated summary
    // title produced AFTER the conversation; do NOT use it for the topic
    // slide. The moderator message itself is stripped from `messages` so
    // the renderer never sees it.
    const moderatorIdx = arenaData.messages.findIndex(
        m => (m.speaker || '').toLowerCase() === 'moderator'
    );
    const moderatorMessage = moderatorIdx >= 0 ? arenaData.messages[moderatorIdx] : null;
    const seedPrompt = moderatorMessage
        ? (moderatorMessage.content || '').replace(/^\s*Topic:\s*/i, '').trim()
        : null;

    return {
        id: arenaData.id || arenaData.chatInfo?.id || 'unknown',
        exportedAt: arenaData.exportedAt || new Date().toISOString(),
        // Kept for backward compat / display — but DO NOT use for the topic slide.
        topic: arenaData.topic || arenaData.chatInfo?.title || 'Untitled Conversation',
        // The actual seed prompt that the first model responded to.
        // Verbatim from messages[0].content, minus the `Topic:` prefix.
        seedPrompt: seedPrompt,
        // Raw, unprefixed moderator content including `Topic:` prefix, for
        // the deterministic topic slide to speak verbatim if it wants.
        seedPromptRaw: moderatorMessage ? (moderatorMessage.content || '').trim() : null,
        participants: participants,
        // Messages WITHOUT the moderator. The LLM never sees the moderator.
        messages: arenaData.messages
            .filter((_, i) => i !== moderatorIdx)
            .map(m => ({
                speaker: m.speaker || m.model || 'Unknown',
                role: m.role || 'assistant',
                content: m.content || m.text || '',
                createdAt: m.createdAt || null,
                model: m.model || m.speaker || null
            })),
        // renderedAt is the publish-date approximation. The importer
        // doesn't know it; the caller (cleanWithLLM or the reimport
        // script) sets it. Default to exportedAt for safety.
        renderedAt: arenaData.exportedAt || new Date().toISOString()
    };
}

function main() {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.error('Usage: node pipeline/importer.js <arena-export.json> [output-dir]');
        process.exit(1);
    }

    const inputPath = path.resolve(args[0]);
    const outputDir = path.resolve(args[1] || 'pipeline/output');

    if (!fs.existsSync(inputPath)) {
        console.error(`Input file not found: ${inputPath}`);
        process.exit(1);
    }

    fs.mkdirSync(outputDir, { recursive: true });

    const raw = fs.readFileSync(inputPath, 'utf-8');
    const arenaData = JSON.parse(raw);
    const source = parseArenaExport(arenaData);

    const outputPath = path.join(outputDir, 'source.json');
    fs.writeFileSync(outputPath, JSON.stringify(source, null, 2), 'utf-8');

    console.log(`[Importer] ${source.messages.length} messages from "${source.topic}"`);
    console.log(`[Importer] Participants: ${source.participants.join(', ')}`);
    console.log(`[Importer] Output: ${outputPath}`);
}

if (require.main === module) {
    main();
}

module.exports = { parseArenaExport };
