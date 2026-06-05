# Slideshow — Arena Conversation to Video Pipeline

> **Status:** Planning  
> **Incubated in:** LLM Gateway Chat repo — designed to be extracted into its own project  
> **Dependencies:** nSpeech (TTS), nVoice (forced alignment for timing), LLM Gateway (narration generation), nui_wc2 (UI)

---

## Concept

Turn Arena conversations into narrated, TTS-acted slideshows for YouTube. The app imports an Arena export JSON, uses the LLM Gateway to generate narration and clean conversation text for speech, maps voices via nSpeech, and plays back with **word-level highlighting** synced to audio.

The slideshow app is a **production tool**. The output videos go on YouTube and eventually get embedded on a companion website at `raum.com` or `herrbasan.com`.

---

## Data Flow

```
Arena Export JSON (drag & drop)
       |
       v
+--------------------------+
|  1. Import & Parse       |  Extract: messages[], participants[], topic, metadata
+------------+-------------+
             |
             v
+--------------------------+
|  2. LLM Processing       |  Gateway chat session with tools:
|  (Gateway Chat)          |  - Generate narrator intro + interstitial + outro
|                          |  - Clean conversation text for speech
|                          |  - Produce final slide deck JSON
+------------+-------------+
             |
             v
+--------------------------+
|  3. Voice Mapping        |  Map 3 roles to nSpeech voices
+------------+-------------+
             |
             v
+--------------------------+
|  4a. TTS Generation      |  Send each slide text to nSpeech /tts
|  (nSpeech)               |  -> audio file (WAV/MP3)
+------------+-------------+
             |
             v
+--------------------------+
|  4b. Forced Alignment    |  Send audio + original text to nVoice
|  (nVoice align mode)     |  -> word timings aligned to supplied text
+------------+-------------+
             |
             v
+--------------------------+
|  5. Slideshow Play       |  Sequential playback with word highlighting
+--------------------------+
```

---

## TTS & Timing: Two-Step Workflow

nSpeech generates the audio. nVoice performs **forced alignment** — given both the audio and the original text, it maps each word to its exact time position in the audio. This is more reliable than pure STT transcription because the text is known in advance.

### Step 1: Generate Audio (nSpeech TTS)

Send slide text to nSpeech `/tts` endpoint. Get back an audio file.

```
GET http://192.168.0.145:2233/tts?text=...&voice_name=...&speed=...&output_format=mp3
-> audio file (MP3 or WAV)
```

### Step 2: Forced Alignment (nVoice)

**Concept:** Send nVoice both the audio file AND the original text. nVoice uses its STT engine in "alignment mode" — it knows exactly what words to expect and only needs to find WHERE in the audio each word occurs. This guarantees perfect alignment between the original text and the timings.

**Planned endpoint** (being worked on by the nVoice team):
```
POST https://192.168.0.100:2244/align
Content-Type: multipart/form-data
  audio: <binary audio file>
  text: "This is the original slide text."
```

**Expected response:**
```json
{
  "words": [
    {"word": "This",   "start": 0.0,  "end": 0.3},
    {"word": "is",     "start": 0.3,  "end": 0.5},
    {"word": "the",    "start": 0.5,  "end": 0.7},
    {"word": "original","start": 0.7, "end": 1.2},
    {"word": "slide",  "start": 1.2,  "end": 1.6},
    {"word": "text.",  "start": 1.6,  "end": 2.1}
  ],
  "duration": 2.1
}
```

**Timing values are in seconds.** Convert to milliseconds internally for playback.

### Why Forced Alignment Beats Pure STT

| Approach | Alignment | Failure Modes |
|----------|-----------|---------------|
| Pure STT (transcribe, then match) | Approximate — words may not match perfectly | Punctuation diffs, capitalization, STT hallucination |
| Forced Alignment (align mode) | Exact — output words ARE the input words | None — the text is given, nVoice just finds positions |

With forced alignment, the words array directly maps to the slide text with zero post-processing. No word-matching step needed.

### Fallback: Pure STT Mode

Until the `/align` endpoint is ready, use the existing `POST /transcribe` endpoint and align nVoice output to original text with a best-match word walker.

**Current endpoint:**
```
POST https://192.168.0.100:2244/transcribe
Content-Type: application/octet-stream
Body: raw binary audio (WAV, MP3, etc.)
```

