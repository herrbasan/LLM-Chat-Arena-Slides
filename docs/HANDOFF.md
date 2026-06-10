# Handoff

> The current state of the project as of the most recent working session, plus the open follow-ups.

This is a project-facing snapshot, not a session log. Session-by-session working notes live in the dated `handover-*.md` files in this folder; for the most recent, see [`handover-2026-06-09.md`](handover-2026-06-09.md) and [`handoff-render-split-timestamp-asterisk-2026-06-09.md`](handoff-render-split-timestamp-asterisk-2026-06-09.md).

---

## What's on `master`

The `master` branch is published at [github.com/herrbasan/LLM-Chat-Arena-Slides](https://github.com/herrbasan/LLM-Chat-Arena-Slides). The published head is `945b71e` (the `chore: prepare repo for public release` commit). Four local commits sit on top, queued for the next push:

```
61c6cbc docs+code: drop the 'The conversation began with this prompt' preamble
e51f204 docs: tighten the 'What This Is' opener to lead with non-interference
ef903ef docs+code: lock the opening-slide narration contract
7ee9d9f docs: rewrite README intro to match the project's actual framing
945b71e chore: prepare repo for public release       ← origin/master
```

The four local commits together form one milestone: a README + opening-slides-contract rewrite. They push as a single fast-forward when ready.

---

## What's in the codebase right now

- **The full Arena pipeline works end-to-end.** Drag in an Arena export JSON, the LLM cleans the text for TTS, the deck gets voices assigned, TTS audio is generated per slide, nVoice forced-aligns the audio to per-word timestamps, and the browser plays the deck with word-by-word highlighting. Verified on the House vs Grooves deck (`slideshow_w8hveoIVFd6e1B8y`).
- **The editor's chat works** via a same-origin `/api/chat` proxy. The browser never talks to the LLM gateway directly. Tools available to the chat: `slideshow_get_source`, `slideshow_get_deck`, `slideshow_insert_slide`, `slideshow_update_slide`.
- **The render & play page has the polish landed in commits `0152b5c`, `6ad879d`, `c70d22e`, `6631b21`:** compact cards, custom dot status indicator, rotated nav arrows, selected state with accent border, split-indexed headers (`1.0 glm5-chat`), message timestamps in the player header, and `*emphasis*` markers stripped from spoken text only.
- **The opening slides are a locked contract.** Setup / Details / Title narrations are documented in the README and locked in [``pipeline/llm-clean.js` → `buildOpeningSlides`](../pipeline/llm-clean.js). The Details and Title narrations have been in place since before this session. The Setup narration is the one that changed.

---

## Open follow-ups (deferred work)

### Existing deck is missing the Setup slide

The House vs Grooves project on the server (`slideshow_w8hveoIVFd6e1B8y`) was generated before commit `1c5e808` added the deterministic-opens behavior. So its slide list is:

```
details → title → [55 conversation slides] → end
```

There's no `setup` slide. The new Setup narration (the "you're about to hear a conversation between two language models…" opening) will only appear in **newly generated** decks. To retrofit the existing deck:

- **Easy path:** regenerate the deck via the editor's "Generate with AI" button. Destructive — overwrites any manual edits.
- **Less-destructive path:** `PUT /api/projects/{id}` with a Setup slide spliced at position 0. ~10 lines of Node.

### Title slide visual treatment

The Title slide's **narration** is locked: just the seed prompt, no preamble. The **on-screen rendering** is still using the conversation-slide layout (type eyebrow + speaker label + words-container). The README documents the intent ("no type eyebrow, no speaker label — described in the README"), but the renderer change in [`web/js/pages/render.js`](../web/js/pages/render.js) hasn't been done. Look in `loadSlide` for the slide-type dispatch.

The user has more visual ideas for the slideshows in general but explicitly deferred them. Worth a follow-up conversation if/when the visual-treatments-of-slides topic comes up.

### Chat tool extensions (deprioritized)

I proposed six tool extensions during the session; the user explicitly said they aren't needed for the Arena use case:

- `slideshow_delete_slide`
- `slideshow_move_slide` (atomic, preserves TTS cache)
- `slideshow_render_slide` (close the render-in-the-loop gap)
- `slideshow_get_render_status`
- `slideshow_help` (machine-readable constraints for small models)
- Fix to `slideshow_update_slide` to update `narration` not `text` for `title`/`end` slides

These may resurface for the spin-off project (see below).

### Re-render the live deck

The House vs Grooves deck was re-rendered once during the session (the server log shows the `[Render] Slide N: generating TTS... aligned M words` lines from when the user clicked "Render All"). Audio on disk should now be clean (no `*` markers in the spoken text). If the deck has been edited since, individual slides may show "stale" in the render & play page — the user can re-render per-slide or full-deck as needed.

---

## Spin-off project

**A second repo is on the table**, separate from this one. It would take the durable parts of this architecture:

- **Voice generation** (nSpeech integration, three-role voice mapping UI)
- **Forced alignment** (nVoice `/align` for per-word timestamps)
- **Word-by-word transcript sync** (the per-word highlight in the player)
- **The render-hash cache invalidation pattern** (`computeRenderHash(text, voice, speed)`)
- **The same-origin `/api/chat` proxy** for LLM access from the browser

And drop the Arena-specific parts:

- The seed-prompt ceremony and "Topic:" prefix
- The auto-generated opening slides
- The moderator/participantA/participantB framing
- The 100+ archived Arena conversations
- The whole `pipeline/importer.js` Arena-JSON path

The user's words: "we can just make use of what we learned. Specially the voice generation and transcript syncing."

Not yet bootstrapped. No name, no repo. Open questions for when it starts:

- Repo name? Probably not `herrbasan/presentations` (that was my guess, not theirs).
- Bootstrap strategy: fork this repo and gut the Arena bits, or start fresh with a lessons-learned doc as the brief?
- Source types: free text topic, document import, both?
- Render-in-loop: chat can trigger renders, or user clicks "Render All" in the UI?
- Voice mapping: same three roles or a different model?

A [`docs/INSIGHTS.md`](INSIGHTS.md) (proposed but not written) would capture the durable learnings for the next project's bootstrap. The user said: write it **after** the spin-off starts, not before, so the lessons are concrete.

---

## For the next person picking this up

The most important things to know:

1. **The opening-slides contract is sacred.** Don't change the Setup / Details / Title narrations without a deliberate decision. The verification premise depends on the contract being stable.

2. **The `*` stripping is a load-bearing implementation detail.** The on-screen text keeps `*emphasis*` markers verbatim. The spoken text has them stripped before it goes to TTS / alignment. The `getSpokenText` helpers in `server.js`, `pipeline/tts.js`, and `pipeline/align.js` must stay in sync. If you change the `*` rule, re-render the deck.

3. **The render-hash is the staleness oracle.** `slide.tts.renderHash === computeRenderHash(text, voice, speed)` is the entire "is this slide stale?" logic. When the text changes, the hash changes, the slide goes stale, the next render replaces the cache.

4. **The browser can't reach the LLM gateway directly.** CSP `default-src 'self'` blocks cross-origin `connect-src`, and the gateway URL may be on a different host. All chat goes through the same-origin `/api/chat` proxy in the server.

5. **The `_Archive/` folder at the repo root is gitignored** but lives on disk. It contains the early `client/` attempt that was superseded by `web/`. Don't delete; it's a reference for the original architecture.

6. **The author's commits may be from `Copilot`.** That's intentional. The user wanted full transparency about how the project was built, so the AI-assist trail is preserved in the log.

7. **`master` is the only branch.** No `main`, no `develop`. The user initializes the GitHub repo themselves; the `origin` remote is configured after the fact.
