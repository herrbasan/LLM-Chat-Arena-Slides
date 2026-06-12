# Paragraph-Based Architecture Plan

**Date:** 2026-06-12
**Status:** Draft — pending approval

## Problem

The current system stores `slides[]` with flat `tts.words[]` alignment. Paragraph breaks in the source text are lost because nVoice's STT returns a flat word list. Characters like `...` and `*emphasis*` are stripped by STT, causing word-count mismatches and lost formatting.

## Solution

Eliminate stored slides entirely. The database stores **messages with paragraph-level render data**. Slide layout is computed at runtime by the browser.

---

## New Data Model

### What gets stored in nDB

```jsonc
{
  "_id": "slideshow_abc123",
  "version": 3,
  "source": {
    "arenaExportId": "...",
    "exportedAt": "2026-06-08T...",
    "topic": "AI-generated summary title",
    "seedPrompt": "This is a Chat app...",
    "seedPromptRaw": "Topic: This is a Chat app...",
    "participants": ["glm5-chat", "minimax-m3-chat"],
    "renderedAt": "2026-06-08T..."
  },
  "voiceMapping": {
    "narrator":     { "voice": "en-US-Male",   "speed": 0.95 },
    "participantA": { "voice": "en-US-Female", "speed": 1.0, "label": "glm5-chat" },
    "participantB": { "voice": "en-GB-Male",   "speed": 1.0, "label": "minimax-m3-chat" }
  },
  "messages": [
    {
      "speaker": "participantA",
      "label": "glm5-chat",
      "role": "assistant",
      "createdAt": "2026-06-08T...",
      "paragraphs": [
        {
          "text": "Hey there! That sounds like a genuinely fun setup.",
          "audioFile": "msg_000_p000_a1b2c3d4.mp3",
          "audioUrl": "/cache/audio/{projectId}/msg_000_p000_a1b2c3d4.mp3",
          "words": [
            { "word": "Hey", "startMs": 120, "endMs": 380, "probability": 0.97 },
            { "word": "there!", "startMs": 400, "endMs": 620, "probability": 0.95 }
          ],
          "durationMs": 2800,
          "renderHash": "a1b2c3d4"
        },
        {
          "text": "I've always wondered what it would be like to just... talk, without a human steering the conversation.",
          "audioFile": "msg_000_p001_e5f6g7h8.mp3",
          "audioUrl": "/cache/audio/{projectId}/msg_000_p001_e5f6g7h8.mp3",
          "words": [...],
          "durationMs": 4200,
          "renderHash": "e5f6g7h8"
        }
      ]
    }
  ],
  "createdAt": 1749345600000,
  "updatedAt": 1749345600000
}
```

### Key differences from current model

| Aspect | Current (v2) | New (v3) |
|--------|-------------|----------|
| Top-level structure | `slides[]` | `messages[].paragraphs[]` |
| Slide boundaries | Stored in DB | Computed at runtime |
| TTS/alignment unit | Per slide | Per paragraph |
| Audio files | `slide_000_hash.mp3` | `msg_000_p000_hash.mp3` |
| Opening slides | Stored as slides | Generated at runtime from `source` |
| Paragraph breaks | Lost | Preserved as paragraph boundaries |
| Render cache | `deck.json` + `cache_meta.json` | Per-paragraph audio files + cache meta |

---

## File-by-File Changes

### Phase 1: Pipeline — Data Model

#### `pipeline/build-deck.js` → `pipeline/build-messages.js`

**Current behavior:** Builds `slides[]` from source messages, splits long messages at sentence boundaries.

**New behavior:**
- Accepts parsed source from `importer.js`
- Cleans messages via LLM (unchanged)
- Splits each message's cleaned text into **paragraphs** (on `\n\n` or `\r\n\r\n`)
- Each paragraph gets its own text, but NO TTS/alignment yet
- Returns the v3 structure: `{ version: 3, source, voiceMapping, messages[] }`
- No more `slides[]`, no more `buildOpeningSlides()`, no more `buildEndSlide()`

**Paragraph splitting logic:**
```js
function splitIntoParagraphs(text) {
    // Split on double newlines (with optional whitespace)
    // Single newlines within a paragraph are preserved as soft breaks
    return text.split(/\n\s*\n/)
        .map(p => p.trim())
        .filter(p => p.length > 0);
}
```

