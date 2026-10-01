# Video Rendering — Overnight Batch Plan

**Date:** 2026-09-30
**Status:** Draft — pending approval
**Target:** the **web app**, not the web export (corrected 2026-09-30, see
*Capture target* below)
**Supersedes:** the abandoned offline seek-and-paint renderer (deleted, not kept as a second path)
**Parked implementation:** moved out of this repo (2026-10-01) — the recorder
engine is its own project, `D:\Work\_GIT\screen-record` (Desktop Duplication,
tracked there); the Arena-side CDP harness (`record-deck.js`), the C# WGC probe
and the state doc sit in that repo's gitignored `_Archive/`. The measurements
below (~22 distinct fps, reconstructed audio) were taken against the
**web-export player**, the wrong target. Both gaps are open and are what the
phases below exist to close.

---

## Requirement

Stated by David, verbatim in intent:

1. **Every single frame rendered by the browser is captured.** Not a sample. Not
   word boundaries. Not "22 distinct frames per second is enough."
2. **60 Hz refresh, therefore 60 fps output.** The video's frame count and timing
   come from what the browser actually drew.
3. **4K.**
4. **Audio recorded alongside the video, perfectly in sync.**

And the reason for automating it at all:

> Realtime can take a long time and I would ideally set up the rendering and then
> do something else — go sleep for example. So the rendering of the videos could
> happen over night.

**The operative constraint is unattended, not fast.** A pipeline that takes as
long as the content and can be left alone satisfies the requirement. A faster one
is welcome. A faster one that loses fidelity does not.

---

## Capture target — the web app, not the web export

> Correction from David, 2026-09-30, after the first implementation was written:
>
> "The webexport is actually not the way to do it. This was meant as a way to put a
> conversation online, not as a video but as a self contained thing. The way I want
> to record it is from the web-app. It has a fullscreen mode that is already styled
> correctly."

**Record the app's render page, not `web-export/player/`.** The export exists to
publish a conversation as a self-contained page. It is not a video target, and
building a recorder against it duplicated work the app already had done.

### The styling already exists

`web/js/pages/render.js` already has a recording mode:

```js
document.body.classList.add('render-recording');
await pageEl.requestFullscreen();
fitSlideToWidth();
```

`fitSlideToWidth()` measures the slide at natural width, then applies
`transform: scale(min(availW / naturalW, availH / naturalH))` so it fills the
frame without overflowing vertically. The CSS side is in `web/css/main.css`:
`body.render-recording` hides the chrome, sets generous padding, holds the slide
at `max-width: 900px` with `overflow: visible`, and slightly reduces body text.

**A transform scales text as vectors, so it rasterises at capture resolution —
sharp.** That is the reason the app uses `scale()` rather than rendering small and
upscaling later, and it is worth keeping.

The parked recorder hand-rolled an equivalent of all of this in
`web-export/player/player.css` (`body.arena-capture`). That work was redundant;
the `web-export/player/*` changes were rolled back on 2026-10-01 and the player
is the plain playback page again.

### Two capture routes, and the trade is unresolved

| | CDP screencast on the app page | WGC on a headful window |
|---|---|---|
| Framerate | ~22 distinct fps (measured, at 1080p) | compositor-pushed, possibly true 60 |
| Unattended | yes, fully headless | occupies the machine's display |
| Styling | free — reuse `render-recording` | free |
| Dependencies | none (Node + Chrome) | needs a native helper |
| Meets "unattended overnight" | yes | unclear |

The screencast route fits the overnight requirement and reuses all existing
measurements. The WGC route is the only one likely to reach true 60 distinct
frames — which is the open Phase 0 question either way.

`requestFullscreen()` normally requires a user gesture. The app already wraps it
in a try/catch and continues without fullscreen, so that is handled; the question
is only which of the two routes above to take.

---

## Why the offline approach was abandoned

The first implementation sought to decouple cost from duration: seek the playhead,
paint the frame belonging at timestamp *t*, screenshot it. Cost becomes per-frame
instead of per-second, so a 31-minute deck rendered in ~13 minutes.

It was fast and wrong. It reintroduced every mechanism that produces drift:

