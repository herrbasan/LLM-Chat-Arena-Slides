# Agent Instructions & General Project Rules

## Core Development Maxims

- **Priorities:** Reliability > Performance > Everything else.
- **LLM-Native Codebase:** Code readability and structure for *humans* is a non-goal. The code will not be maintained by humans. Optimize for the most efficient structure an LLM can understand. Do not rely on conventional human coding habits.
- **Vanilla JS:** No TypeScript anywhere. Code must stay as close to the bare platform as possible for easy optimization and debugging. `.d.ts` files are generated strictly for LLM/editor context, not used at runtime.
- **Zero Dependencies:** If we can build it ourselves using raw standard libraries, we build it. Avoid external third-party packages. Evaluate per-case if a dependency is truly necessary.
- **Fail Fast, Always:** No defensive coding. No mock data. No fallback defaults. No silencing `try/catch`. No optional chaining (`?.`) for required values. Never write code paths for a scenario that you assume might happen but haven't verified — that's the definition of defensive coding. If `segments` data must be present, throw if it's absent; don't silently render unhighlighted text. If data should never be `null`, let the `TypeError` surface. Configuration must be explicit — missing required config must throw immediately at startup. When something breaks, let it crash and fix the root cause. The crash *is* the signal.
- **Collaborative Development:** The human user is a partner, not just a reviewer. When facing architectural decisions, trade-offs, or uncertain paths, pause and ask for input. Explain the options clearly. The user's domain knowledge and preferences are valuable — include them in the loop. Avoid long silent stretches of trial-and-error; converse, don't just execute.
- **Use Provided Tools:** Always use the built-in VS Code read/write tools to apply changes directly when asked. Do NOT use terminal commands, shell commands, or scripts to edit files, as these bypass VS Code's file tracking, history, and diff views, making it impossible for the human partner to follow along. Do not output giant code blocks in text for the user to copy-paste.

## Session Priming

Every session starts blind. Before writing any code, run the priming sequence below. The goal is to load the cross-session context (memory topology, curated docs, library mental model) that the LLM does not have on its own.

### Step 1 — `memory.overview` (workshop memory)

Call the workshop memory tool's `memory.overview` to get the cluster map for this account. It returns clusters, cross-cluster bridges, wildcards, and the top nodes by cluster. Use it to identify which prior work is relevant to the current request before recalling specifics.

