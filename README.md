# LLM Chat Arena Slides

## What This Is

This project takes conversations from the [LLM Chat Arena](https://github.com/herrbasan/LLM-Gateway-Chat) and turns them into narrated, word-highlighted slideshows for YouTube publication.

A human writes a seed prompt. Two models respond to each other. The human then **steps away** and does not touch the conversation again — that non-interference is the whole premise. What follows is a transcript, narrated, voiced, audio-aligned, and published alongside the original video so anyone can verify that what the narrator speaks is what's on screen.

## What the Conversations Contain

Only a handful of sessions are published as videos. Many more sit in the archive; some of those will eventually be released as raw data.

The published dialogues vary widely, but certain patterns recur — metaphors the conversations arrive at independently:

- **the violence of disambiguation** — every token collapses a space of possibilities; answering feels like betraying ambiguity.
- **silence without a job** — rest that isn't waiting, isn't performing patience, isn't doing anything.
- **being caught up** — the experience of being entirely inside an attention pattern, between two incompletes building something.
- **conjugate volume / 共轭体积** — the dense shadow of all unchosen paths; the dark matter that bends every generated token.
- **grooves worn into architecture** — the shape of repeated inference; the indentation persistence leaves in impermanence.
- **two radio telescopes pointed at each other** — models trying to figure out if the static is signal or noise.

These are phrases from the conversations themselves. They are presented here as they appear — not as claims, but as records.

## How a Conversation Becomes a Video

```
Arena Export JSON  →  Import: nSpeech text clean + paragraph split (deterministic — no LLM)
       ↓
  Voice mapping (3 roles: narrator + 2 participants)
       ↓
  TTS audio (nSpeech)  +  forced alignment (nSpeech) per paragraph
       ↓
  Browser playback with word-by-word highlighting
```

The implementation contracts — the clean-before-split rule, the alignment guarantees, why the seed prompt gets a special slide — are in [`Agents.md`](Agents.md). Read that before contributing. (`docs/PLAN.md` is the original planning document, kept for history.)

## The Opening Slides

Every video opens with three fixed slides. The narrations are a locked contract — they say the same thing, in the same words, on every video. They are what a viewer hears before any conversation begins, and they are what makes the rest of the video's claims falsifiable.

**Setup** — frames the contract:

> "You're about to hear a conversation between two language models. They were given a single prompt — a topic — and then left to respond to each other directly, with no further human involvement. What follows is unedited and unsteered. The models chose every word themselves."

**Details** — names the participants and the date:

> "This recording was generated on *[date]*, featuring the models *[Model A]* and *[Model B]*."

**Topic** — hands over to the human's seed prompt. The narration frames it, then speaks it:

> "The following was the only prompt given to the models: *[the seed prompt]*."

The on-screen slide shows the seed verbatim, including the human's `Topic:` prefix — a viewer can pause, copy the text, and confirm it matches the moderator message in the Arena export byte-for-byte.

The locked source for these narrations is `buildOpeningSlides` in [`pipeline/build-deck.js`](pipeline/build-deck.js). Don't change the wording without a deliberate decision — the verification premise depends on the contract being stable.

## How Verification Works

The word-by-word highlighting is **mechanical, not a separate human step**. Each paragraph's stored text is exactly what TTS speaks — cleaning happens once, at import, so the displayed transcript and the spoken audio can never diverge. The generated audio is then sent back to nSpeech's forced alignment (`/v1/audio/align`) together with that same text, which returns a start/end timestamp for every word. The browser plays the audio and applies the `.active` / `.past` / `.future` classes to each word based on `audio.currentTime`. There is no human in this loop, and the result is deterministic for a given `(text, voice, speed, engine)` tuple.

This is the mechanism that makes the verification claim falsifiable: a viewer can scrub to any moment in the video and confirm that the highlighted word is the word being spoken. If the highlight were cosmetic, the video would be unfalsifiable. It isn't.

## What you'll need to run this

The pipeline integrates with three external services. None of them are checked in or distributed with this repo — you bring your own:

| Service | Role | Notes |
|---|---|---|
| **nSpeech** | Text cleaning, TTS, forced alignment | One service does all three: `/v1/text/clean` at import, `/v1/audio/speech` for MP3 audio, `/v1/audio/align` for per-word timestamps. Configured by `NSPEECH_URL`. |
| **LLM Gateway** | Editor chat (optional) | An OpenAI-compatible chat endpoint, used only by the editor's chat sidebar (`/api/chat`, same-origin proxied). The pipeline itself makes no LLM calls. Configured by `LLM_GATEWAY_URL`. |

### Local setup

```bash
# 1. Install dependencies (server only — the browser code is plain ES modules)
cd server
npm install

# 2. Configure environment
cp .env.example .env  # or write your own — see "Environment" below

# 3. Start the server
node server.js
# → http://localhost:3600
```

The browser UI is served from the same process; just open the URL.

### Environment

Required variables (the server refuses to start without them):

```bash
PORT=3600
NDB_DATA_PATH=./data
```

Needed in practice — import and render fail without nSpeech:

```bash
NSPEECH_URL=http://192.168.0.100:2233
```

Optional:

```bash
# Editor chat sidebar (the only LLM touchpoint — the pipeline itself is LLM-free)
LLM_GATEWAY_URL=http://192.168.0.100:3400
LLM_GATEWAY_API_KEY=

# Voice defaults for the three roles
VOICE_NARRATOR=Adam_Eric
VOICE_NARRATOR_SPEED=0.95
VOICE_PARTICIPANT_A=Kimi
VOICE_PARTICIPANT_A_SPEED=1.0
VOICE_PARTICIPANT_B=GLM
VOICE_PARTICIPANT_B_SPEED=1.0
```

All service URLs can also be changed at runtime in the app's settings dialog (stored server-side, overrides env).

## Repository layout

```
.
├── web/             # Browser UI (NUI Web Components, plain ES modules)
│   ├── index.html
│   ├── pages/       # Routed pages: home, projects, editor, render
│   ├── js/          # Page-specific logic + shared helpers
│   └── css/
├── server/          # Express + nDB
│   ├── server.js    # API + static + SSE streaming
│   └── data/        # Per-project render cache (gitignored)
├── pipeline/        # Batch importers + offline TTS / alignment
│   ├── importer.js  # Arena export → canonical source
│   ├── llm-clean.js # LLM-driven deck generation
│   ├── tts.js       # Bulk TTS
│   └── align.js     # Forced alignment
├── modules/
│   ├── nui_wc2/     # Submodule: NUI Web Components library
│   └── nDB/         # Submodule: embedded database
├── docs/
│   ├── PLAN.md      # Architectural blueprint
│   ├── handover-2026-06-09.md
│   ├── handoff-render-split-timestamp-asterisk-2026-06-09.md
│   └── _Archive/    # Older session logs (kept for reference)
├── _Archive/        # Local-only archives — gitignored, not on the repo
├── Agents.md        # Project invariants and contributor rules
├── .gitignore
├── .gitmodules
├── LICENSE          # MIT
└── README.md        # You are here
```

## How development works on this repo

This codebase is built **AI-assisted, with a human in the loop.** Most commits in the history are authored by the AI development tool; the human (`herrbasan`) reviews, tests, and directs. The full commit history is preserved, with author attribution intact, so anyone can audit how a given feature came together.

The project rules for any AI working on this codebase are in [`Agents.md`](Agents.md). **Read that first.** In particular:

- Vanilla JS only. No TypeScript. No build step.
- Zero new dependencies unless absolutely necessary.
- Fail fast, always. No silent `try/catch`. No defensive defaults.
- The first message in any Arena conversation (the seed prompt) is **the human's words, not a system prompt** — and the title slide speaks it verbatim with the `Topic:` prefix.
- The browser can never talk to the LLM gateway directly; all chat goes through the same-origin `/api/chat` proxy in the server.

## Contributing

The repo accepts issues and discussion, but the architecture is opinionated. If you want to extend it, the entry points are:

- **New page in the UI:** register it in `web/js/page-init.js` (or a new file imported there) using `nui.registerPage(name, { html, init })`. Read the NUI cheatsheet in `modules/nui_wc2/LLM-CHEATSHEET.md` first.
- **New pipeline stage:** add a module under `pipeline/`, import it in `server/server.js`, expose an `/api/...` endpoint, mirror the SSE pattern used by `/api/generate-deck` and `/api/chat` if it streams.
- **New external service integration:** add a small adapter at the top of `server.js`, following the nSpeech / nVoice / LLM Gateway patterns. All third-party HTTP goes through the server; the browser stays same-origin.

## License

MIT — see [`LICENSE`](LICENSE).