- a frame schedule,
- per-frame duration arithmetic,
- a concat manifest,
- an audio concatenation rebuilt separately from the frames.

Measured drift reached **15 seconds** before being caught, and sync remained wrong
after that. Two structural problems could not be engineered away:

- **The content changes ~2.7 times per second** (word highlights). A
  boundary-only capture has no in-between frame to show, so the 80 ms opacity
  transition cannot exist in the output at all.
- **Audio and frames came from two independent sources.** Desync was possible by
  construction.

Realtime capture removes the second problem entirely: **audio and video come from
one playback session, so they cannot drift.** That is the argument for the
approach, and it is structural rather than a matter of tuning.

---

## What is measured so far

All of it against the **web-export player**, which is the wrong target. The
numbers are indicative, not final — the app's render page is a heavier page
(app chrome, sidebar, page routing), so delivery may differ.

`_Archive/capture/record.js`, 1920×1080, ~20 s of playback:

| | |
|---|---|
| frames captured | ~22/s |
| distinct frames (sha1 of pixel data) | 95% |
| frames inside a static hold | 7% |
| longest static hold | 5 frames (0.21 s) |
| gap p50 / p90 / p99 | 16 ms / 31 ms / 689 ms |

A hard blocker was found and fixed along the way:

```
play() failed because the user didn't interact with the document first
```

Chrome's autoplay policy rejects programmatic `play()`, and **a CDP-dispatched
click is not a user gesture**. No audio meant the player's paint loop exited
immediately and nothing was ever drawn — indistinguishable from a dead recorder.
Fixed with `--autoplay-policy=no-user-gesture-required`.

**The open problem: ~22/s, not 60/s.** Three candidate causes, not yet separated:

1. **The browser is not producing 60 distinct frames.** The content is static
   text; the picture only changes when a word highlight moves (~2.7/s). A
   compositor that only redraws on damage may legitimately emit far fewer than
   60 frames per second, and screencast would then be *faithful*. On a 60 Hz
   display it would still *present* 60 times per second — but with repeats.
2. **Screencast delivery is throttled.** Ack latency, frame encoding, or the
   WebSocket hop may be the limit rather than the compositor.
3. **Headless compositing behaves differently from headful.** The renderer has
   only ever been measured headless.

**Distinguishing these is the first task.** It decides whether "every frame the
browser renders" means 60 distinct frames or 60 presented frames with ~22
unique. Those are different deliverables and only one of them is achievable by
capturing.

---

## Phases

### Phase 0 — Establish the 60 Hz ceiling *(no code)*

Measure what the browser actually produces, separately from what capture
delivers. Compare headless vs headful, WGC vs screencast, and count distinct
compositor output on a page with known-per-frame change.

**Exit criterion:** a number for "distinct frames per second the browser
produces" at 4K, and a number for "frames per second the capture path can carry."
If the first is below 60, say so before building anything else.

### Phase 0.5 — Repoint at the app *(small)*

- Drive the app's render page into its existing recording mode rather than
  reimplementing the layout.
- Drop the `web-export/player/player.{css,js}` capture-mode changes from the
  diff — the app already has this styling and the export is not a video target.
- Navigate to `#page=render&id=<projectId>`; do **not** go through the export
  pipeline, so no `pipeline/export.js` run is needed to record a video.

**Exit criterion:** a headless capture of the app's render page in
`render-recording` mode, with the same layout a viewer sees in fullscreen.

### Phase 1 — Prove 4K realtime capture *(no new code)*

Run the repointed recorder at 3840×2160 for a couple of minutes. Measure
delivery rate, frame sizes, dropped-frame gaps, and whether audio stays in step.

**Exit criterion:** a watched 4K sample with synchronised audio, plus honest
numbers.

### Phase 2 — Audio recorded alongside, not reconstructed

The current implementation concatenates the deck's MP3s and muxes them, with
`-shortest`. That is *reconstruction*, not recording together. Options, in
increasing order of fidelity:

- keep the concat but verify sample-accurate alignment against the video,
- capture the browser's audio output directly (loopback / Web Audio tap) so the
  recording and the video share a clock,
- drive both from a single clock in the page.

