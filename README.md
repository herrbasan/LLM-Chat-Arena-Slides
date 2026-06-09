# LLM Chat Arena Slides

> A tool for turning [LLM Chat Arena](https://github.com/lm-sys/Chatbot-Arena) conversations into narrated, word-highlighted slideshows — for publication on YouTube and the open web.

## What this is

This project is the production pipeline behind a series of public conversations between two LLMs, captured by LLM Chat Arena, narrated by TTS, and published with **per-word timing** so the listener can follow the audio visually.

The premise: if you can show the transcript, the audio, and the visual word-highlight in lockstep, a viewer can verify that the conversation is what it claims to be — **two models, responding to each other, no human in the loop**. Skeptics can scrub through the video and confirm that what the narrator speaks is what's on screen, and what's on screen is the raw export from the Arena.

The full unmodified transcript for every published conversation is published alongside the video.

## How a conversation becomes a video

```
Arena Export JSON  →  Import & parse  →  LLM cleans text for TTS
       ↓
  Voice mapping (3 roles: narrator + 2 participants)
       ↓
  TTS audio (nSpeech)  +  Forced alignment (nVoice) per slide
       ↓
  Browser playback with word-by-word highlighting
```

The detailed architecture is in [`docs/PLAN.md`](docs/PLAN.md). The implementation contracts — how alignment is cached, what the `*emphasis*` handling rules are, why the seed prompt gets a special header — are in [`Agents.md`](Agents.md). Read that before contributing.

## What you'll need to run this

The pipeline integrates with three external services. None of them are checked in or distributed with this repo — you bring your own:

| Service | Role | Notes |
|---|---|---|
| **nSpeech** | TTS generation | The local nSpeech instance returns MP3 audio for a given text + voice. Configured by `NSPEECH_URL`. |
| **nVoice** | Forced alignment | Given an MP3 + the original text, nVoice returns per-word start/end timestamps. Configured by `NVOICE_URL`. |
| **LLM Gateway** | Narration generation + editor chat | An OpenAI-compatible chat endpoint. Used by the bulk deck generator (`/api/generate-deck`) and by the editor's chat sidebar (`/api/chat`, same-origin proxied). Configured by `LLM_GATEWAY_URL`. |

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

Required variables (the server refuses to start if any are missing):

```bash
PORT=3600
LLM_GATEWAY_URL=http://192.168.0.100:3400
NSPEECH_URL=http://192.168.0.145:2233
NVOICE_URL=https://127.0.0.1:2244
NDB_DATA_PATH=./data
```

Optional:

```bash
# Bearer token forwarded to the LLM gateway, if your gateway requires auth
LLM_GATEWAY_API_KEY=

# Voice defaults for the three roles
VOICE_NARRATOR=Adam_Eric
VOICE_NARRATOR_SPEED=0.95
VOICE_PARTICIPANT_A=Kimi
VOICE_PARTICIPANT_A_SPEED=1.0
VOICE_PARTICIPANT_B=GLM
VOICE_PARTICIPANT_B_SPEED=1.0

# Self-signed certs for internal services (nVoice)
NODE_TLS_REJECT_UNAUTHORIZED=0
```

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
