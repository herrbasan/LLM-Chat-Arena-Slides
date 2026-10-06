# Batch Recording Workflow — OBS Realtime Capture

Records every conversation deck to a 4K60 MP4, unattended, one file per
conversation. This is the runbook for new batches.

## The three actors

```
record-queue.mjs (runner, server/)     — orchestrates everything, owns the run
  ├─ fullscreen Chrome (spawned)          — plays decks autonomously (recording=1 in URL)
  ├─ OBS via obs-websocket 5 (:4455)   — StartRecord / StopRecord / events / stats
  └─ app server (/api/record/*)        — RAM-only session state: queue, door, progress
```

Per deck: page paints → POST ready → runner StartRecord → OBS STARTED → 1s
pre-roll → runner opens door → page plays (3s progress pings) → last paragraph
ends → 2s post-roll → POST done → runner StopRecord → STOPPED event carries
outputPath → file renamed to `NN-slug.mp4` → advance → page reloads to next deck.

The page may only play while the door is open, so nothing records idle time.
The runner watchdogs: ready timeout (120s), heartbeat silence (30s), stop
timeout, OBS death, browser death. Fault → kill Chrome, reset deck signals,
relaunch, retry (max 2 attempts per deck), then skip and continue.

## One-time setup (already done on this machine — recheck only if OBS changes)

1. **OBS scene** ("Scene", the only one): Window Capture (WGC) of the kiosk
   Chrome + window/application audio. Canvas 3840x2160 @ 60fps.
2. **Window Match Priority: title first, executable fallback** ("Match
   title, otherwise find window of same executable") — valid because the
   recording machine must not have any other Chrome window open during a
   run. The capture window title is always `Arena Slideshow - Google Chrome`
   (the page never mutates document.title in recording mode). The runner
   launches the window BEFORE OBS so the source binds at OBS startup; if
   OBS ever starts before the window exists, the source initializes
   unbound and records black.
3. **Output format: Hybrid MP4** (Settings → Output → Recording) — crash-safe
   mid-write like MKV, uploads to YouTube as-is.
4. **WebSocket server**: OBS Tools → WebSocket Server Settings → enabled,
   port 4455, password set.
5. **`server/.env`**: `OBS_WS_PASSWORD=<the password>` and
   `RECORD_DIR=X:\arena-publication\videos` (the local mount of the
   workshop's MCP storage — recordings land directly in the canonical
   publication tree, reachable via the storage tools and their HTTP routes).
   Optional overrides: `OBS_WS_URL`, `OBS_PATH`, `CHROME_PATH`,
   `RECORD_WIDTH`, `RECORD_HEIGHT`. The kiosk Chrome profile always stays
   local (`captures/chrome-profile`) — profile IO does not belong on a
   network mount.
6. Sanity: `node server/obs-probe.mjs` → "reachable — auth REQUIRED".

## Per-batch run

1. **Decks must be fully rendered first.** The recording captures live
   playback — a paragraph without audio is skipped by the player and therefore
   missing from the video. Check the Projects page: every deck must show the
   "Audio ready" badge (all paragraphs rendered and aligned).
2. **Server running**: `node server.js` from `server/` (port 3600).
3. **Launch the run** from `server/`:
   - all decks: `node record-queue.mjs`
   - subset: `node record-queue.mjs --only=<projectId>[,<projectId>...]`
   - continue the video series: add `--start-num=<N>` — file numbering is
     continuous across batches (01–05 batch 1, 06–08 batch 2, next batch
     `--start-num=9`). Without the flag a run numbers from 01 and collides
     with existing files.
   - bounded test: add `--stop-after=<ms>` (cuts the capture after N ms
     through the full finalize path — use ~60000 to smoke-test a setup change)
   The runner builds the queue from `GET /api/projects` (date order), resets
   any previous session, spawns the kiosk Chrome, and supervises.
   **OBS lifecycle is automatic — never start or close it by hand**: if OBS
   isn't running the runner launches it (`--minimize-to-tray`, waits for the
   websocket) and closes it at run end; if OBS is already running the runner
   attaches to that instance and leaves it alive (but OBS dying mid-run
   aborts the run). OBS autodetects from the default install path, or set
   `OBS_PATH` in `.env`.
4. **While it runs: leave the machine alone.** No Win+L (window capture can't
   see a locked session), no other Chrome windows, no clicking into the
   fullscreen window or OBS. The cursor is
   hidden in-capture (`cursor: none` in recording mode). AC sleep is "never";
   OBS holds the display awake while recording anyway. Runtime ≈ sum of deck
   durations + ~10s overhead per deck (a 9-deck batch ≈ 4h).
5. **Monitor (optional, read-only)**: `curl http://localhost:3600/api/record/state`
   — shows current deck, door, last progress ping. The runner terminal logs
   fps/skipped/disk every 10s (fps 60.0 and a constant skipped count is healthy;
   the counter is OBS-session-lifetime, not per-run).
6. **Afterwards**: `X:\arena-publication\videos` holds `NN-title-slug.mp4`
   (NN = queue position) plus `run-<timestamp>.jsonl` (every event; grep for
   `"fault"` / `"deck-skipped"` — absence = clean run). File count must equal
   deck count. Spot-check at least one file end-to-end (video, word
   highlighting, audio).
7. **Re-record a single deck**: `node record-queue.mjs --only=<id>`, then fix
   the file name's NN prefix (it restarts at 01).

## Troubleshooting — every failure mode we actually hit

| Symptom | Cause | Fix |
|---|---|---|
| File is black, no audio | Capture source bound to wrong/nonexistent window | Rebind: `node launch-kiosk.mjs` (opens the exact runner window), point Window Capture at it |
| File is black, audio present | OBS started BEFORE the capture window existed — source initialized unbound | Fixed in the runner (window launches first, then OBS). If it recurs: rebind the source while the window is up |
| Wrong window in the recording | Executable fallback latched onto another Chrome window | Keep no other Chrome windows open during runs |
| Chrome window flashes and dies | Launched via PowerShell `Start-Process` — it mangles args containing spaces (`--user-data-dir` path split) | Only ever launch via `node launch-kiosk.mjs` (same spawn as the runner) |
| `Cannot find module ...record-queue.mjs` | Ran from repo root | `cd server` first |
| `ready` never posts / page stuck | No active recording session (recording=1 without a runner) | Start the runner; it registers the session the page needs |
| fps dips in stats | GPU/CPU contention | Logs are informational; recording is still valid. 60fps held with the GPU fully loaded by embedding backfill |

## Files

- `server/record-queue.mjs` — the runner (start here to read the code)
- `server/launch-kiosk.mjs` — opens the kiosk window exactly as the runner does (for OBS binding)
- `server/obs-probe.mjs` — one-shot OBS websocket reachability check
- `server/server.js` — `/api/record/*` session endpoints (RAM-only, before the static middleware)
- `web/js/pages/render.js` — autonomous recording mode (`recording=1` fragment param)
- `web/css/main.css` — `.render-recording` styles (hidden chrome, black bg, cursor:none)
- `X:\arena-publication\videos` — output MP4s + JSONL run logs (MCP storage mount)
- `captures/chrome-profile` — local kiosk Chrome profile (never on the mount)