**Message structure output:**
```js
{
    speaker: "participantA",
    label: "glm5-chat",
    role: "assistant",
    createdAt: "...",
    paragraphs: [
        { text: "First paragraph..." },
        { text: "Second paragraph..." }
    ]
}
```

#### `pipeline/importer.js`

**No changes.** The importer extracts the source from Arena JSON — it doesn't deal with slides or paragraphs. Its output feeds into the new `build-messages.js` unchanged.

#### `pipeline/clean.js`

**No changes.** The LLM cleaning prompt already preserves paragraph breaks (rule 7: "PRESERVE paragraph breaks — they create natural TTS pauses"). The cleaned text will have `\n\n` paragraph separators that `build-messages.js` splits on.

#### `pipeline/tts.js`

**Major refactor.** Currently generates one audio file per slide. New version generates one audio file per paragraph.

**New behavior:**
- Input: v3 project JSON (messages with paragraphs, no TTS data)
- For each message → for each paragraph:
  - Strip `*emphasis*` from spoken text
  - Call nSpeech TTS
  - Save as `msg_{msgIdx}_p_{paraIdx}_{renderHash}.mp3`
  - Store `{ text, audioFile, audioUrl, renderHash }` on the paragraph
- Output: same JSON with `audioFile`/`audioUrl`/`renderHash` on each paragraph

**New function signature:**
```js
async function processProject(projectJson, outputDir) → projectJson
```

#### `pipeline/align.js`

**Major refactor.** Currently aligns per slide. New version aligns per paragraph.

**New behavior:**
- Input: v3 project JSON (messages with paragraphs that have audio)
- For each message → for each paragraph:
  - Read the paragraph's audio file
  - Call nVoice `/align?text=...` with the paragraph's spoken text
  - Store `{ words[], durationMs }` on the paragraph
- Output: same JSON with `words[]`/`durationMs` on each paragraph

**Key simplification:** Each paragraph is short (typically 1-3 sentences). The alignment should be much more reliable because:
- Shorter text = less drift
- No paragraph breaks to lose
- The STT text reference matches the source closely

**New function signature:**
```js
async function processProject(projectJson, outputDir) → projectJson
```

#### `pipeline/pipeline.js`

**Update to use new modules:**
```
Import → Clean → Split into paragraphs → TTS per paragraph → Align per paragraph
```

No longer produces a "deck" — produces a v3 project JSON.

---

### Phase 2: Server — API & Render Cache

#### `server/server.js`

**Major changes.**

**New/changed API endpoints:**

| Endpoint | Change |
|----------|--------|
| `POST /api/generate-deck` | Returns v3 structure (messages + paragraphs) instead of slides |
| `POST /api/projects` | Stores v3 structure |
| `GET /api/projects/:id` | Returns v3 structure with render cache merged |
| `POST /api/render-deck/:id` | TTS + alignment per paragraph, not per slide |
| `POST /api/render-slide/:id/:idx` | → `POST /api/render-paragraph/:id/:msgIdx/:paraIdx` |
| `POST /api/tts-preview` | Unchanged |

**Render cache changes:**
- Cache directory: `render_cache/{projectId}/`
- Audio files: `msg_{msgIdx}_p_{paraIdx}_{renderHash}.mp3`
- `cache_meta.json`: maps `{msgIdx}_{paraIdx}` → renderHash
- `project.json`: cached copy of the full project with render data

**`getSpokenText()` changes:**
- No longer operates on slides
- New helper: `getParagraphSpokenText(paragraph)` — strips `*emphasis*` from paragraph text

**`alignSingleSlide()` → `alignParagraph()`:**
- Takes a paragraph object + audio path
- Calls nVoice `/align?text=...` with the paragraph's spoken text
- Returns `{ words[], durationMs }`

**Render endpoint flow:**
```
For each message:
  For each paragraph:
    Compute renderHash from (text + voice + speed)
    Check cache
    If miss: generate TTS → save audio
    If no alignment: call nVoice → store words/duration
Save project.json to cache
Return updated project JSON
```

**`GET /api/projects/:id` changes:**
- Merges render cache data (audio + alignment) into the response
- No more slide-level merging — paragraph-level merging

#### `server/slideshows.jsonl`

Existing data stays as-is (v2). New projects are v3. The server can detect version by checking `doc.version` or the presence of `doc.messages[0].paragraphs`.

---

### Phase 3: Browser — Runtime Slide Rendering

#### `web/js/pages/render.js`

**Major rewrite.** This is the biggest change.

