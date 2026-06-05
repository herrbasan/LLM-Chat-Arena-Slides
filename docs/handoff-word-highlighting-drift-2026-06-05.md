# Handoff: Word Highlighting Drift — June 5, 2026

**Status:** Broken at a fundamental level. Stop here, let a fresh session investigate.

---

## What Works

- nVoice `/align` endpoint is healthy at `https://192.168.0.100:2244` (production, self-signed cert)
- All 17 slides have TTS audio cached (see `server/data/render_cache/slideshow_R0QnIVeH5mMNRM2C/`)
- Per-slide render buttons exist in the render page UI
- Render-all shows live per-slide status badges
- `buildWordSpans` in `web/js/pages/render.js` is the simple 1:1 index-based version (ported from working `/client/playback.html`)

## What's Broken

**Word highlighting drifts.** The alignment starts well but timing accumulates error, and the drift carries over between segments. Individual words highlight at the wrong time.

## Root Cause Hypothesis

nVoice's `/align` endpoint splits words differently than `text.split(/\s+/)`:

```
Source text: "inter-LLM" (1 word)
nVoice:      "inter" + "-LLM" (2 words)
```

`alignWordsToSource()` in `pipeline/align.js` tries fuzzy walk-forward rematching, but:
- A single mismatch at word 6 cascades to word 200
- Interpolated timings for skipped words don't match real audio
- The rematching algorithm itself may have bugs

The working `/client/playback.html` used nVoice's **old `/transcribe` endpoint** with `context_text` parameter, which produced much better 1:1 word alignment. The new `/align` endpoint doesn't have this option.

## Key Files

| File | Role |
|------|------|
| `server/server.js:415-500` | `alignSingleSlide()` — calls nVoice `/align`, then `alignWordsToSource()` to rematch |
| `pipeline/align.js` | `alignWordsToSource()` — fuzzy word matcher, source of the drift |
| `web/js/pages/render.js:213-232` | `buildWordSpans()` — simple 1:1 index match (same as `/client`) |
| `client/playback.html:432-460` | **Working reference** — `buildWordSpans()` + `updateWordHighlight()` that worked |
| `pipeline/output/browser_render/slide_deck_aligned.json` | Example of **perfect** 1:1 alignment from the old pipeline |

## What To Try

1. **Compare old vs new alignment:** Take slide 2. Run old pipeline alignment (`pipeline/output/browser_render/slide_deck_aligned.json`) vs current server alignment (`server/data/render_cache/{id}/deck.json`). See why the old one had perfect 1:1 and the new one doesn't.

2. **Fix `alignWordsToSource` properly** or replace it with a simpler text-normalization approach: normalize both the source text and nVoice words (lowercase, strip punctuation, collapse whitespace), then do strict index matching. If counts still don't match, interpolate the remaining.

3. **Alternative: dump `alignWordsToSource` entirely.** Build timing by linearly interpolating segment boundaries across text words. Not perfect, but predictable and drift-free. The old linear interpolation approach was correct in structure but was thrown away because it "looked robotic" — but that was because it used uniform timing, not because the approach was wrong.

4. **Alternative: try nVoice `/transcribe` endpoint** with `context_text` parameter (the old approach that `/client` used successfully).

## Server State

- Server needs restart: `cd server; node server.js`
- TLS agent: `https.Agent({rejectUnauthorized: false})` required for Node 24 undici fetch to self-signed certs
- nDB uses `improred` persistence (was `Database.open` with `{persistence:'immediate'}`)
- Per-slide render: `POST /api/render-slide/:id/:idx`
- Bulk render: `POST /api/render-deck/:id`
- API merge: `GET /api/projects/:id` merges render cache `deck.json` into response

## Cleanup Done

- `/temp/` directory removed
- Old temp files in `$env:TEMP` cleaned
- `node_modules` not touched
- No `.env` changes