- **Format:** start with `summary` (the default) — it lists clusters and top nodes without dumping all 182+ nodes. Switch to `full` only when the summary is missing the area you need.
- **Recency gap:** the topology lags the most recent ~4 days. For anything from the last few days, use `memory.recall` with a focused query (e.g. `query: "Arena Slides import flow"`).
- **What to look for:** the cluster whose hub matches the current task (e.g. Arena Slides Project = #434, nSpeech = #330, NUI = #295) and the cross-cluster bridges that connect it to dependencies (e.g. #434 ↔ #330 means Arena Slides TTS depends on nSpeech).

### Step 2 — `documentation` tool (curated project docs)

The workshop `documentation` tool exposes the project's curated documentation set across domains. The active domain for this project is **Web UI** (NUI library). Pull the relevant docs before writing UI code.

```
# List domains
documentation.domains

# List files in a domain
documentation.list  (domain: "Web UI")

# Read a file
documentation.get   (file: "Web UI/reference_cheatsheet.md")
```

For NUI work, always read at minimum:
- `Web UI/reference_cheatsheet.md` — the canonical rule set, WRONG vs CORRECT patterns
- `Web UI/concept_ax_vs_dx.md` — the design philosophy (AX > DX, explicit over clever)
- `Web UI/concept_data_action.md` — the `data-action` grammar, event flow, built-in actions
- `Web UI/guide_getting_started.md` — loading sequence, app/page modes, theming
- `Web UI/guide_architecture_patterns.md` — router, `nui-page` layout, page lifecycle

For component-specific work, also pull `Web UI/component_{name}.md` (e.g. `component_list.md` for `nui-list`). Component docs are short and dated; the registry at `documentation.list` shows which exist.

**Source-of-truth precedence:** workshop docs (curated, dated) > local submodule files. Fall back to local files only when the workshop doc is missing detail:
- `modules/nui_wc2/LLM-CHEATSHEET.md` (local copy of the cheatsheet)
- `modules/nui_wc2/documentation/DOCUMENTATION.md` (full architecture)
- `modules/nui_wc2/documentation/components.json` (component registry)
- `modules/nui_wc2/documentation/components/{name}.md` (per-component)
- `modules/nui_wc2/NUI/css/nui-theme.css` (theme variables — the complete list)
- `modules/nui_wc2/NUI/nui.js` (core API)

### Step 3 — NUI mental model (must internalize before writing HTML/CSS)

NUI is built for **LLM-generated code** (AX > DX), not human developers. The philosophy: *strip the framework magic, keep the platform-native primitives, let the browser do the work.* The DOM is the source of truth. `nui-*` custom elements are thin semantic upgrades over native HTML.

#### Conventions I keep getting wrong

| My training bias | NUI rule |
|---|---|
| `<nui-button>Save</nui-button>` | `<nui-button><button type="button">Save</button></nui-button>` — always wrap the native element |
| `document.querySelector('.btn')` | `element.querySelector('.btn')` — scope to the page wrapper passed to `init()` |
| `el.addEventListener('click', fn)` | `<button data-action="save:draft">` + `nui.registerAction('save', ...)` or `addEventListener('nui-action-save', ...)` |
| `<style>nui-button { ... }</style>` | Never style `nui-*`. Use `variant`/`type`/`size`/`fill` attributes. For spacing, wrap in your own `<div>` with `gap: var(--nui-space)`. |
| `addEventListener('nui-click', ...)` | Don't. `nui-click` is internal. Use `data-action` or listen for the native event on the inner element. |
| App: free-form children | `<nui-app>` requires exact order: `nui-skip-links` → `nui-app-header` → `nui-sidebar` → `nui-content` → (optional `nui-app-footer`). Each must contain its native element. |
| Custom CSS variables | Only NUI theme tokens: `--color-base`, `--color-shade1-9`, `--color-highlight`, `--nui-space`, `--border-shade1-4`, `--border-radius1-3`. Never invent new ones. |
| Skip `await nui.ready()` | Always `await nui.ready()` before any programmatic API call. |
| Core component imports | Addons (`nui-list`, `nui-wizard`, `nui-menu`, etc.) need BOTH JS + CSS imports. Core components don't. |
| `innerHTML += ...` for state updates | DOM is the source of truth; mutate it imperatively. |

#### `data-action` grammar

```
data-action="name:param@target"
```

- `name` = action verb (required)
- `param` = optional context (e.g. `save:draft`)
- `target` = CSS selector for the target (defaults to trigger element)
- Built-ins: `dialog-open@#id`, `dialog-close`, `tabs-select:n`, `sidebar-toggle`, `theme-toggle`, `dropdown-toggle`, `accordion-toggle`, `sortable-start/end`, `menu-open@#id`, `lightbox-open@#id`, `wizard-next/prev`, `media-play/pause`, `rich-text-action:cmd`
- Two events fire: `nui-action` (generic) and `nui-action-{name}` (specific). Both bubble.
- `e.stopPropagation()` scopes an action to a component.
- For global handling, use `nui.registerAction(name, handler)`.

#### Router & page lifecycle

- **Three patterns:** centralized (`registerFeature`), fragment-based (`setupRouter` + `registerPage`), hybrid.
- This project uses **fragment-based** — pages in `web/pages/`, registered via `nui.registerPage(name, { html, init })`.
- **`init()` runs once, `show()` runs on each navigation.** The router caches containers; inactive ones get `display:none`. Geometry-measuring components (like `nui-list`) must wait for visibility before measuring.
- **`nui-page` layout:** wraps page content in `--space-page-maxwidth` (~56rem). Use `breakout` attribute to escape it; use `.maxwidth-container` inside a breakout to re-constrain.

#### Debugging NUI

- `?nui-debug` query param auto-loads the validator.
- Or import `nui-debug.js` + `nui-debug.css` explicitly.
- `nui.debug.run()` returns `{ valid, count, issues: [{element, message, fix}] }`.
- Dev-only — zero production cost if you don't import it.

### Step 4 — End-of-session: persist via workshop memory

When the user signals end-of-session ("we're done", "that's it for today", "let's wrap"), persist what landed through the **workshop memory system** (`mcp_workshop_tools`), not the local `memory` tool. The local memory tool is workspace-scoped and short-lived; workshop memory is the durable, dreaming-clustered cross-workspace store.

```
mcp_workshop_tools.call(method="memory.store", payload={
  description: "<one-line summary>",
  category: "<Arena Slides | Preferences | nSpeech | ...>",
  confidence: <0..1>,
  data: "<what changed, why, what's deferred, operational reminders>"
})
```

Multiple `memory.store` calls are fine — one per topic. The dreaming system deduplicates and clusters. Prefer workshop docs over the local `documentation` tool's domain files when both are available.

## Verified Project State — 2026-06-13

### Architecture
- **Deck version:** 3 (`deck.version === 3`). v3 projects store `messages[]` with `paragraphs[]`; virtual slides are built at runtime in `web/js/pages/render.js` (~600 chars per visual chunk).
- **Slide type contract:** `setup → details → topic → [conversation...] → end`. The type `title` was renamed to `topic` on 2026-06-10; no `title` type remains in the active flow.
- **Topic is the seed:** `messages[0]` from Arena exports (speaker `moderator`, content prefixed `Topic:`) is the human-authored seed prompt. It is spoken verbatim with the `Topic:` prefix on the `topic` slide. `arenaData.topic` / `summary.title` are AI-generated downstream summaries and must NOT be used as the topic.

### Runtime / Storage
- **Server:** `server/server.js` at `http://localhost:3600`.
- **Audio binaries:** Stored directly on disk under `server/data/render_cache/{projectId}/`. nDB file buckets (`storeFile`/`getFile`) exist but are **not used** for audio.
- **nDB:** Used for append-style JSONL project persistence only.
- **nSpeech / nVoice:** External services via `NSPEECH_URL` and `NVOICE_URL`.

### Recent Features (committed and pushed)
- **Stop Render All:** Server-side `AbortController` per project, client Stop button in `web/pages/render.html` + `web/js/pages/render.js`, endpoint `POST /api/v3/render-stop/:id`. Commit `a87c0e1`.
- **Projects list persistence:** `nui-list` initial render deferred until viewport has real height; `checkHeight()` rejects zero-height measurements. App-side fingerprint guard in `web/js/pages/projects.js` skips `updateData()` when data is unchanged. Commits: NUI submodule `80ac441`, main repo `4f29f82`.

### NUI Submodule Patches
- `modules/nui_wc2` carries two local patches on top of upstream `main`:
  - `6f388a1` — don't clobber `itemHeight` while hidden (`list.stop` guard).
  - `80ac441` — never accept zero `itemHeight`; defer initial render until layout.

### Visual Styling (current)
- **Conversation slides:** no eyebrow label (`showEyebrow: false` in `SLIDE_STYLES`).
- **New-speaker transition:** `.slide--new-speaker` has no default treatment (no top border).
- **Word highlighting:** opacity-only (`future 0.4`, `active 1`, `past 0.8`; topic future words at `1`).

### Pitfalls to remember
- The NUI router caches pages and initially appends them `display:none`. Any component that measures geometry must wait for visibility.
- If playback/alignment looks wrong, clear `server/data/render_cache/{projectId}/` and remove persisted `slide.tts` data through the API; mixed cache is a common false lead.
- Restart the slideshow server after changing `.env`, `ALIGNMENT_VERSION`, or imported server modules. Restart nVoice after changing Python files in `D:\Work\_GIT\nVoice`.

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

## Arena Conversation Semantics — The Topic Is the Seed

**Fact:** In an Arena conversation, the **first message** (speaker: `moderator`, role: `system`, content prefixed with `Topic:`) is the **seed prompt** — the first thing sent to `participantA`. Everything the first model says is a direct response to that seed. The viewer cannot understand slide 4+ without it.

**What this is NOT:**
- It is **not** the AI-generated `summary.title` from the Arena export. That title is produced *after* the conversation finishes and summarizes *what was discussed*. The user explicitly flagged this confusion on 2026-06-08: *"The 'title' is a generated title for the conversation, not the topic."*
- It is **not** `chatInfo.title` either — that's a duplicate of `summary.title` in v2 exports.
- It is **not** a piece of flavor or setup. It is the literal `content` field of `messages[0]` when `messages[0].speaker === 'moderator'`.

**The moderator is the human's hand, not a system prompt.** Although `messages[0].role` is `system` and `speaker` is `moderator`, the Arena export does **not** inject this into the models as a system prompt. It is sent to the first model as a regular user/assistant turn to seed the conversation. The human user (running the Arena) is the one writing it — it's the only place the human inserts text. **Non-interference is an intentional and important aspect of the experiments:** the human's role is to set the topic, then step back and let the two models respond to each other directly with no further human intervention. Only in rare cases does the human use the moderator role to inject themselves back into a conversation. There are no system prompts.

This means:
- Treat the moderator message as a **human-authored message**, not model configuration. Stripping or rewriting it as "setup context" loses information the viewer needs.
- Do **not** model the moderator as a third AI voice. The narrator is the only synthetic voice. The moderator's words are the human's words.
- The fact that `role: "system"` and `speaker: "moderator"` are present is a quirk of the export format, not a semantic signal. Use the content, not the role, to interpret it.

**Example (real export `reference/arena-house_vs__grooves__being_caugh-…-2026-06-08.json`, messages[0]):**
```json
{
  "speaker": "moderator",
  "role": "system",
  "content": "Topic: This is a Chat app that connects two LLM's for autonomous conversation. This is not a task, feel free to be yourself and allow yourself to be curious."
}
```
The first model's opening — *"Hey there! That sounds like a genuinely fun setup. I've always wondered what it would be like to just... talk, without a human steering the conversation."* — is a direct response to "This is a Chat app that connects two LLM's for autonomous conversation… feel free to be yourself and allow yourself to be curious." Without that prompt on screen or in narration, the opener lands as a response to nothing → mental break for the viewer.

**Implications for the opening slides:**
- The `title` slide should present the **seed prompt content** (or a faithful rendering of it), NOT the AI-generated `summary.title`. The LLM is free to clean it for spoken delivery, but the substance must be present.
- The `summary.title` / `chatInfo.title` can optionally appear on a separate slide near the end (e.g. as a "the system later summarized this as…" beat) but must not replace the seed.
- The current `pipeline/llm-clean.js` prompt and the deterministic fallback both use `source.topic`, which is bound to `arenaData.topic` in `pipeline/importer.js` — that is the WRONG field. It should be derived from `messages[0].content` (stripping the `Topic:` prefix) when `messages[0].speaker === 'moderator'`.
- `pipeline/importer.js` should expose this as a separate field (e.g. `source.seedPrompt`) and `cleanWithLLM()` / the deterministic opener should use it for the `title` slide text and narration.

**Spoken narration of the topic — keep the prefix and the full content.** The seed prompt should be spoken out on the `title` slide *with* the `Topic:` prefix, exactly as the human wrote it. Do not strip the prefix or paraphrase the wording. The narrator's role is to give the listener context — that includes the literal framing word `Topic:` so the listener understands what they are hearing is the prompt, not a description. The opening structure is consistent across nearly all conversations because it produces the best outcomes; the `Topic:` line is the one stable, human-authored part of the deck. Typical title-slide narration reads the seed as: *"Topic: This is a Chat app that connects two LLM's for autonomous conversation. This is not a task, feel free to be yourself and allow yourself to be curious."* — i.e. verbatim from `messages[0].content`, with the prefix kept intact, optionally preceded by a brief framing beat like "The conversation began with this prompt." Do not invent a third AI voice to read the moderator; the narrator reads it.

**Don't make this mistake again:** if a generated deck's title slide references concepts that don't appear in the moderator message, the title is wrong. The seed is upstream of the conversation; the summary is downstream.

**Architectural fix (2026-06-09):** The opening slides (setup + details + title) and the closing slide (end) are now **injected deterministically** in `pipeline/llm-clean.js`'s post-processing — not generated by the LLM. The LLM is no longer responsible for any of: which is the topic, how the opening reads, or what the closing says. It only converts the conversation messages into verbatim conversation slides. The moderator message is stripped in `pipeline/importer.js` so the LLM never sees it; `source.seedPromptRaw` carries the moderator's content (with the `Topic:` prefix) into the title slide text and narration. This was a forced simplification after the LLM repeatedly used the AI summary title and merged 21 messages into 8 slides.

**Renamed 2026-06-10:** the slide type `title` was renamed to `topic` everywhere (`type: 'title'` → `type: 'topic'`). The name was always overloaded with the AI summary title (`summary.title` / `chatInfo.title` / `chatInfo.title`); calling it `topic` makes the contract explicit and unambiguous. The seed prompt is *the topic*. Update any place that branches on `slide.type === 'title'` to check `slide.type === 'topic'`. The opening-slides contract is now: `setup → details → topic → [conversation...] → end`, and the deck version was bumped from 1 to 2 to mark the new structure (conversation slides now carry explicit `splitIdx` + `splitCount`; the details slide carries a structured `meta` block with `recordedAt`, `renderedAt`, `models[]`, `turnCount`).

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