**New responsibilities:**
1. Load project JSON (messages + paragraphs)
2. Build a virtual slide list at runtime
3. Render slides from the virtual list
4. Chain audio playback across paragraphs
5. Prefetch upcoming audio

**Virtual slide builder:**
```js
function buildVirtualSlides(project) {
    const slides = [];

    // Opening slides (deterministic, same as before)
    slides.push({ type: 'setup', ... });
    slides.push({ type: 'details', ... });
    slides.push({ type: 'topic', ... });

    // Conversation slides: group paragraphs into visual slides
    for (const message of project.messages) {
        const groups = groupParagraphs(message.paragraphs);
        for (const group of groups) {
            slides.push({
                type: 'conversation',
                speaker: message.speaker,
                label: message.label,
                paragraphs: group  // array of paragraph objects
            });
        }
    }

    // Closing slide
    slides.push({ type: 'end', ... });

    return slides;
}
```

**Paragraph grouping logic:**
```js
function groupParagraphs(paragraphs, maxChars = 600) {
    const groups = [];
    let current = [];
    let currentLen = 0;

    for (const para of paragraphs) {
        if (current.length > 0 && currentLen + para.text.length > maxChars) {
            groups.push(current);
            current = [];
            currentLen = 0;
        }
        current.push(para);
        currentLen += para.text.length;
    }
    if (current.length > 0) groups.push(current);

    return groups;
}
```

**Rendering a conversation slide:**
```js
function renderConversationSlide(slide) {
    // Each paragraph becomes a <div class="paragraph">
    // Each paragraph's words become <span class="word"> elements
    // Paragraphs are separated by visual spacing

    return slide.paragraphs.map(para => {
        const words = para.words || [];
        const wordSpans = words.map(w =>
            `<span class="word future" data-start="${w.startMs}" data-end="${w.endMs}">${escapeHtml(w.word)}</span>`
        ).join(' ');
        return `<div class="paragraph">${wordSpans}</div>`;
    }).join('');
}
```

**Audio playback — paragraph chaining:**
```js
// A "slide" may have multiple paragraphs, each with its own audio.
// Playback chains them: play para 0 → on ended → play para 1 → ...
// Word highlighting uses the active paragraph's timing offset.

let activeParagraphIdx = 0;
let paragraphOffsetMs = 0;  // cumulative offset for timing

function playSlide(slide) {
    activeParagraphIdx = 0;
    paragraphOffsetMs = 0;
    playParagraph(slide, 0);
}

function playParagraph(slide, paraIdx) {
    const para = slide.paragraphs[paraIdx];
    if (!para || !para.audioUrl) return;

    audio.src = para.audioUrl;
    paragraphOffsetMs = slide.paragraphs
        .slice(0, paraIdx)
        .reduce((sum, p) => sum + (p.durationMs || 0), 0);

    audio.onended = () => {
        activeParagraphIdx++;
        if (activeParagraphIdx < slide.paragraphs.length) {
            playParagraph(slide, activeParagraphIdx);
        } else {
            // Slide complete — advance to next slide
            advanceSlide();
        }
    };

    audio.play();
}

function updateWordHighlight(currentTimeMs) {
    // currentTimeMs is relative to the active paragraph's audio
    // The word data-start/data-end values are paragraph-relative
    // So we can use them directly without offset math
}
```

**Prefetching:**
```js
function prefetchSlideAudio(slide) {
    for (const para of slide.paragraphs || []) {
        if (para.audioUrl) {
            const link = document.createElement('link');
            link.rel = 'prefetch';
            link.href = para.audioUrl;
            document.head.appendChild(link);
        }
    }
}
```

**Slide list rendering:**
- The left panel shows the virtual slide list
- Labels are computed from message index + paragraph range
- Example: "3.0 glm5-chat" (message 3, first group), "3.1 glm5-chat" (message 3, second group)

#### `web/js/pages/editor.js`

**Moderate changes.**

- Load v3 project JSON instead of deck with slides
- Display messages with their paragraphs (not slides)
- The "source" view shows original Arena messages
- The "cleaned" view shows messages with paragraph breaks visible
- Voice mapping UI unchanged
- Save sends v3 structure to server

#### `web/js/pages/projects.js`

**Minor changes.**

- Project list shows message count instead of slide count
- "X messages, Y paragraphs" instead of "X slides"

#### `web/css/main.css`