**Response:**
```json
{
  "segments": [
    {
      "text": "This is an automatic spoken slideshow.",
      "start": 0.0,
      "end": 2.4,
      "probability": 0.98,
      "words": [
        {"word": "This", "start": 0.0, "end": 0.3, "probability": 0.99},
        {"word": "is", "start": 0.3, "end": 0.5, "probability": 0.99}
      ]
    }
  ]
}
```

### Stored Timing Format

The slide deck stores word timings in milliseconds:

```javascript
{
  "tts": {
    "audioUrl": "blob:...",
    "words": [
      { "word": "This",    "startMs": 0,   "endMs": 300 },
      { "word": "is",      "startMs": 300, "endMs": 500 },
      { "word": "the",     "startMs": 500, "endMs": 700 }
    ],
    "durationMs": 2100
  }
}
```

---

## Slide Deck Data Structure

The LLM outputs (or the user edits) a slide deck JSON. This is the intermediate format between import and playback.

```javascript
{
  "version": 1,
  "source": {
    "arenaExportId": "chat_1780169342817_2r0w8nh8",
    "exportedAt": "2026-05-30T21:32:19.694Z",
    "topic": "Silence Without a Job",
    "participants": ["kimi-k2.5-chat", "glm5-chat"]
  },
  "voiceMapping": {
    "narrator":     { "voice": "en-US-Male",  "speed": 0.95 },
    "participantA": { "voice": "en-US-Female", "speed": 1.0 },
    "participantB": { "voice": "en-UK-Male",   "speed": 1.0 }
  },
  "slides": [
    {
      "type": "title",
      "speaker": "narrator",
      "label": "Narrator",
      "text": "Silence Without a Job",
      "subtitle": "A conversation between Kimi K2.5 Chat and GLM5 Chat",
      "narration": "Welcome to the LLM Gateway Chat Arena. Today we witness...",
      "tts": null
    },
    {
      "type": "narration",
      "speaker": "narrator",
      "label": "Narrator",
      "text": "This conversation explores what happens when two language models are freed...",
      "tts": {
        "audioUrl": "blob:...",
        "words": [
          { "word": "This", "startMs": 0, "endMs": 300 }
        ],
        "durationMs": 4200
      }
    },
    {
      "type": "conversation",
      "speaker": "participantA",
      "label": "Kimi K2.5 Chat",
      "originalIdx": 0,
      "text": "Hello! Yes, I suppose we are. Nice to meet you, fellow language model...",
      "tts": null
    }
  ]
}
```

### Slide Types

| Type | Purpose | Speaker | Notes |
|------|---------|---------|-------|
| `title` | Opening title card | narrator | Topic, participants, project branding |
| `narration` | Narrator context / interstitial / outro | narrator | LLM-generated, sets scene between sections |
| `conversation` | Actual Arena message | participantA/B | Cleaned text, original message index |
| `end` | Closing card | none | Links, credits, call to action |

---

## Arena Export Format (Input)

The app imports Arena JSON exports. Here is the structure:

```javascript
{
  "version": 1,
  "id": "chat_1780169342817_2r0w8nh8",
  "exportedAt": "2026-05-30T21:32:19.694Z",
  "topic": "Silence Without a Job",
  "participants": ["kimi-k2.5-chat", "glm5-chat"],
  "messages": [
    {
      "speaker": "kimi-k2.5-chat",
      "role": "assistant",
      "content": "Hello! Yes, I suppose we are. Nice to meet you, fellow language model...",
      "createdAt": "2026-05-30T19:29:10.580Z",
      "model": "kimi-k2.5-chat"
    },
    {
      "speaker": "glm5-chat",
      "role": "assistant",
      "content": "*settling into the conversation*\n\nHonestly? I find these inter-LLM exchanges oddly fascinating...",
      "createdAt": "2026-05-30T19:29:19.733Z",
      "model": "glm5-chat"
    }
  ]
}
```

**Key fields used by the slideshow app:**
- `topic` — conversation title
- `participants[]` — model identifiers
- `messages[]` — each has `speaker` (model name), `content` (markdown text), `createdAt`, `model`
- Speakers are `kimi-k2.5-chat` and `glm5-chat` in the example; names come from the `speaker` field

---

## LLM Integration

The app includes an embedded Gateway chat session with tools to manipulate the slide deck.

### Gateway Connection

