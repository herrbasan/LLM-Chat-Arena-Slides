# Handoff: Word Highlighting Not Working in Render Page

**Date:** 2026-06-04  
**Status:** Alignment data present, highlighting silent. Audio plays, words stay `.future`.

---

## What Was Done

- Fixed 7 known issues from `docs/session-progress-2026-06-04.md`.
- Fixed icon rendering (only `delete` worked — replaced invalid Material Icon names).
- Fixed TTS streaming preview (switched to server-piped streaming response).
- Ran nVoice alignment via standalone script — **all 17 slides now have word timings**.

## Current Problem

**Word highlighting is NOT working.** Audio plays, text renders, but all words stay in their default `.future` state. No words get `.active` or `.past` classes.

## Alignment Data Status

- ✅ Present in `server/data/render_cache/{projectId}/deck.json`
- ✅ nVoice `/align` returns `segments[].words[]` correctly
- ✅ `alignSingleSlide()` in `server.js` parses this into `tts.words[]` with `startMs`/`endMs`
- ❓ Unknown: whether `GET /api/projects/{id}` returns the `tts.words` array to the client
- ❓ Unknown: whether `render.js` passes those words into `buildWordSpans()`
- ❓ Unknown: whether `data-start`/`data-end` attributes are on the DOM
- ❓ Unknown: whether `updateWordHighlight()` fires during playback

## Files Involved

| File | Role |
|------|------|
| `server/server.js` | `/api/render-deck/:id` — renders TTS, runs alignment, persists deck |
| `web/js/pages/render.js` | `buildWordSpans()`, `updateWordHighlight()`, `animationLoop()` |
| `web/css/main.css` | `.word.active`, `.word.past`, `.word.future` styles |
| `client/playback.html` | **Working reference** — original implementation that worked |

## Server Fixes Already Applied

1. **Health check** → uses `process.env.NVOICE_URL` (root `/`), not `/health` (nVoice returns 404 on `/health`)
2. **audioPath reconstruction** → client deck has `audioUrl` but not `audioPath`; server rebuilds it before alignment
3. **segments parsing** → `alignSingleSlide()` extracts words from `data.segments[].words[]`
4. **Alignment runs on cached slides too** → changed condition from `slide.tts.cached` to `!slide.tts.words`

## What To Check Next (in order)

1. **API Response:** Does `GET /api/projects/{id}` include `tts.words`?
2. **buildWordSpans:** Does `render.js` pass `slide.tts.words` into `buildWordSpans()`?
3. **DOM Attributes:** Do rendered `.word` spans have `data-start` and `data-end`?
4. **Highlight Loop:** Is `updateWordHighlight()` called from `requestAnimationFrame`?
5. **CSS:** Are `.word.active` and `.word.past` styles applied and visible?

## Known Working Reference

`client/playback.html` has a working `buildWordSpans()` and `updateWordHighlight()` that correctly highlight words when timing data is present. The render page was modeled after this but may have diverged.

## Key Difference

`client/playback.html` loads from a local JSON file where `tts.words` is already populated. The web app's render page fetches from `/api/projects/{id}` — the words may be stripped or not included in that response.

---

*Last updated: 2026-06-04. Alignment data is in the cache; the gap is between the API and the DOM.*
