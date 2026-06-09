# Handoff — UI redesign + import format upgrade
**Date:** 2026-06-08
**Session focus:** Three-stage UI redesign (header stepper, redesigned projects / editor / render pages), and v2 Arena import format support with the moderator message.

---

## What we did

### 1. UI architecture: header stepper replaces sidebar
The persistent left sidebar navigation (with `<nui-link-list>` for Projects / Editor / Render & Play) was removed. In its place, the app header now has a 3-step stepper. Each step is a real `<nui-button>` that navigates to the corresponding router page. The active step is highlighted via `variant="primary"`.

**Files:**
- `web/index.html` — header now has `<nav class="stepper">` instead of `<nui-sidebar>` with `<nui-link-list>`.
- `web/js/app.js` — added `updateStepper()` function, listens for `nui-route-change` + `hashchange` to update the active step. Added `goto-step:*` action handler. Steps 2/3 disabled until a project is loaded.
- `web/css/main.css` — `.stepper` and `.stepper-num` styles for the numbered pill.

### 2. Projects page redesign (`web/pages/projects.html` + `web/js/pages/projects.js`)
Two states, switched via `[hidden]`:
- **Empty state:** full-area dropzone. The whole content area is one `<nui-dropzone>` with a centered prompt.
- **Populated state:** full-height `<nui-list>` + a compact "Import another" button in the top-right.

The dropzone is invisible by default; the dashed border is on the `[data-drop]` child. Verified that wrapping the list in a dropzone causes the popover to clip — so the populated state does NOT use a dropzone wrapper.

**Notable nui-list behavior:** the library's `checkHeight()` interval runs every 300ms and clobbers `itemHeight` to 0 when the host page is `display: none`. This was diagnosed, documented, and **fixed upstream in the nui_wc2 submodule** (commit `6f388a1`). Also added a `submodule` bump in the main repo (commit `c11c1a4`).

### 3. Editor page redesign (`web/pages/editor.html` + `web/js/pages/editor.js` + `web/css/main.css`)
2-column layout:
- **Left (~70%):** slide cards with a sticky toolbar (back arrow → projects, project title, "Generate with AI", settings gear, "Render & Play" →).
- **Right (~30%):** chat panel ("Slide AI" header, scrollable history, sticky input row).

**Voice mapping and conversation source** were moved out of the main view into an **Options dialog** (generated via `nui.components.dialog.page()` with two tabs: Voice Mapping / Conversation Source). The dialog uses `placement="top"` so it sits as a sheet from the top.

**Slide textareas:** use `auto-resize` (no `max-rows`) so they grow to fit content. `white-space: pre-wrap` on the inner `<textarea>` so `\n\n` paragraph breaks render as actual paragraph spacing.

**Generate with AI confirmation:** the handler now prompts via `nui.components.dialog.confirm` when the deck has 1+ slides, showing the slide count and listing what will be lost. Empty decks still generate without confirmation.

**Cache revisit fix:** router caches the editor and render pages, so `init()` only runs once. We added `element.show = (newParams) => { ... }` on both pages so project changes (via URL `?id=X` swap) re-load the deck.

### 4. Options dialog CSS
- `nui-tabs no-animation` — the height-animation lifecycle applies `overflow: hidden` which clips content. No-animation makes the tabs render static.
- The voice-mapping pane has NO overflow (so the nui-select popovers can extend down past the dialog).
- The source pane has `overflow-y: auto` + `max-height: 60vh` for the 21+ message transcript.
- `nui-dialog[mode="page"] dialog { overflow: visible }` and `dialog > main { overflow: visible }` — popover's z-index doesn't escape overflow ancestors, so we override the dialog's overflow.

### 5. v2 Arena export import format
The Arena export was consolidated with the normal chat export. Changes:
- `version: 2, mode: "arena"`
- `participants: [{ name, model, role, systemPrompt }, ...]` (was flat array of strings in v1)
- `messages[0]` is now a `moderator` system message that sets up the conversation context — must be preserved.

**Files:**
- `pipeline/importer.js` — `parseArenaExport` normalizes participants to a flat array of name strings. Accepts either `json.id` or `json.chatInfo.id` for the chat ID. Reads topic from `topic` or `chatInfo.title`.
- `web/js/pages/projects.js` — same normalization in the client import flow. Accepts both `json.id` and `json.chatInfo.id`.

**Visual treatment in source view:** the moderator message is rendered with a SETUP badge + accent border in the Conversation Source view, so it's easy to spot. This signals to the user: "this is the message the narrator will read for the title slide."

### 6. Library: nui-list itemHeight fix (submodule commit)
**File:** `modules/nui_wc2/NUI/lib/modules/nui-list.js`

**Bug:** `checkHeight()` runs every 300ms via `setInterval`. When the host page is hidden (`display: none`), `container.firstChild.offsetHeight` reads as 0. The function then sets `itemHeight = 0`, calls `setContainerHeight()` (container collapses to 0px), and `update(true)` clears the container. On re-show, the rAF loop resumes but `itemHeight` stays 0, so items render with `style.top = 0px` and become invisible.

**Fix:** added `if (list.stop) return;` at the top of `checkHeight()`. The `IntersectionObserver` already sets `list.stop = true` when the list is hidden, so the measurement is skipped during hidden windows and the last good `itemHeight` is preserved.

**Specificity in normal-mode vs fixed-mode:** normal-mode has no `overflow:hidden` guard; fixed-mode (1000+ items) does. So normal-mode was the only one broken.

### 7. Slide text rendering improvements
- Auto-grow textareas (no `max-rows` cap).
- `white-space: pre-wrap` so paragraph breaks render with proper spacing.
- Verbatim text fidelity — system prompt tells the LLM NOT to clean, paraphrase, or strip markdown/asterisks.

