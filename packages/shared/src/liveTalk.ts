/**
 * Live Talk (beta, 2026-09-28): the voice Worker's address, on the API domain
 * beside api.delegantai.co.uk (note the A), so the app never shows or embeds a
 * workers.dev address. The Worker is apps/agent/voice/worker.ts; its custom
 * domain is declared in apps/agent/wrangler.voice.jsonc. Both hosts pass it to
 * the chat page at init, and an empty value there means the orb.
 */
export const LIVE_TALK_HOST = 'voice.delegantai.co.uk';
