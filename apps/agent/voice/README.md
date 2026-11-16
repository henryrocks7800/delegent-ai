# Live Talk (beta)

Talk on Android since 2026-09-28: a spoken conversation with the coworker itself.
`worker.ts` listens (Workers AI Deepgram Flux, Nova-3 as the backup), sends each
finished sentence to the coworker as an ordinary chat message
(`POST /api/chat/runs` on the production Worker, with the person's own session)
and speaks the reply (Deepgram Aura). Talk minutes go through the production
Worker's own Talk mint and settle, so the allowance is the one the orb uses.
iPhone keeps the orb (WKWebView cannot cancel echo).

| Job | Command, from `apps/agent` |
|---|---|
| Deploy | `npx wrangler deploy -c wrangler.voice.jsonc --var SUPABASE_ANON_KEY:<public anon key from the mirror>` |
| Switch off for everyone (the app opens the orb instead, no app update) | redeploy with `--var LIVE_TALK_ENABLED:false` |
| Listening model first choice | `--var STT_PRIMARY:nova` makes Nova-3 first and Flux the backup |
| Remove entirely (the app falls back the same way) | `npx wrangler delete -c wrangler.voice.jsonc` |
| Watch it | `npx wrangler tail -c wrangler.voice.jsonc` (look for `[live-talk]` lines: retries and model switches) |
| One call from this box, with a synthesised voice | `node voice/probe.mjs <16 kHz mono wav> [host]` |
| The phone path in Chrome, a WAV as the microphone | `node voice/browser-check.mjs <wav>` |

The chat page carries the client (`agents/voice/client`) inlined, built with
`npx esbuild voice/client-entry.ts --bundle --format=iife --minify --target=es2020`
and pasted into the `<script>` just before the main one in
`apps/mobile/assets/chat-webview/index.html`. Rebuild it when `agents` is
upgraded, and pin `agents`: its voice API is marked experimental.

Traps found building it (2026-09-28): Flux fails to start when given
`keyterms`; Flux answers about one connect in three with an error instead of a
WebSocket (hence the retries and the Nova-3 backup); a stream read abandoned by
a timer still eats its chunk, so keep one outstanding read; `startCall()` before
the socket is open fails with "not connected"; a tap on the glass reached the
default interrupt threshold, so the client needs half a second of speech.
