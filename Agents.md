# Agent Instructions & General Project Rules

## Core Development Maxims

- **Priorities:** Reliability > Performance > Everything else.
- **LLM-Native Codebase:** Code readability and structure for *humans* is a non-goal. The code will not be maintained by humans. Optimize for the most efficient structure an LLM can understand. Do not rely on conventional human coding habits.
- **Vanilla JS:** No TypeScript anywhere. Code must stay as close to the bare platform as possible for easy optimization and debugging. `.d.ts` files are generated strictly for LLM/editor context, not used at runtime.
- **Zero Dependencies:** If we can build it ourselves using raw standard libraries, we build it. Avoid external third-party packages. Evaluate per-case if a dependency is truly necessary.
- **Fail Fast, Always:** No defensive coding. No mock data. No fallback defaults. No silencing `try/catch`. No optional chaining (`?.`) for required values. Never write code paths for a scenario that you assume might happen but haven't verified — that's the definition of defensive coding. If `segments` data must be present, throw if it's absent; don't silently render unhighlighted text. If data should never be `null`, let the `TypeError` surface. Configuration must be explicit — missing required config must throw immediately at startup. When something breaks, let it crash and fix the root cause. The crash *is* the signal.
- **Collaborative Development:** The human user is a partner, not just a reviewer. When facing architectural decisions, trade-offs, or uncertain paths, pause and ask for input. Explain the options clearly. The user's domain knowledge and preferences are valuable — include them in the loop. Avoid long silent stretches of trial-and-error; converse, don't just execute.
- **Use Provided Tools:** Always use the built-in VS Code read/write tools to apply changes directly when asked. Do NOT use terminal commands, shell commands, or scripts to edit files, as these bypass VS Code's file tracking, history, and diff views, making it impossible for the human partner to follow along. Do not output giant code blocks in text for the user to copy-paste.

## Current Slideshow System

### Runtime Services

- **Slideshow server:** `server/server.js`, normally served at `http://localhost:3600`.
- **nSpeech:** Generates MP3 audio from the exact spoken slide text via `NSPEECH_URL`.
- **nVoice:** Produces speech-to-text segments and word timestamps via `NVOICE_URL`. Current local development uses `https://127.0.0.1:2244` with a self-signed certificate.
- **nDB:** Project persistence is append-style JSONL through `modules/nDB`; do not hand-edit database records unless there is no API path.

### Spoken Text Contract

- Use `getSpokenText(slide)` semantics everywhere:
	- `title` and `end` slides speak `slide.narration || slide.text || ''`.
	- conversation slides speak `slide.text || slide.narration || ''`.
- Render hashes are based on spoken text + voice + speed. If spoken text logic changes, cached audio and alignment must be invalidated.

### Render Cache

- Per-project render cache lives under `server/data/render_cache/{projectId}/`.
- Audio file names are `slide_{000}_{renderHash}.mp3`.
- `cache_meta.json` maps slide index to render hash.
- `deck.json` stores the cached rendered deck, including `tts` data.
- If playback/alignment looks impossible to reason about, clear the project render cache directory and remove persisted `slide.tts` data through the project API. Mixed old cache was the cause of several false leads.

### Alignment Contract

- Do **not** remap nVoice words back onto source text with fuzzy matching, LCS, interpolation, or index matching. That caused drift and false synchronization.
- `server/server.js` calls `POST {NVOICE_URL}/align?text=...` with the MP3 bytes and stores nVoice output directly.
- The app stores:
	- `tts.segments[]` with `startMs`, `endMs`, `text`, and `words[]`.
	- `tts.words[]` as the flattened nVoice word list.
	- `tts.durationMs`, `sourceWordCount`, `alignedWordCount`, `alignComplete`, and `alignVersion`.
- The only post-processing allowed on nVoice words is immediate duplicate removal: adjacent words with the same normalized text and a tiny timing gap are dropped. This fixes artifacts like `string, string, one...` without changing real timing.
- `ALIGNMENT_VERSION` in `pipeline/align.js` gates cached timing compatibility. Bump it whenever alignment storage or filtering semantics change.
- nVoice `/align` is not true forced alignment. In `D:\Work\_GIT\nVoice`, do not feed the full script into faster-whisper `initial_prompt`; long prompts caused truncation and timestamp cliffs. Current working behavior uses normal transcription settings with word timestamps and the script only as endpoint context.

