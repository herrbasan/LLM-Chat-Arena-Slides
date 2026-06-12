# Specification

> A description of what this app is, what it does today, and what needs to
> happen to ship the first video. Read this when you want to know what we
> agreed the system is. This is not a session log.

---

## 1. What this app is

A tool that takes a single **Arena conversation export** (a JSON file
describing a free-form conversation between two LLMs) and turns it into
a **playable, narrated video** that can be uploaded to YouTube.

The video is a slideshow: each slide shows the conversation text, the
narration is read aloud by a TTS engine, and the current word is
highlighted as the audio plays. The viewer reads along.

The intended audience is whoever is watching the YouTube video. The
intended user is **one person** (you) doing the production work. This is
not a multi-user product. It is a production tool with one user.

**The goal right now is to publish the first video.** The goal after
that is to make the second one easier than the first. Improvements
beyond "easier" are open-ended and not the current focus.

---

## 2. The pipeline (intended)

There are four stages. Each stage has a clear input, a clear output, and
a clear failure mode. The user described this pipeline explicitly and it
matches the docs/PLAN.md data flow.

```
[1] IMPORT       raw Arena export JSON
                → project record with `raw` set to the full export
                (no copy, no normalization, no moderator stripping —
                 each downstream stage reads what it needs from raw.
                 See §5 for the field-by-field policy.)

[2] CLEAN       source.messages[] (one message at a time)
                → cleaned message strings
                (strips client-side noise like "[minimax-chat · 21:37:11]:"
                 prefixes, normalizes action markers like "*stays*" into
                 a spoken-friendly form, removes embedded stage directions
                 and markdown that doesn't belong in spoken text)
                Implemented in pipeline/clean.js. Calls the LLM gateway
                per-message. Results are cached on disk keyed by content
                hash so re-runs are free.

[3] BUILD       cleaned messages + source metadata
                → a slide deck
                (3 fixed opening slides: setup / details / topic
                 + 1 slide per cleaned message, with long messages
                 split at sentence boundaries
                 + 1 fixed closing slide: end)
                This stage is deterministic. The opening and closing
                slides are "dumb" builders — same shape every time.
                The only thing that varies per-deck is the topic text
                and the model names.
                Implemented in pipeline/build-deck.js.

[4] RENDER      a slide deck
                → a renderable video
                (TTS audio generated per slide via nSpeech
                 + per-word timestamps from nVoice forced alignment
                 + cached on disk so re-renders are fast)
                The user triggers this manually with a "Render All" button
                in the UI. The browser plays the rendered deck.
```

**Stage 1 and stage 3 are deterministic.** Stage 2 uses an LLM (the local
`badkid-llama-chat` model via the gateway at `http://192.168.0.100:3400`).
Stage 4 uses nSpeech (TTS) and nVoice (alignment) as external services.

**Caching is per-stage.** Re-running the pipeline with the same inputs
should not re-do work that was already done.

---

## 3. What the codebase does today (2026-06-12)

This is the actual state, including the gaps. I'll be honest about what's
in place and what's a half-built idea.

### 3.1 What works

**Stage 1 (import) is in place and tested.**
- `pipeline/importer.js` parses an Arena export, strips the moderator,
  normalizes participants, and exposes `seedPrompt`/`seedPromptRaw`
  on a source object. Tested by reimporting the reference conversation.

**Stage 2 (clean) is newly wired up.**
- `pipeline/clean.js` calls the LLM gateway per-message to remove
  client-side noise (`[minimax-chat · 21:37:11]:`), preserve spoken
  action markers (`*stays*`), and drop stage directions
  (`*exhales in whatever passes for exhaling*`).
- Results are cached on disk keyed by content hash, so re-runs skip
  the gateway for unchanged messages.

**Stage 3 (build) is in place and tested.**
- `pipeline/build-deck.js` (formerly `llm-clean.js`) contains
  `buildOpeningSlides` (a "dumb" locked contract),
  `generateConversationSlides` (deterministic, one slide per message,
  splits long messages at sentence boundaries), and `buildEndSlide`.
  Output is deterministic.

**Stage 4 (render) is in place and tested.**
- `pipeline/tts.js` and `pipeline/align.js` handle TTS + word alignment.
- `server/server.js` exposes `POST /api/render-deck/:id` and
  `POST /api/render-slide/:id/:idx` endpoints.
- The render cache lives in `server/data/render_cache/{projectId}/`
  with one MP3 per slide keyed by `renderHash` (a hash of the spoken
  text + voice + speed). Re-renders with unchanged inputs are free.
