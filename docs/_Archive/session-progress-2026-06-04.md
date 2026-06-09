# Arena Slideshow — Session Progress (June 4, 2026)

## What Was Built

### Server (`server/server.js`)
- **Serves `web/` instead of `client/`** — NUI-based management UI is now the main app
- **Render cache with `renderHash`** — `POST /api/render-deck/:id` computes SHA256 hash of `(text|voice|speed)` per slide. Only stale/changed slides get re-rendered. Cached audio is reused.
- **Uses `/align` endpoint** — Updated from `/transcribe` to the new nVoice forced alignment endpoint. Returns word-level timestamps directly mapped to source text.
- **TTS preview API** — `POST /api/tts-preview` returns MP3 blob for realtime single-slide preview.
- **Static serving** — `/nui/`, `/modules/`, `/cache/audio/`, `/pages/`, `/js/`, `/css/` all served correctly. SPA fallback only for non-asset routes.

### Frontend (`web/`)
- **Shell** (`index.html`) — Proper NUI app shell with sidebar, header, theme toggle. CSP includes `img-src data:`.
- **Router** (`js/app.js`) — `nui.setupRouter()` with `basePath: '/pages'`, default page `projects`.
- **GatewayClient** (`js/gateway-client.js`) — SSE streaming async generator `streamChatIterable()`.

### Projects Page (`pages/projects.html` + `js/pages/projects.js`)
- `nui-list` virtualized project list with search, sort, selection
- `nui-dropzone` for Arena JSON drag-and-drop import
- File picker fallback
- Click project → navigates to editor

### Editor Page (`pages/editor.html` + `js/pages/editor.js`)
- **3-column layout**: Voice Mapping (left), Slides (center), Slide AI chat (right)
- **Voice mapping**: `nui-select` (searchable) per role + `nui-slider` for speed
- **Inline slide editing**: `nui-textarea` auto-resize per slide. Edit → saves to server, invalidates TTS.
- **Slide cards**: Show type badge, speaker, stale indicator, play-preview button, delete button
- **Slide AI chat**: `nui-markdown` with `beginStream()`/`appendChunk()`/`endStream()` for streaming LLM responses
- **Generate with AI**: Calls `/api/generate-deck`, which runs the full `llm-clean.js` tool-loop. Successfully generated 17 slides from a 31-message conversation.
- **Realtime TTS preview**: Per-slide play button fetches `/api/tts-preview` and plays via `new Audio()`

### Render Page (`pages/render.html` + `js/pages/render.js`)
- **Left panel**: Render status (fresh/stale/unrendered counts), Render All button, slide list with status badges
- **Right panel**: Integrated player with word highlighting, progress bar, playback controls (play/pause, prev/next, speed), keyboard shortcuts (space, arrows)
- **Auto-advance**: When audio ends, automatically loads next slide

## Verified Working
- Server starts, nDB loads, static files serve correctly
- Projects list loads from nDB
- Arena JSON import creates project
- Navigation between pages works
- AI slide generation works end-to-end (17 slides from 31 messages)
- Voice mapping UI renders with live speed labels
- Inline text editing saves to server

## Known Issues for Next Session
1. **Render page shows "No slides to render"** even though server has 17 slides. The render page init reads from `window.SLIDESHOW_APP.deck` which may be stale after navigating from editor. Fix: always re-fetch from `/api/projects/:id` in render page init.
2. **TTS render not tested end-to-end** — Need to verify `/api/render-deck/:id` actually generates audio, saves to cache, and returns aligned word timings.
3. **LLM chat tool execution** — Tool definitions are sent but the streaming response handling for `tool_calls` may need refinement. The `executeToolCall` function exists but hasn't been tested in a real tool-loop.
4. **Slide AI chat lacks conversation history** — Each message is standalone. Need to maintain chat context across turns.
5. **Missing aria-labels** on icon-only buttons (console warnings).
6. **No project deletion** in UI.
7. **CSP meta tag placement warning** — Browser complains CSP is outside `<head>`, but it IS inside `<head>`. May be a NUI router injection issue.

## Architecture Decisions Made
- `web/` is the canonical frontend, `client/` is deprecated
- `nui.registerPage()` + router pattern for page navigation
- Per-slide renderHash caching on server, client shows staleness badges
- `/align` endpoint for forced alignment (no fallback word matching needed)
- Chat streaming uses SSE via GatewayClient, rendered with `nui-markdown` streaming API
