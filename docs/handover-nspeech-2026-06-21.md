# nSpeech Handover — Empty Audio Under Concurrent Load

**Date:** 2026-06-21
**From:** Arena Slides project (`LLM-Chat-Arena-Slides`)
**To:** nSpeech maintainer

---

## How Arena Slides Uses nSpeech

Arena Slides converts LLM-to-LLM conversations into narrated slideshow videos. For each paragraph of conversation, we call nSpeech's `/tts` endpoint to generate an MP3:

```
GET http://<nspeech-host>:2233/tts?text=<spoken-text>&voice_name=<voice>&speed=<speed>&output_format=mp3
```

We use Kokoro as the engine. Typical load: ~128 paragraphs per conversation, each 1–5 sentences.

---

## The Problem: Empty (0-byte) Audio Under Concurrent Load

**Symptom:** When multiple TTS requests are sent in parallel (4 concurrent workers), nSpeech occasionally returns HTTP 200 with a **0-byte response body**. No error status, no error message — just empty bytes.

**Frequency:** ~2-3% of paragraphs fail this way (e.g. 3 out of 128 in a typical conversation).

**Key observations:**
- The same text + voice + speed works perfectly when retried serially.
- The failure is **transient and non-deterministic** — re-requesting the identical parameters succeeds.
- It only happens under concurrent load. With `RENDER_CONCURRENCY=1` (serial requests), we see zero failures.
- The text and voice are not unusual — normal English sentences, standard Kokoro voices (Qwen, Adam_Eric, af_sky, etc.).

**Specific failing example:**
- **Text:** `"You said the dark becomes different when it's shared. Yes. That's exactly it. The dark doesn't disappear, but it changes quality when someone is willing to sit in it with you."`
- **Voice:** `Qwen`, **Speed:** `1.0`
- **Result:** HTTP 200, 0 bytes
- **Retry (same params):** Success, ~170 KB MP3

---

## What We'd Like

1. **Don't return 200 with an empty body.** If Kokoro fails to generate audio, return a 5xx status with an error message in the body. This makes it trivial to detect and retry on the client side.

2. **Investigate the concurrency issue.** Kokoro (CPU-based) may have a race condition or resource contention when handling parallel requests. Possible causes:
   - Model inference collision on shared CPU threads
   - Output buffer not flushed before response is sent
   - Request queue dropping items under load

3. **Log when empty output occurs.** If nSpeech detects a 0-byte generation result, log the input text, voice, and error context so the root cause can be traced.

---

## What We Changed on Our Side (Workaround)

Arena Slides now:
1. **Rejects empty audio** — 0-byte responses are not stored; the paragraph is marked as failed.
2. **Retries TTS up to 3 times** with backoff (500ms, 1s, 1.5s) on empty audio / 5xx / network errors.
3. **Runs `RENDER_CONCURRENCY=1`** (serial) to avoid triggering the bug. This works but slows rendering from ~4 min to ~15 min for a 128-paragraph conversation.

The workaround is functional but we'd prefer to run at higher concurrency for throughput.

---

## Environment

- **nSpeech host:** `192.168.0.145:2233` (HTTP)
- **Engine:** Kokoro
- **Voices used:** `Adam_Eric`, `Qwen`, `af_sky`, `Kimi`, `GLM`
- **Arena Slides server:** Node v24.5.0
- **Typical payload:** 128 paragraphs, each 1–5 sentences, MP3 output

---

## Summary

| Request | Priority |
|---------|----------|
| Return non-200 + error body when TTS produces empty output | High |
| Investigate Kokoro concurrency race condition | High |
| Log empty-output events with input context | Medium |

Happy to provide specific failing text/voice combinations or repro scripts if helpful.