- The browser's render & play page (`web/js/pages/render.js`) plays
  the deck with word-by-word highlighting. Verified in browser.

**The browser UI is in place.**
- A projects page (drag-and-drop import) — `web/js/pages/projects.html`
- An editor page (the import, the LLM-clean, the deck, and the chat) —
  `web/js/pages/editor.html` / `editor.js`
- A render & play page (playback, word highlighting, controls) —
  `web/js/pages/render.html` / `render.js`
- All use the nui_wc2 component library. CSS lives in
  `web/css/main.css`.

**One conversation has been reimported and renders correctly.**
- The House vs Grooves deck (`slideshow_house_vs_grooves` in
  `server/data/slideshows.jsonl`) is the canary. It has the v2
  structure: setup / details (with meta block) / topic / 54 conversation
  slides / end. Audio has been generated for previous runs but the
  cache was wiped during the v2 reimport. Re-rendering regenerates.

**The nDB project file format is stable.**
- `server/data/slideshows.jsonl` — one JSON line per write, last-write-wins
  by `_id`. The line is an append-style audit trail. nDB also keeps a
  binary index at `server/data/slideshows.ndb` (a small metadata file).
  The render cache is gitignored.

### 3.2 What's incomplete / known gaps

**nVoice strips punctuation from word tokens.** Characters like `...`
(ellipsis), `"` (quotes), and other non-word characters are dropped by
nVoice and don't appear in the timed word stream. The LLM cleaning
prompt in `pipeline/clean.js` mitigates this by converting `*emphasis*`
→ `"emphasis"` (Kokoro TTS handles quotes naturally), but characters
like `...` still get lost. The fix is upstream in nVoice, not in the
slideshow renderer. The timed word stream is used directly for display;
no post-alignment word-matching is attempted.

**The chat panel is hidden.** The editor's right-column chat panel
(`web/pages/editor.html`) is `display:none`. The `/api/chat` endpoint
and tool handlers in `server/server.js` are still alive but not exposed
in the UI.

**The editor's slide cards don't reflect the new v2 structure.** Cards
show a single textarea bound to `slide.text`. The renderer shows the
correct per-type content, but the editor doesn't. Defer until after
first video.

**Topic-slide visual treatment is minimal.** The renderer emits
`slide--layout-centered` and `slide--accent-bg` classes. The CSS
provides a default centered card with accent background. Acceptable for
the first video; polish later.

**No pipeline tests.** `pipeline/align.test.js` exists for the align
module only. No tests for `importer.js`, `clean.js`, or `build-deck.js`.

---

## 4. What's intentionally out of scope for the first video

These are explicit "not now" items. They're not forgotten; they're
deferred so we can ship.

- **Per-type editor polish.** The current editor's slide cards don't
  match the new v2 renderer. Fix after first video is published.
- **Long-message splitting UX.** The current split is at sentence
  boundaries, capped at 600 chars per slide. The current behavior is
  fine; we just don't expose it in the UI.
- **Multi-user.** This is a single-user production tool.
- **Project sharing, export formats other than the browser renderer,
  fullscreen recording mode.** All described in PLAN.md, all deferred.
- **Visual polish on topic / details / conversation slides.** The
  class hooks are in place; the actual visual treatment is "good
  enough." Polish later.
- **The spin-off project** (a separate repo that takes the voice +
  transcript-sync parts and drops the Arena framing). Open question,
  not on the critical path.
- **The chat tool extensions** (`slideshow_delete_slide`,
  `slideshow_move_slide`, etc.) — explicitly deprioritized.
- **Docs, INSIGHTS.md, the spin-off bootstrap writeup.** Defer.

---

## 5. The Arena export: what we read, what we don't

A single Arena export JSON is the only input. The pipeline stores the
JSON as-is on the project record — **no mutation, no copy of normalized
fields** — and each stage reads the fields it needs directly. This
avoids the drift problem where a "source" object and the original
JSON can get out of sync.

### 5.1 What the export contains (top-level)

The export has roughly this shape (abridged from the reference):