---

## What still needs doing

### High priority

1. **Opening slide sequence (setup + details + title) — IN PROGRESS, blocked.**
   The LLM is unreliable at creating 3 specific narrator slides before the conversation. Even with explicit instructions, the last regen produced a 22-slide deck where:
   - LLM correctly created `setup`, `details`, `title` narrator slides in turn 2-4 (confirmed in server log)
   - Then the post-processing fallback in `cleanWithLLM()` crashed with `Cannot access 'participants' before initialization` — TDZ error because the const is declared at line 407 but the fallback at line 381 uses it
   - This is a real bug that needs fixing

   **Action:** Fix the TDZ in `cleanWithLLM()` by moving `const participants = source.participants.filter(Boolean)` to right after the source normalization (around line 343). Then the fallback's `participants.join(' and ')` will work.

   **Future improvement (user's idea):** skip the LLM attempt at creating opening slides entirely. Let the LLM only generate conversation + end, then **deterministically prepend** setup + details + title slides in the post-processing. This is 100% reliable regardless of LLM compliance. The current prompt is already leaning this direction but the cleanup isn't there yet.

2. **Verify the moderator is correctly used.**
   In the conversation that DID generate 22 slides, the LLM created the 3 opening narrator slides correctly. So the moderator handling works. The fallback crash was the only issue. Test once the TDZ is fixed.

3. **End slide content.**
   The current LLM-generated end slide is "End of conversation." (boring). The system prompt says "with a brief closing" but the LLM is taking the literal interpretation. Consider a more meaningful closing for the narrator.

### Medium priority

4. **Chat AI tool calls end-to-end test.**
   The chat panel supports tool calls (`slideshow_insert_slide`, `slideshow_update_slide`, `slideshow_get_source`, `slideshow_get_deck`). These are wired up but haven't been tested live. The chat will display:
   - User messages
   - Assistant messages (with streaming markdown)
   - "Executed N tool(s)" indicator
   
   Test: send "Add a slide that says hello world" → AI should call `slideshow_insert_slide` → the new slide should appear in the editor.

5. **Settings gear visibility in the editor toolbar.**
   The back arrow and settings gear are icon-only buttons and are quite small in the busy header. May want to add labels or make them more prominent.

6. **The end slide in the test deck says "End of conversation."**
   The LLM defaults to a boring closing. Could improve the prompt to encourage a more meaningful narrator closing.

7. **The `client/` directory is stale.**
   Committed in `a6198da` (a prior attempt at a separate playback app). With the new `web/` app fully self-contained, `client/` is dead code. Remove it (or just leave the handoff for the user to decide).

### Low priority / nice-to-have

8. **TTS meta-stripping layer (user mentioned as "for later").**
   The user noted: "Timestamps and bracket-prefixed meta like '[minimax-chat · 21:37:11]:' should ideally be shown but not spoken." That's a TTS rendering concern, downstream of the LLM generation. The text is preserved verbatim now (in the slide text), but the TTS engine needs to know what's metadata vs speech. Currently everything gets spoken. This would be a separate pass on the TTS generation: walk the slide text, identify metadata patterns (timestamps, brackets, asterisks), and either skip them or substitute with silence.

9. **nui-list bug should also be filed as a NUI issue.**
   We fixed it locally in the nui_wc2 submodule. The fix should be proposed upstream (or just kept here as a working patch).

10. **The `nui-select` popover rendering.**
    The popover renders correctly now (with overflow:visible overrides), but the popover is `position: absolute` so it can't escape overflow ancestors. For dialogs that have popovers, the user must put `overflow: visible` on the right elements. This is a library design issue that could be fixed by making the popover use `position: fixed` (escapes all overflow) or by portaling it to `document.body`.

---

## Commit log this session

```
7c342ef  fix(nui-list): don't clobber itemHeight on hide     (submodule)
53d5b7d  fix(editor): let nui-select popovers escape dialog clipping
846d9db  fix(editor): show empty-state placeholder in chat panel
3bd431f  fix(editor): confirm before 'Generate with AI' overwrites
577b7eb  fix(editor): slide textareas auto-grow fully and preserve paragraphs
2d85c8d  fix(editor): use no-animation tabs; guard voice change
1429e0c  feat(import): support v2 Arena chat export format (with moderator)
653aedd  fix(editor): don't clip the voice mapping pane
585c4d9  fix(editor): let nui-select popovers escape the Options dialog clipping
2962e50  refactor(ui): replace sidebar with header stepper; redesign projects page
40f260e  refactor(editor): 70/30 split slides/chat, voice+source in options dialog
c11c1a4  chore: bump nui_wc2 submodule
```

(Older commits: import v2, fix nui-list, sidebar removal, etc.)

---

## Files of interest for next session

- `pipeline/llm-clean.js` — LLM prompt + slide generation logic. **The TDZ bug is around line 381-410.** The user wants to:
  - Have the LLM only generate conversation + end slides
  - Have the post-processing deterministically prepend setup + details + title
  - This is the next main thing to implement.
- `web/js/pages/editor.js` — slide rendering, chat, options dialog.
- `web/js/pages/projects.js` — import flow, projects list.
- `web/css/main.css` — layout, stepper, projects page, editor page, options dialog popover escape.
- `modules/nui_wc2/NUI/lib/modules/nui-list.js` — local fix for hide-show clobbering itemHeight.

## Branch state
On `master` (main repo). Submodule on `nui_wc2` main, with one local fix commit (`6f388a1`).

## Running
The server (`server/server.js`) was last restarted at 21:32 (after the prompt changes). The 5-server (Playground) is on port 5500.