**Exit criterion:** sync verified by measurement, not by eye. A video that is
15 s out looks plausible when watched — only an invariant catches it.

### Phase 3 — Batch runner for overnight use

- render a queue of decks sequentially,
- one deck at a time, so a failure costs one deck and not the night,
- per-deck log with start, end, frame count, drift check, output path,
- nonzero exit on any failure, so an overnight run is honestly reportable,
- resumable: skip decks already rendered,
- configurable resolution and fps.

**Exit criterion:** leave it running, come back, and every file is either
finished and verified or clearly failed with a reason.

---

## Constraints and known traps

Recorded here because each one cost real time on 2026-09-30.

| Trap | Consequence |
|---|---|
| **The web export is not the capture target** | It exists to publish a conversation as a self-contained page. Recording it duplicated styling the app already has |
| Autoplay policy blocks programmatic `play()` | Audio never starts; nothing is ever drawn |
| **Do not pipeline `Page.captureScreenshot` requests** | Queued calls are coalesced; several sample the same compositor state. Concurrency 1 → 43% of frames differ, concurrency 16 → 8.9%. 6× faster, silently duplicated. Screencast does not need this |
| ffmpeg **concat demuxer** quantises still durations to 40 ms | Silently moves highlights off the syllable. `-video_track_timescale` does not change it. Use the **image2** demuxer with `-framerate` as an *input* option |
| ffmpeg concat demuxer **cannot read `http://`** | Whitelists only `file,crypto,data`. Audio must be passed as local paths |
| **`-r 30` as an input rate resamples variable holds** | A "48 min" render produced a 2.1 s file. Use `-fps_mode vfr`, never `-r` |
| **`word.startMs` is paragraph-relative** | Marks from different paragraphs are not comparable; compute durations in absolute slide time |
| **A minimum-frame-duration clamp accumulates drift** | 15 s across ~10,000 frames. Holds must be exact and telescope |
| `audioUrl` is relative to `project.json` | Only relevant to the export path; the app serves audio from `/audio/:bucket/:id.:ext` |
| Deterministic compositor flags (`--run-all-compositor-stages-before-draw`) | Make offline capture reproducible by suppressing compositing; starve a push-based screencast |
| **Port 9333 belongs to nPM** on this machine | A hardcoded DevTools port attaches to an unrelated service |
| `seek-slider.max` is the *current slide's* duration | Never the deck's. Using it as a deck budget truncates a long recording |
| Wall-clock finish detection truncates | The player pauses between slides; stop on "no new frame for N seconds" instead |
| Frames buffered in memory | ~1.7 GB for one 37-minute deck. Stream to disk |

---

## Trade-off to decide explicitly

| | Offline (abandoned) | Realtime screencast | Headful + WGC |
|---|---|---|---|
| Target | — | app render page (was: web export) | app render page |
| Wall time, 31 min deck | ~13 min | ~31 min | ~31 min |
| Unattended | yes | yes, fully headless | occupies the desktop |
| Sync | drift, by construction | cannot drift | cannot drift |
| Animation fidelity | missing transitions | compositor-pushed | compositor-pushed, GPU-side |
| Framerate | n/a — no in-between frames | ~22 distinct fps at 1080p | possibly true 60 |
| Layout | hand-rolled in the export player | `body.render-recording`, already styled | same |
| Dependencies | — | zero (Node + Chrome) | needs a native helper |

Realtime is proposed because correctness of sync dominates, and the requirement
is explicitly *unattended*, not *fast*. The screencast route is the leading
candidate: it reuses the app's existing recording-mode styling and stays fully
headless. If Phase 0 shows the browser genuinely produces 60 distinct frames per
second, screencast can meet the requirement outright and the WGC route is not
needed.

---

## Explicitly out of scope

- Faster-than-realtime rendering. Rejected: it reintroduces the schedule that
  causes drift.
- **Recording the web export.** It is a self-contained publishing format, not a
  video target.
- `pipeline/export.js` as a prerequisite for recording a video. The app serves
  the project directly; the export bake is only needed for publishing online.
- Anything on a git branch. Nothing is committed.
- Restarting or touching any lab service.