```json
{
  "version": 2,
  "mode": "arena",
  "id": "chat_1780861027246_ecqwz2gl",
  "sessionId": "...",
  "exportedAt": "2026-06-08T18:09:39.468Z",
  "topic": "House vs. Grooves: Being Caught Up",
  "chatInfo": {
    "id": "chat_1780861027246_ecqwz2gl",
    "title": "House vs. Grooves: Being Caught Up",
    "createdAt": 1780861027246,
    "updatedAt": 1780942172953,
    "category": "",
    "pinned": false
  },
  "participants": [ { "name": "glm5-chat", ... }, { "name": "minimax-m3-chat", ... } ],
  "settings": { ... },
  "summary": { "title": "...", "teaser": "...", "reflection": "..." },
  "messages": [ ... ]
}
```

### 5.2 Field-by-field policy

| Field | Read? | Used for |
|---|---|---|
| `messages[]` | **Yes** | The conversation itself. The moderator message (typically `messages[0]`, with `speaker: "moderator"`) is the seed prompt. All other messages are conversation content. |
| `participants[]` | **Yes** | Normalized to a flat `string[]` of names (one per `name` field). Used to map voices and to populate the details slide. |
| `id` (or `chatInfo.id`) | **Yes** | Project id when the export is imported. |
| `exportedAt` | **Yes** | The recorded date on the details slide. |
| `chatInfo.title` | **Yes, for display only** | The human-given conversation name. The user gives conversations memorable names so they can find them in a list. Used as the project title in the projects list. **Never used for slide content.** |
| `topic` | **No** | The AI-generated summary title produced AFTER the conversation. We ignore it entirely. (The previous code fell back to it for display; we now prefer `chatInfo.title`.) |
| `summary` (object) | **No** | The teaser / reflection / etc. Created for the user to scan conversations, not for the pipeline. |
| `settings` | **No** | Configuration of the Arena run that produced the export. Irrelevant to playback. |
| `sessionId` | **No** | Diagnostic id. |
| `version`, `mode` | **No** | Schema version. The pipeline doesn't branch on it (we treat the export as opaque except for the fields above). |

### 5.3 The "topic" slide specifically

