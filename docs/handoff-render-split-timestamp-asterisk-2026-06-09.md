# Handoff — 2026-06-09 (continuation)
**Session focus:** Re-apply the lost work from `handover-2026-06-09.md`:
split-index headers, message timestamps, and `*` stripping in TTS.

---

## Commits

```
6631b21 feat(render): split-index headers, message timestamps, * stripping
```

Follows on from the previous session's three commits on `master`:
`0152b5c`, `6ad879d`, `c70d22e` (see `handover-2026-06-09.md`).

---

## What got done

### 1. Split-indexed headers

`web/js/pages/render.js` now builds a `getSplitIndices()` map of
`slide-idx → split-position-within-message` by walking the deck
once and counting how many previous slides share the same
`originalIdx`. The map is memoized per-deck-instance and invalidated
whenever `deck.slides` mutates (`loadProject`, `renderSingleSlide`,
`renderAllSlides`).

`buildHeaderLabel(slide, idx)` returns:
- `Setup` / `Details` / `Title` / `End` for non-conversation slides
- `<originalIdx+1>.<splitIdx> <speaker>` for conversation/narration
  slides, e.g. `1.0 glm5-chat`, `15.3 minimax-m3-chat`

The same function is used in both the **player header** (via
`loadSlide`) and the **slides list row** (via `renderSlideList`),
so they share a stable numeric identity.

### 2. Timestamp in player header

`formatTimestamp(iso)` returns `Jun 7, 2026 · 21:37:10` from the
source message's `createdAt` (`deck.source.messages[originalIdx].createdAt`).
Only conversation/narration slides have a timestamp — setup/details/
title/end don't.

The timestamp lives next to the split-indexed label, in
`--font-size-xsmall` and `--text-color-dim`, so it reads as metadata
rather than competing for attention.

### 3. `*` stripping in spoken text

`stripEmphasisForSpeech(s)` removes any run of `*` characters. It
applies to the **spoken** text only — on-screen `slide.text` keeps
the marks verbatim, preserving the LLM's markdown formatting.

Applied in three places, kept in sync:
- `web/js/pages/render.js` → `getSpokenText` (used by the
  staleness hash) and `buildWordSpans` (fallback path, no TTS).
- `server/server.js` → `getSpokenText` (per-slide render path that
  fetches audio from nSpeech and sends text to nVoice for
  alignment).
- `pipeline/tts.js` and `pipeline/align.js` → `getSlideText`
  (bulk TTS / alignment path used by `pipeline/pipeline.js`).

**Why the staleness hash flips:** the hash is computed from
`getSpokenText(slide)`, which now returns text with `*` removed.
Old cached audio on disk was generated from text *with* `*`, so its
`renderHash` no longer matches. The deck correctly shows "58 stale"
in the render card. Hitting "Render All" will regenerate clean
audio.

**On-screen asterisks stay:** the player still shows `*feel*` and
`*accumulation*` etc. verbatim, which matches the spec ("on-screen
text keeps them"). Only the TTS audio will be clean after a
re-render.

### 4. Bug found and fixed mid-session (TDZ)

While wiring `invalidateSplitIndexCache` into `loadProject`, the
helper ran in a `let` temporal-dead-zone. The `let splitIndexCache`
declarations were below the function definitions but above the
first call site (`loadProject`) — except `loadProject` is invoked
**immediately** as part of `init`, before the `let` was
encountered. The catch block in `loadProject` swallowed the
`ReferenceError` and showed a misleading "Failed to load project"
banner.

**Fix:** moved the `let splitIndexCache` and `let splitIndexDeckRef`
declarations to the very top of `init`, alongside `let deck = null;`.
**Rule for future init() bodies:** put all `let` closure state at
the top, before any function declaration that might be called
during init.

### 5. Verified in browser

The House vs. Grooves deck (`slideshow_w8hveoIVFd6e1B8y`, 58 slides)
shows the new headers correctly:
- Player header: `1.0 glm5-chat` + `Jun 7, 2026 · 21:37:10`
- Slides list: `1.0`, `2.0`–`2.1`, `3.0`–`3.2`, `15.0`–`15.3`
- Title slide: header reads `Title` (type name, not numbered)
- Keyboard nav: ArrowLeft/Right moves between splits within a
  message, all sharing the same `createdAt`
- Status dot: `58 stale` (correct — `*` strip invalidated the cache)

---

## Open follow-ups

- The user hasn't actually re-rendered the deck yet. Audio on disk
  still has the `*` markers. When they hit "Render All", new audio
  will be generated with stripped text. The re-render will go
  through nSpeech (TTS) and nVoice (alignment) — both confirmed
  available during the previous session's smoke test.
- The other open items from the prior handover remain:
  - Multi-slide message visual indicator ("fancy bubbles" / thread
    line) — deferred, would be a CSS-only pass.
  - Dedicated `--color-highlight-active` for word highlight (distinct
    from the accent color used for selection).
  - Vertical centering of the player content area.

## NUI gotcha to remember

The NUI router caches page elements at the JS level. If `init()`
throws, the broken element persists. The dev `no-store` middleware
helps with asset staleness but **cannot evict** a broken cached NUI
page element. The "Failed to load project" banner is the smoking
gun — it means `init` ran but the catch fired. Always check the
browser console for the real `ReferenceError`.

Recovery: open a new tab. The dev-tools "Disable cache" checkbox
prevents the issue entirely during development.
