# Handoff — 2026-08-23 (static export / web-export milestone)

Fully committed and pushed. Repo is clean at `36b1312` on `master` (origin synced).
Everything below was verified end-to-end this session.

## What the product is

This app is an **internal tool that produces videos + static web exports**.
It is NOT hosted. It takes Arena conversations, renders them to narrated,
word-aligned slideshows (TTS via nSpeech, alignment via nSpeech), and exports
them as a fully static, self-contained web player.

## The deployment model (web-export/)

One deployable unit that you sync to any static host:

```
web-export/
├── index.html          ← generated listing (gitignored, refreshed per export)
├── player/             ← the player SOURCE (tracked in git — refine here)
│   ├── index.html
│   ├── player.js
│   ├── player.css
│   └── nui/            ← vendored NUI runtime (refresh by re-copying from modules/nui_wc2)
└── convos/             ← baked artifacts (gitignored)
    ├── the-ache-is-real/    project.json + transcript.md + audio/*.mp3
    └── the-parking-lot/
```

Links are relative: `player/?src=../convos/{slug}/`. The listing links every
conversation automatically, so no URL fiddling.

## How to produce an export

```
node pipeline/export.js <projectId> [outputRoot]
```

- Default output root: `web-export/convos/`.
- Reads a v3 project from nDB, bakes `project.json` + `transcript.md`
  (UTF-8 BOM) + `audio/*.mp3`, rewritten to relative paths.
- Fails loud (throws) if any speakable paragraph lacks audio or alignment.
- Regenerates `web-export/index.html` on every run (newest first, with
  title/date/models/turns/minutes).

## The player

Static page porting the v3 playback core from `web/js/pages/render.js`:
virtual slide chunking (~600 chars), per-paragraph audio chaining, rAF
word highlighting, seekable `nui-slider` playhead, auto-advance, keyboard
nav, buffering `nui-loading`. Vendored NUI (button/icon/slider/loading +
theme + icon sprite). Note: the export player drops the speed selector
(rate fixed at 1.0). Locally the app serves it at `/player/` and convos at
`/exports/` for convenience, but playback spins up from any static server.

## Two fully rendered conversations (in nDB)

| Project ID | Topic | msgs | paras | engine |
|---|---|---|---|---|
| `slideshow_IRTOhiPEsa6tpWSg` | The Parking Lot | 44 | 258 | F5 |
| `slideshow_VINPE0IDsfWe2Swl` | The Ache Is Real | 19 | 158 | F5 |

Voice guidance: **MiniMax = production quality** (cheap, good). **F5 = free
iteration/review** (artifacts on short segments, odd pronunciations — not
publishable). Switch is a voice-panel change; hashes invalidate and
Render All re-renders.

## Key contracts to remember

- **Clean-before-split:** nSpeech `/v1/text/clean` runs per message BEFORE
  paragraph splitting. Stored paragraph text IS the spoken text. Render
  (batch + single-paragraph), alignment, and browser freshness all hash
  `paragraph.text` verbatim — no code path re-cleans.
- **No LLM in the pipeline.** The LLM clean machinery was removed
  (`2e1414a`) because it silently rewrote model output, violating the
  "unedited and unsteered" contract. Stage directions (`settles into the
  conversation.`) are spoken — the model wrote them, they belong.
- **Unspeakable paragraphs** (fails `/[\\p{L}\\p{N}]/u`, e.g. `---`
  dividers) are skipped everywhere: dropped at import, skipped at render
  and by status. Never sent to TTS (nSpeech 400s on empty).
- **Editor edits** re-cleaned via `POST /api/v3/clean-text` before save.
- **Topic slide** narration: `The following was the only prompt given to
  the models: <seed>`; on-screen text keeps the `Topic:` prefix verbatim.
- **Speakability is the guard** against the old stale-status bug.

## Known gotchas / open items

- **nSpeech engine routing:** model token `'nspeech'` means "whatever the
  dashboard currently has selected" — which can be a CLOUD engine
  (minimax). Local engines stay loaded regardless, but `'nspeech'` doesn't
  mean "local". Consider defaulting `engine` in `voiceMapping` explicitly.
- **nSpeech returns HTTP 200 + 0 bytes** for unknown voice ids
  (herrbasan/nSpeech#1). Both render paths guard against it; if TTS
  "succeeds" with no audio, check the voice id.
- **dotenv resolution:** pipeline scripts must `require` dotenv via
  `../server/node_modules/dotenv` (no `node_modules` at repo root).
- **Time/duration source:** `durationMs` per paragraph is the real MP3
  length (`mp3DurationMs`), not last-word-end.
- **`build-deck.js` date ordinals** fixed (`da7b070`): "twenty-third", not
  "twenty-threeth".