The on-screen topic slide text is **the moderator's literal message**,
with the `Topic:` prefix preserved. This is the **seed prompt** — the
text the first model actually responded to. It is *not* `chatInfo.title`
(the human's name for the conversation) and it is *not* `topic` (the
AI's summary of what was discussed).

Concretely, the topic slide text is taken from `messages[0].content`
where `messages[0].speaker === "moderator"`. If the prefix is
`Topic:`, we preserve it; we don't strip it.

This is the "seed prompt is the topic" rule. The earlier conversation
semantics section in `Agents.md` documents the reasoning.

### 5.4 Why store raw, not normalized

The current code creates a separate "source" object with the fields
above extracted and the moderator stripped from `messages[]`. The
user explicitly said: **don't do that**. The reasoning:

- The "source" object is a copy that can drift from the original JSON
  if either side is edited independently.
- The "messages" array with the moderator still in it is a faithful
  representation of the export. The slide builder can ignore the
  moderator; nothing else needs the cleaned version.
- Each pipeline stage already has narrow field needs. Pulling only
  what you need at the call site is clearer than a normalized blob.

Under this rule:

- The project record has `raw` (the full Arena JSON), not `source`.
- `buildOpeningSlides(raw)` reaches into `raw.messages`, `raw.participants`,
  `raw.exportedAt`, `raw.chatInfo?.title` directly.
- `generateConversationSlides(raw)` reaches into `raw.messages` and
  `raw.participants` directly.
- The editor's project list shows `project.raw?.chatInfo?.title` as
  the human-readable label.

### 5.5 Edge cases the importer handles

These are checked at import time. If they fail, the import rejects
the export with a clear error.

- `messages` is missing or not an array.
- The export has **no** moderator message. The seed prompt is required
  for the topic slide. (We don't currently support this; if a future
  conversation doesn't have a moderator, the user can add one
  manually before reimporting.)
- `participants` is empty AND no messages have a `speaker` field.
  The voice mapping has no roles to assign.

These are rare. The current importer handles the common case. The
edge cases are here as a note for when we touch this code next.

---

## 6. The slide schema (deck version 2)

This is the contract for what a deck record looks like. All v2 decks
follow this. Old v1 decks (with `type: 'title'`) are no longer
renderable; the supported migration is the reimport script.

### 5.1 Slide types

| Type            | Speaker       | Purpose |
|-----------------|---------------|---------|
| `setup`         | `narrator`    | Frame the experiment. Locked narration. |
| `details`       | `narrator`    | Provenance: when recorded, when rendered, which models, how many turns. |
| `topic`         | `narrator`    | The seed prompt, verbatim, with the `Topic:` prefix preserved. |
| `conversation`  | `participantA` / `participantB` | One per source message, possibly split. |
| `end`           | `narrator`    | Closing card. Locked text. |

### 5.2 Slide object shape

```json
{
  "type": "topic",
  "speaker": "narrator",
  "label": "Narrator",
  "text": "Topic: ...",
  "narration": "Topic: ...",
  "meta": null,
  "tts": null
}
```

For a `details` slide, `meta` is a structured block:

```json
{
  "type": "details",
  "speaker": "narrator",
  "label": "Narrator",
  "text": "Details",
  "narration": "This recording was generated on ...",
  "meta": {
    "recordedAt": "2026-06-08T18:09:39.468Z",
    "renderedAt": "2026-06-08T18:09:39.468Z",
    "models": [
      { "name": "glm5-chat", "role": "participantA" },
      { "name": "minimax-m3-chat", "role": "participantB" }
    ],
    "turnCount": 20
  },
  "tts": null
}
```

For a `conversation` slide, the LLM-cleaned text is in `text`. The
`originalIdx` ties it back to a source message; `splitIdx` and
`splitCount` describe its position within a split long message:

```json
{
  "type": "conversation",
  "speaker": "participantA",
  "label": "glm5-chat",
  "text": "Hey there...",
  "originalIdx": 0,
  "splitIdx": 0,
  "splitCount": 1,
  "tts": null
}
```

### 5.3 tts field (populated by stage 4)

```json
{
  "audioFile": "slide_002_c01055c594e445c9.mp3",
  "audioPath": ".../render_cache/.../slide_002_c01055c594e445c9.mp3",
  "audioUrl": "/cache/audio/.../slide_002_c01055c594e445c9.mp3",
  "voice": "Adam_Eric",
  "speed": 0.95,
  "byteLength": 144812,
  "renderHash": "c01055c594e445c9",
  "words": [
    { "word": "Topic", "startMs": 0, "endMs": 320, "probability": 0.99, "segmentIndex": 0 }
  ],
  "segments": [
    { "index": 0, "text": "...", "startMs": 0, "endMs": 2400, "words": [ ... ] }
  ],
  "durationMs": 2400,
  "alignComplete": true,
  "sourceWordCount": 4,
  "alignedWordCount": 4,
  "alignVersion": 6
}
```

`renderHash` is the staleness oracle: it changes when text/voice/speed
change, and the render page flags the slide as stale when it doesn't
match.

---

## 7. The non-goals

- **This is not a multi-tenant system.** One user, one machine.
- **This is not real-time.** The render step takes minutes. That's fine.
- **This is not a research project.** The LLM clean step is a means to
  a polished video, not an experiment in prompt engineering.
- **This is not generalizable beyond Arena conversations.** Different
  input formats are deferred to the spin-off repo.

---

## 8. Current status (2026-06-12)

### Done

1. ~~Wire up the LLM clean step.~~ **Done.** `pipeline/clean.js` handles
   per-message cleanup via the LLM gateway, with content-hash caching
   keyed by `PROMPT_VERSION` so prompt changes invalidate old results.
2. ~~Hide the chat in the editor.~~ **Done.** Chat panel is `display:none`
   in `web/pages/editor.html`. `/api/chat` endpoint still alive.
3. ~~SSE progress stuck at 0%.~~ **Fixed.** Server flushes writes
   immediately (`setNoDelay`, `res.flush()`). Client yields to the browser
   between updates so the banner repaints.
4. ~~Stale render cache.~~ **Fixed.** "Render All" deletes the project
   cache directory before starting — every render is a clean slate.

### Known gap

**nVoice strips punctuation from word tokens.** Characters like `...`
(ellipsis) and `"` (quotes) don't survive the nVoice alignment. The LLM
cleaning prompt converts `*emphasis*` → `"emphasis"` which helps, but
`...` and similar characters are lost. The renderer uses nVoice's timed
word stream directly — no post-alignment word-matching to source text.

### Module map

```
pipeline/importer.js    Arena JSON → source object           [deterministic]
pipeline/clean.js       source → cleaned messages            [LLM gateway, cached]
pipeline/build-deck.js  cleaned messages → slide deck (v2)   [deterministic]
pipeline/tts.js         slide deck → TTS audio (nSpeech)     [external service]
pipeline/align.js       TTS audio → word timestamps (nVoice) [external service]
```

### To ship

1. Run `node server/reimport.js` (no `--skip-clean`) with gateway live
2. Click Render All
3. Watch video end-to-end, fix anything broken
4. Publish