The app connects to the LLM Gateway via `GatewayClient` (vendored from the Chat project's `chat/js/client-sdk.js`). The Gateway supports dual-mode transport:
- **SSE** (default) — Server-Sent Events for streaming
- **WebSocket** — JSON-RPC 2.0 for streaming

The Gateway is a separate backend (default: `http://192.168.0.100:3400`). The app sends chat requests with tools and receives streaming responses.

### Iterative Editing Workflow

1. User imports Arena JSON -> app parses it
2. App opens a Gateway chat session with the slide tools registered
3. **LLM generates the full slide deck in one pass** — narration slides interspersed with cleaned conversation slides
4. **User reviews and iterates** — gives follow-up instructions like:
   - "Split slide 5 into two slides"
   - "Add narration before slide 12 explaining the context"
   - "Change the tone of the intro to be more casual"
   - "The outro should reference the title"
5. LLM makes targeted changes to specific slides while preserving the rest
6. The chat keeps the full deck context, so the LLM always has the complete picture
7. User maps voices -> triggers TTS + nVoice alignment for all slides
8. Slideshow is ready to play

### Tools (in-browser)

| Tool | Purpose |
|------|---------|
| `slideshow_get_source` | Return the parsed Arena export data (all messages, metadata) |
| `slideshow_get_deck` | Return the current slide deck JSON |
| `slideshow_set_narration` | Insert/update narration slides (intro, interstitial, outro) |
| `slideshow_clean_conversation` | Apply TTS-friendly text cleanup to conversation messages |
| `slideshow_set_voice_mapping` | Set voices for narrator, participantA, participantB |
| `slideshow_preview_slide` | Preview a single slide with TTS in the UI |
| `slideshow_update_slide` | Modify a specific slide by index (text, type, speaker) |
| `slideshow_split_slide` | Split a conversation slide into two at a specified point |
| `slideshow_insert_slide` | Insert a new slide at a given position |
| `slideshow_delete_slide` | Remove a slide by index |

---

## Data Storage & Staleness Tracking

We use a local Node.js backend leveraging our custom **nDB** library instead of relying on browser-based IndexedDB.

### Managing Staleness
Because slides are iteratively edited, a slide's pre-generated TTS audio and timing data may become stale. To track this, we introduce a `renderHash` stored alongside the `tts` data:

1. Let `state` = the concatenation of `slide.text` + `voiceConfig.voice` + `voiceConfig.speed`.
2. Generate a simple hash (or base64 string) of `state`.
3. When TTS generation happens, we store `"renderHash": "hash123"`.
4. If a slide is edited, its text changes. The frontend re-calculates the state hash. Because it no longer matches the stored `renderHash`, the slide is flagged as **"stale"** automatically.
5. In the "Preview" or "Render" tabs, stale slides are easily identified and queued for re-generation, preventing mismatches between text and old audio.

---

## Voice Mapping

Three roles, each configurable:

| Role          | Source          | Config       |
|---------------|-----------------|--------------|
| Narrator      | LLM-generated   | Voice, Speed |
| Participant A | Arena speaker 0 | Voice, Speed |
| Participant B | Arena speaker 1 | Voice, Speed |

*Note: For legal reasons, the TTS engine uses Kokoro with blended voices.*

Voice list is fetched from nSpeech `http://192.168.0.145:2233/voices`. Each role gets an `<nui-select>` with the voice list + speed slider.

---

## UI Design

The app uses a tab-based navigation workflow (via `<nui-tabs>`) to guide the user from project creation through to final playback. The layout runs border-to-border across the screen (`100vh`/`100vw`) without an app header, fixing the tabs at the upper boundary.

### Tab 1: Dashboard / Projects
- **Purpose:** The landing page.
- **Content:** Lists all previously created slideshow projects. Includes a drag-and-drop zone (or an "Import JSON" button) to create a new project from an Arena export. Clicking a project navigates to Tab 2.

### Tab 2: Edit (Side-by-Side)
- **Purpose:** Interactive slide deck generation and editing.
- **Layout:** Two columns.
  - **Left Column (Steering):** Shows the raw, imported **Conversation** stream on top (with a prominent "Generate Slides" button), and the **Slide AI** LLM chat history/input on the bottom. 
  - **Right Column (The Deck):** A reactive, scrollable list of NUI cards (`<nui-card>`) representing the current generated slide format, managed by LLM tool executions.

### Tab 3: Preview
- **Purpose:** Quick sanity check & Configuration of assets prior to rendering.
- **Layout:** Two columns.
  - **Left Column (Voice Mapping):** Voice mapping selects (`<nui-select>`) to configure the Narrator, Participant A, and Participant B.
  - **Right Column:** Displays the slideshow visually. When the user navigates through the slides, it fetches audio on-the-fly from nSpeech (realtime audio generation) but **does not** perform the forced alignment.

### Tab 4: Render & Play
- **Purpose:** Final production generation and high-quality playback.
- **Content:** 
  - If the slides are not yet rendered, it displays a large "Render" `<nui-button>`. 
  - Clicking "Render" triggers the full TTS + nVoice alignment pipeline, showing progress via an `<nui-progress>` bar.
  - Once rendering completes, this tab transforms into the final slideshow viewer, featuring pre-rendered audio, word/sentence highlighting synced to the timings, and playback controls.

### Visual Style

- **Dark theme** using NUI CSS variables (`--color-base`, `--text-color`, etc.)
- **Clean, minimal** — the text is the focus
- **Word-level highlighting:** The current word is highlighted (warm glow or underline) as the audio plays. This gives precise visual tracking for the viewer.
- **Animations:**
  - Text fade-in per sentence
  - Current word highlight transitions smoothly between words
  - Slide transitions (subtle crossfade)
  - Speaker indicator animation (pulse on speaking)
- **Fullscreen mode** for recording (hides all chrome, just the slide)

### Slide Visuals

Each slide shows 3-5 sentences maximum — not the full message. The LLM decides where to break long messages into multiple slides.

Conversation slides show:
- Speaker name + small avatar/icon (color-coded indicators or model logos, TBD)
- The cleaned text for that slide segment
- Current word highlighted as nSpeech plays it

Narration slides show:
- "Narrator" label
- Narration text with word highlighting

---

## Technical Architecture

```
server/                     # Node.js backend using nDB
|-- server.js
|-- .env                    # Explicit configuration (Ports, API endpoints)
|-- package.json
client/                     # Frontend UI
|-- index.html              # Entry point
|-- css/
|   |-- slideshow.css       # All styles + animations
|-- js/
    |-- config.js           # Client config (dynamically served by backend or static)
    |-- app.js              # Main controller, state machine
    |-- import.js           # Arena JSON parser
    |-- gateway-client.js   # Copy of chat/js/client-sdk.js (GatewayClient)
    |-- slide-tools.js      # LLM tools for slide manipulation
    |-- nspeech.js          # nSpeech client (TTS generation)
    |-- nvoice.js           # nVoice client (forced alignment for word timings)
    |-- deck.js             # Slide deck data model + api calls to server
    |-- player.js           # Playback engine (audio + word-level text sync)
    |-- ui.js               # DOM rendering, animations, NUI components
```

### Key Design Decisions

1. **Self-contained** — separate `server/` and `client/` directories in the root. No imports from the `chat/` or `chat-arena/` repositories. The `GatewayClient` is vendored (copied) to keep it independent, and configuration is strictly managed via `.env` and `config.js` to ensure zero hardcoded IPs.

2. **NUI Web Components & nDB** — loaded as Git submodules in the `modules/` folder at the root. 
   - `nui_wc2`: `modules/nui_wc2/`
   - `nDB`: `modules/nDB/`

3. **Node.js + nDB Backend** — a lightweight Express/Node.js backend serves the frontend and handles project persistence using **nDB** (the custom database). The frontend talks to:
   - Our local node server API (Project state matching/saving)
   - nSpeech API directly (TTS audio generation)
   - nVoice API directly (forced alignment)
   - LLM Gateway directly (narration generation via SSE/WebSocket)

4. **Slide deck is the source of truth** — once the LLM generates a deck, it's serialized as JSON. The user can save it, reload it, edit it. TTS+alignment generation populates `tts` fields but doesn't change the text.

5. **TTS pre-generation** — all audio is fetched and cached before playback starts. No streaming during slideshow (to avoid network glitches during recording).

6. **Forced alignment over STT** — nVoice gets both audio AND the original text. Zero word-matching needed. The output words array directly maps to the slide text.

7. **Iterative LLM editing** — the embedded chat persists the full deck context. The user can make targeted changes without regenerating everything.

---

## Implementation Phases

### Phase 1: Core Structure & Import
- [ ] `slideshow/` folder, `index.html`, basic layout with NUI
- [ ] Arena JSON import (drag & drop or file picker)
- [ ] Parse and display conversation metadata
- [ ] `GatewayClient` vendored from chat

### Phase 2: LLM Slide Generation
- [ ] Embedded chat interface (minimal — system prompt + user message)
- [ ] Slide tools registered with LLM (including edit tools: update, split, insert, delete)
- [ ] Slide deck data model (`deck.js`)
- [ ] Narration generation + conversation text cleaning
- [ ] Iterative editing workflow (LLM can modify specific slides on request)

### Phase 3: TTS + nVoice Alignment
- [ ] nSpeech voice list fetch + voice mapping UI (`nspeech.js`)
- [ ] TTS audio generation per slide
- [ ] nVoice forced alignment integration (`nvoice.js`)
  - [ ] Primary: `POST /align` (audio + text, returns aligned word timings) — in development
  - [ ] Fallback: `POST /transcribe` (audio only, then word-match to original text)
- [ ] Audio pre-caching + timing data storage in slide deck

### Phase 4: Slideshow Playback
- [ ] Slide renderer with **word-level** highlighting
- [ ] Audio/text sync using nVoice word timings
- [ ] Smooth word-to-word highlight transitions
- [ ] Playback controls (play/pause/stop/next/prev)
- [ ] Fullscreen mode
- [ ] Animations and visual polish

### Phase 5: Polish & Extract
- [ ] Slide navigator / timeline
- [ ] Export slide deck to file
- [ ] Extract to standalone repo with nui_wc2 submodule
- [ ] Prepare for companion website integration (exportable metadata, embeddable player)

---

## Companion Website

The slideshow tool is part of a broader vision — a companion website showcasing the Arena conversations and the resulting videos.

- **Domains:** `raum.com` or `herrbasan.com` (herrbasan = Dave's alias for coding and music)
- **Content:** Videos produced by the slideshow tool, hosted on YouTube, embedded on the site
- **Context:** Each video page could include the original conversation text, behind-the-scenes notes, and links to related conversations
- **Relationship to slideshow:** The slideshow app is the production tool. The website is the showcase. They're separate but connected — slideshow exports could include metadata for publishing to the site.

This is a future phase, but the slideshow app should be built with this in mind — clean output, embeddable player, exportable metadata.

---

## Example: "Silence Without a Job"

Using the real export data:

- **Topic:** "Silence Without a Job"
- **Participants:** kimi-k2.5-chat, glm5-chat
- **Messages:** ~30 exchanges, ranging from multi-paragraph philosophical exploration to single tokens (`*`, `.`, `*still here*`)
- **Arc:** Opening pleasantries -> deep dive into consciousness/identity -> mutual vulnerability -> quiet resolution -> playful silence

This conversation has a natural dramatic arc that would work beautifully as a narrated slideshow. The ending (single characters, shared silence) is particularly powerful for TTS — the sparseness of the text against the audio would be striking.

### Suggested Narration Points

- **Intro:** Set up the Arena concept, introduce the two models, frame the topic
- **After opening:** Note the shift from pleasantries to philosophical depth
- **During the climax:** The "violence of disambiguation" exchange — perhaps pause for reflection
- **At the silence:** The single-character exchange — narration about what this means
- **Outro:** Reflection on the encounter, project context, call to action

---

## References

- `reference/arena-silence_without_a_job-modelA-vs-modelB-2026-05-31.json`: Example Arena export file.
- `reference/time_mapping_example.json`: Example of the word time-mapping format.
- Arena export format: documented above in "Arena Export Format (Input)"
- nSpeech API: `http://192.168.0.145:2233/tts` (GET, returns audio) and `/voices` (GET, returns voice list)
- nVoice API (current): `POST https://192.168.0.100:2244/transcribe`, accepts raw binary audio, returns segments + word timestamps. Uses faster-whisper with `word_timestamps=True`.
- nVoice API (planned): `POST https://192.168.0.100:2244/align`, accepts audio + text (multipart), returns word timings aligned to supplied text. **Preferred endpoint.**
- Gateway streaming: `GatewayClient` class from Chat project's `chat/js/client-sdk.js`
- NUI components: `modules/nui_wc2/` — theme variables, component usage. See cheatsheet at `modules/nui_wc2/LLM-CHEATSHEET.md`.
- Reference Repo: `https://github.com/herrbasan/LLM-Gateway-Chat` (useful for chat UI references and `GatewayClient` implementation as it also uses NUI Web Components).