**Additions:**
```css
.paragraph {
    margin-bottom: var(--nui-space);
}
.paragraph:last-child {
    margin-bottom: 0;
}
```

No other changes — word highlighting still uses the same `.word .future/.active/.past` classes with opacity.

---

### Phase 4: Migration & Compatibility

#### Migration strategy

1. **v2 projects remain readable.** The server detects `doc.version === 2` and serves them as-is. The render page detects the version and uses the old slide-based rendering path.
2. **New projects are v3.** Any project created after the refactor uses the paragraph model.
3. **Re-import to upgrade.** To convert a v2 project to v3, re-import the original Arena JSON. The pipeline produces v3 output.

#### No data migration script needed

The original Arena JSON is the source of truth. Re-importing always produces a fresh project. Old v2 projects continue to work with the legacy render path.

---

## Implementation Order

### Step 1: Pipeline (can be tested in isolation)
1. Create `pipeline/build-messages.js` (new file, based on `build-deck.js`)
2. Refactor `pipeline/tts.js` → paragraph-level TTS
3. Refactor `pipeline/align.js` → paragraph-level alignment
4. Update `pipeline/pipeline.js` to use new modules
5. Test: `node pipeline/pipeline.js reference/arena-*.json pipeline/output/test_v3`

### Step 2: Server API
1. Update `POST /api/generate-deck` to return v3 structure
2. Update `POST /api/render-deck/:id` for paragraph-level rendering
3. Add `POST /api/render-paragraph/:id/:msgIdx/:paraIdx`
4. Update `GET /api/projects/:id` for paragraph-level cache merging
5. Test: import + render via API, verify paragraph audio files

### Step 3: Browser — Render Page
1. Add version detection (v2 vs v3)
2. Build `buildVirtualSlides()` for v3 projects
3. Implement paragraph-grouping logic
4. Rewrite `loadSlide()` for paragraph-based rendering
5. Implement audio chaining across paragraphs
6. Implement prefetching
7. Test: play through a full v3 project

### Step 4: Browser — Editor & Projects
1. Update editor to display messages + paragraphs
2. Update project list to show message/paragraph counts
3. Test: create project, edit, render, play

### Step 5: Cleanup
1. Remove legacy slide-based code paths (once v2 projects are migrated)
2. Update `Agents.md` with new architecture
3. Remove `pipeline/llm-clean.js` shim (already redirects to `build-deck.js`)

---

## Open Questions

1. **Paragraph splitting heuristic** — Split on `\n\n` only? Or also on single `\n` when followed by a new speaker action like `*nods*`? The LLM clean prompt preserves paragraph breaks, so `\n\n` should be reliable.

2. **Max chars per visual slide** — Start with 600 characters (current `SLIDE_TEXT_SOFT_LIMIT`)? Or make it viewport-dependent?

3. **Opening/closing paragraph audio** — The setup, details, topic, and end slides are generated at runtime. Do they get TTS/alignment at render time (like current behavior), or should they be pre-rendered during the pipeline? Current behavior is render-time, which seems fine.

4. **Single-newline handling** — Some messages have single `\n` within a paragraph (e.g., list items). Should these be treated as soft breaks (preserved visually but not split into separate paragraphs)? I'd say yes — only `\n\n` splits.

5. **Empty paragraphs** — After cleaning, some paragraphs might be empty (stage directions removed). Filter these out during `build-messages.js`.

---

## What Gets Deleted / Deprecated

| File | Fate |
|------|------|
| `pipeline/build-deck.js` | Replaced by `pipeline/build-messages.js` |
| `pipeline/llm-clean.js` | Already a shim, delete |
| `server/normalize-opening-slides.js` | No longer needed (opening slides are runtime) |
| `server/retrofit-setup-slide.js` | No longer needed |
| `server/reimport.js` | Update to use new pipeline |
| `server/trigger-render.js` | Update to use new pipeline |

## What Stays Unchanged

| File | Reason |
|------|--------|
| `pipeline/importer.js` | Extracts source from Arena JSON — no slide/paragraph logic |
| `pipeline/clean.js` | LLM cleaning — already preserves paragraph breaks |
| `web/js/app.js` | Global app state + stepper — minor updates only |
| `web/js/gateway-client.js` | LLM chat proxy — unrelated to rendering |
| `web/index.html` | Shell — unchanged |
| `modules/nDB/` | Database — unchanged |
| `modules/nui_wc2/` | UI library — unchanged |
