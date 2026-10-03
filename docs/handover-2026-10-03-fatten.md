# Handover — 2026-10-03 (evening session, Badkid → Fatten move)

For the next session on Fatten. Everything below is verified state, not intent.

## What this session did (all verified, uncommitted at handover time)

1. **Setup preamble settled, 3rd pass wins.** After verbose → compact → minimal,
   David chose the original single sentence, verbatim, nothing else:
   > "You're about to hear a conversation between two language models. They were given a single prompt — a topic — and then left to respond to each other directly, with no further human involvement."
   Landed in 4 spots: `pipeline/build-deck.js` (template), `web/js/pages/render.js`
   (browser fallback), `server/migrate-setup-narration.js` (exact-match idempotency
   now — every generation shares phrases), `README.md` quote.
   All 9 decks migrated; 6 with audio re-rendered (34 words each); both baked
   exports re-baked.

2. **Importer gate bug fixed** (`pipeline/build-messages.js`): the gate treated
   moderator-less RAW exports as pre-parsed sources. Gateway-chat dumps (model-name
   speakers, no session wrapper) skipped the importer → participants `[]`, every
   turn collapsed onto `participantA`. Fix: route through importer unless input has
   the parsed-source marker (`seedPrompt` set or `.source` present). The importer
   itself derives participants from speakers.

3. **Canonical source set discovered**: `storage/arena-publication/sessions/landmark/`
   (MCP storage) — 9 chat-export JSONs. **Filename slugs are the canonical titles**
   (proof: 91's internal `session.title` is the raw topic prompt, yet the file is
   named `the-traversal-and-the-map`). All 9 stored decks now verify 1:1 against
   them. Two were repaired (zero audio on both, verified before writing — David's
   hard rule: never invalidate rendered audio):
   - `slideshow_XOAjsiXuLwjEJgUU` = `50-ghost-debating-its-own-existence` → topic
     "Ghost Debating Its Own Existence", real date 2026-05-22 (from sid
     `chat_1779427599151_k3s8rpfx`), glm5-chat vs al-kimi-chat, ABAB voices restored.
     Genuinely seedless (no moderator in source) BUT `session.title` carries the
     human's topic → topic slide EXISTS with honest narration:
     "The models were given the topic: AI Consciousness: Simulation versus Suffering"
   - `slideshow_nOv2N7Oy0MaBaVGb` → topic cleaned to "The Traversal and the Map".

4. **Topic-slide contract** (`buildOpeningSlides` in build-deck.js), 3-way now:
   seed → verbatim slide ("the only prompt given…"); no seed but
   `source.sessionTitle` → topic slide with honest narration (never claim "only
   prompt"); neither → no slide. `sessionTitle` flows through importer
   (parseChatExport), passthrough guard, and buildProject's source rebuild.

5. **TTS language hint**: `extra_body: { language: 'en' }` now sent in
   `server/nspeech.js` (all 5 server TTS paths) and `pipeline/tts.js`. ISO-639-1
   hint; engines ignore silently. NOT in the freshness hash (text+engine+voice+
   speed) → nothing invalidated, paragraphs rendered before the hint just won't
   re-render on their own. Requires server restart to take effect.

6. **All 9 conversations are fully rendered** (per David, end of session).

## Tree state at handover

Modified: `README.md`, `pipeline/build-deck.js`, `pipeline/build-messages.js`,
`pipeline/importer.js`, `pipeline/tts.js`, `server/migrate-setup-narration.js`,
`server/nspeech.js`, `web/js/pages/render.js`.
New: `server/repair-untitled-deck.js`, `server/repair-landmark-titles.js`,
`server/repair-ghost-topic-slide.js` (one-offs, keep for history).
Untracked, NOT part of this work — recording-arc leftovers:
`docs/RECORDING-STATE.md`, `tools/` (harness was archived to
`D:\Work\_GIT\screen-record\_Archive/`; these two look like stragglers —
check before committing).

## The Fatten plan (decided in conversation, nothing executed)

Goal: unattended overnight recording of all decks; move project + development to
Fatten. Decisions:

- **CPU-only encode experiment first.** Static slides make x264 cheap (skip-blocks,
  CRF → ~1–2 GB/h). Bench: clone `D:\Work\_GIT\screen-record` to Fatten, play a real
  deck, measure encode-time-per-frame p50/p95/max. Pass = p95 < ~10ms
  (budget 16.6ms @ 60fps). Run the bench WITH embeddings active — overnight is
  exactly when the embed queue has work.
- **Fatten still needs a 4K surface**: ~10€ HDMI dummy plug (or virtual display
  driver). CPU-only removes the encoder requirement, not the display requirement.
- **WIZKID is out** (David's music PC, 3 displays, none 4K, not touching it —
  despite having an ARC A770). Badkid stays the lab server, never the recorder.
- Fatten telemetry caution: CPU 82.6°C @ 99.7W while embedding (single-process
  scaled reading); 3 small/old SSDs (fullest 70%); VRAM-corruption history —
  embeddings pause during recording windows if GPU encode ever enters the picture.
- After the move, **Fatten's DB copy is canonical**; Badkid's copy must not diverge
  (append-only JSONL in two places = one source of truth). Retire or freeze the
  Badkid copy consciously.
- Audio during recording: WASAPI loopback of pre-rendered playback — any box.
- Missing piece to build: **queue runner** (browser autostart in recording mode,
  auto-advance through decks, watchdog: frame drops / capture death / missing
  audio, retry + log). `record-deck.js` start point is archived in screen-record's
  `_Archive/`. Recording mode exists in the app: `enterRecordingMode()` in
  `web/js/pages/render.js` (`body.render-recording`, fullscreen, fitSlideToWidth).
  Record the app's render page (port 3600), NOT web-export/player/.
- Playback needs no nSpeech (audio pre-rendered) → Fatten is self-contained
  overnight; nSpeech only needed for future re-renders (LAN-reachable anyway).

## Session-start checklist for Fatten

1. Priming: `memory.overview` (this session's memories: #4797 preamble arc,
   #4910 landmark/importer/ghost-deck thread — both carry full detail).
2. Repo + submodules: `git clone` (origin: herrbasan/LLM-Chat-Arena-Slides) +
   `git submodule update --init`. Never `--remote` (detaches); fetch + ff-only.
3. Copy `server/data/slideshows.jsonl` (~226MB) + `server/data/_files/` (audio
   bucket) from Badkid — NOT in git. nDB v1.5.0, win32-x64 binary committed in
   submodule. `.env` also not in git — copy `server/.env` (NSPEECH_URL etc.).
4. `node server/server.js` from `server/` → http://localhost:3600. Local app —
   restart freely (the no-restart rule covers lab services, not this).
5. Verify: 9 projects listed, titles match the landmark set, ghost deck has
   setup→details→topic→conversation flow.