### Playback Contract

- The browser renders timed nVoice words directly. It does not split source text and pair words by index.
- `web/js/pages/render.js` groups words by `tts.segments` for structure, but visual progress is word-only.
- `requestAnimationFrame` reads `audio.currentTime * 1000` and assigns word classes:
	- `future`: current time before `data-start`.
	- `active`: `data-start <= current time < data-end`.
	- `past`: current time after `data-end`.
- Playback styling is opacity-only in `web/css/main.css`:
	- future/unread words: `0.4` opacity.
	- past/read words: `0.8` opacity.
	- active word: `1` opacity.
	- opacity transition: `0.08s`.
- Do not add colored highlights, text shadows, or backgrounds for word progress. Opacity works in both light and dark modes.

### Known Alignment Diagnostics

- If highlighting stops mid-slide, inspect consecutive word timestamps first. A large gap usually means nVoice skipped audio or cached stale alignment is being used.
- Compare `/align` and `/transcribe` on the same MP3. If `/transcribe` is complete and `/align` is not, fix nVoice settings before changing the slideshow UI.
- If the API shows `alignComplete: false`, check `sourceWordCount` vs. `alignedWordCount` and inspect segment tails before assuming the browser is wrong.
- Always restart the slideshow server after changing `.env`, `ALIGNMENT_VERSION`, or imported server modules.
- Always restart nVoice after changing `D:\Work\_GIT\nVoice` Python files.

## NUI Web Components

This project uses the **NUI Web Components** library (`nui_wc2`). This is a high-performance, browser-native UI toolkit that breaks with many common web development patterns. **Any LLM building this MUST internalize these rules before writing HTML or CSS.**

### Rules That Matter Here

1. **Every NUI component wraps a native HTML element.** In development, NUI auto-creates the inner element if missing. For production, always include it explicitly. Example: `<nui-button><button type="button">Text</button></nui-button>` — NOT `<nui-button>Text</nui-button>`.

2. **Use `data-action` for declarative wiring**, not scattered event listeners. Example: `<nui-button data-action="dialog-open@#my-dialog"><button>Open</button></nui-button>`.

3. **`<nui-app>` requires EXACT children in order:** skip-links -> app-header -> sidebar -> content -> footer (optional). Each layout wrapper MUST contain its native HTML element (`<header>`, `<nav>`, `<main>`, `<footer>`).

4. **NEVER style NUI components.** No inline `style=""`, no `<style>` blocks targeting `nui-*` elements, no custom CSS classes on NUI components. Visual variation comes from attributes (`variant`, `type`, `size`, `fill`), not CSS. For spacing between components, use your own wrapper `<div>` with theme variables like `gap: var(--nui-space)`.

5. **Use only NUI theme CSS variables** for any custom styling: `--color-base`, `--color-shade1-9`, `--text-color`, `--text-color-dim`, `--color-highlight`, `--border-shade1-4`, `--nui-space`, `--nui-space-half`, `--nui-space-double`, `--border-radius1-3`, etc. Never invent new variables.

6. **Addons require BOTH JS import AND CSS link.** Forgetting either = broken component with zero errors. Core components work without imports.

7. **`await nui.ready()` before calling programmatic APIs.** The library initializes asynchronously.

8. **In page scripts, use `element.querySelector()` not `document.querySelector()`.** The element is the page wrapper passed to `init()`.

9. **Do not listen for `nui-click`** — it's internal. Use `data-action` or listen for the native event on the inner element.

### NUI Source Files

- **Cheatsheet** (read first): `modules/nui_wc2/LLM-CHEATSHEET.md`
- **Philosophy & Architecture**: `modules/nui_wc2/documentation/DOCUMENTATION.md`
- **Component Registry**: `modules/nui_wc2/documentation/components.json`
- **Component Docs**: `modules/nui_wc2/documentation/components/{name}.md`
- **Theme CSS**: `modules/nui_wc2/NUI/css/nui-theme.css`
- **Core JS**: `modules/nui_wc2/NUI/nui.js`
