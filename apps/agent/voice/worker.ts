/**
 * Live Talk (beta, since 2026-09-28): Talk that IS the coworker, not a relay.
 *
 * The first Talk (the orb, still what iPhone uses) is a separate realtime model
 * that only files a task. This Worker instead listens with Workers AI (Deepgram
 * Flux, which also decides when the person has finished; Nova-3 if Flux will
 * not start or drops), hands each finished sentence to the coworker EXACTLY as
 * a typed chat message (POST /api/chat/runs on the production Worker, with the
 * person's own session), and speaks the reply as it streams back (Deepgram
 * Aura). The coworker's model, memory, tools, connections, approvals, token
 * allowance and chat record are therefore the normal ones, and the engine and
 * the production Worker needed no change.
 *
 * Talk minutes are metered by the production Worker's own Talk endpoints, with
 * the person's session: the mint at the start (which refuses without a
 * subscription or with no Talk time left, and says how many seconds remain)
 * and the settle at the end (which records the seconds used).
 *
 * Its own Worker (`delegent-voice`, wrangler.voice.jsonc) and Durable Object,
 * so it can be switched off or removed without touching anything else:
 * - LIVE_TALK_ENABLED "false": /session answers `live_talk_off` and the app
 *   falls back to the orb at once, with no app update;
 * - `npx wrangler delete -c wrangler.voice.jsonc` removes it entirely (the app
 *   falls back the same way).
 *
 *   POST /session                     Authorization: Bearer <Supabase session>
 *                                     -> { ticket, name, maxSeconds }
 *   GET  /agents/voice-call/<userId>?ticket=...   the call (WebSocket)
 */
import { Agent, getAgentByName, routeAgentRequest, type Connection, type ConnectionContext } from 'agents';
import {
  withVoice,
  WorkersAIFluxSTT,
  WorkersAINova3STT,
  WorkersAITTS,
  type Transcriber,
  type TranscriberSession,
  type TranscriberSessionOptions,
  type VoiceTurnContext,
} from 'agents/voice';

interface VoiceEnv {
  AI: { run(model: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> };
  VoiceCall: DurableObjectNamespace<VoiceCall>;
  API_BASE: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  /** Comma-separated user ids, or "*" for everyone with a subscription. */
  ALLOWED_USER_IDS: string;
  /** "false" switches live Talk off for everyone: the app falls back to the orb. */
  LIVE_TALK_ENABLED?: string;
  TTS_SPEAKER?: string;
  /** "nova" makes Nova-3 the first choice for listening, Flux the backup. */
  STT_PRIMARY?: string;
}

/** The production Worker's own cap for one Talk session. */
const CALL_MAX_SECONDS = 600;
const TICKET_TTL_MS = 60 * 1000;
/** Spoken aloud before the rest is left to the chat. */
const SPOKEN_CHAR_CAP = 600;
/** Say "On it" if nothing speakable has arrived this long after the person finished. */
const FILLER_AFTER_MS = 2200;
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '600',
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });
const sleep = (ms: number) => new Promise<'tick'>((resolve) => setTimeout(() => resolve('tick'), ms));

interface CallAuth { userId: string; token: string; maxSeconds: number }

/** Markdown and links do not read aloud: keep the words. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~>|#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function spokenError(status: number, code: unknown): string {
  if (status === 402 || code === 'quota_exhausted') return "You've used this month's allowance, so I can't take that on right now.";
  if (status === 409) return "I'm still finishing the last thing. Give me a moment and ask again.";
  if (status === 401) return 'Your session has expired. Close Talk and open it again.';
  return "Sorry, I couldn't start that just now. Try again in a moment.";
}

/**
 * The Workers AI binding, with retries and a log line (the voice kit hides the
 * reason). Flux answered about one connect in three with a plain error response
 * instead of a WebSocket on 2026-09-28.
 */
function retryingAi(ai: VoiceEnv['AI']): VoiceEnv['AI'] {
  return {
    async run(model, input, options) {
      for (let attempt = 1; ; attempt++) {
        const t = Date.now();
        try {
          const out = (await ai.run(model, input, options)) as ({ webSocket?: unknown; status?: number; text?: () => Promise<string> }) | undefined;
          if (!options?.websocket || out?.webSocket) return out;
          const detail = typeof out?.text === 'function' ? (await out.text().catch(() => '')).slice(0, 200) : '';
          console.log(`[live-talk] ${model} attempt ${attempt}: no websocket after ${Date.now() - t} ms, status ${out?.status ?? '?'} ${detail}`);
          if (attempt >= 3) return out;
        } catch (e) {
          console.log(`[live-talk] ${model} attempt ${attempt} failed after ${Date.now() - t} ms: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
          if (attempt >= 3) throw e;
        }
        await sleep(200 * attempt);
      }
    },
  };
}

/**
 * Listening that does not end the call when one model fails: Flux first (it
 * decides when the person has finished speaking), and if Flux will not start,
 * or drops mid-call, Nova-3 takes over for the rest of the call.
 */
export class FallbackTranscriber implements Transcriber {
  constructor(private readonly primary: Transcriber, private readonly backup: Transcriber) {}

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    let active: TranscriberSession;
    let onBackup = false;
    let closed = false;
    const toBackup = (why: string) => {
      if (onBackup || closed) return false;
      onBackup = true;
      console.log(`[live-talk] listening moved to the backup model: ${why}`);
      try { active.close(); } catch { /* already gone */ }
      active = this.backup.createSession(options);
      return true;
    };
    active = this.primary.createSession({
      ...options,
      onFatalError: (error) => {
        if (!toBackup(`first model dropped (${error.message})`)) options?.onFatalError?.(error);
      },
    });
    return {
      feed: (chunk) => active.feed(chunk),
      waitUntilReady: async () => {
        try {
          await active.waitUntilReady?.();
        } catch (error) {
          if (!toBackup(`first model would not start (${error instanceof Error ? error.message : String(error)})`)) throw error;
          await active.waitUntilReady?.();
        }
      },
      updateAgentContext: (text) => active.updateAgentContext?.(text),
      close: () => { closed = true; active.close(); },
    };
  }
}

const VoiceBase = withVoice(Agent, { historyLimit: 0, maxMessageCount: 40 });

export class VoiceCall extends VoiceBase<VoiceEnv> {
  // Flux with defaults: passing keyterms made it fail to start (2026-09-28).
  // STT_PRIMARY "nova" puts Nova-3 first, if Flux ever proves unreliable.
  transcriber = this.env.STT_PRIMARY === 'nova'
    ? new FallbackTranscriber(new WorkersAINova3STT(retryingAi(this.env.AI)), new WorkersAIFluxSTT(retryingAi(this.env.AI)))
    : new FallbackTranscriber(new WorkersAIFluxSTT(retryingAi(this.env.AI)), new WorkersAINova3STT(retryingAi(this.env.AI)));
  tts = new WorkersAITTS(this.env.AI, { speaker: this.env.TTS_SPEAKER || 'helios' });

  #calls = new Map<string, CallAuth>();
  #callStarted = new Map<string, number>();
  #callTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Called by the Worker once the session and the Talk allowance are checked. */
  async prepareCall(auth: CallAuth): Promise<{ ticket: string }> {
    const ticket = crypto.randomUUID();
    await this.ctx.storage.put(`ticket:${ticket}`, { ...auth, expires: Date.now() + TICKET_TTL_MS });
    return { ticket };
  }

  async onConnect(connection: Connection, ctx: ConnectionContext) {
    const ticket = new URL(ctx.request.url).searchParams.get('ticket') ?? '';
    const key = `ticket:${ticket}`;
    const held = ticket ? await this.ctx.storage.get<CallAuth & { expires: number }>(key) : undefined;
    if (held) await this.ctx.storage.delete(key);
    if (!held || held.expires < Date.now()) {
      connection.close(4001, 'unauthorised');
      return;
    }
    this.#calls.set(connection.id, { userId: held.userId, token: held.token, maxSeconds: held.maxSeconds });
  }

  beforeCallStart(connection: Connection) {
    return this.#calls.has(connection.id);
  }

  async onCallStart(connection: Connection) {
    const auth = this.#calls.get(connection.id);
    this.#callStarted.set(connection.id, Date.now());
    const limit = Math.max(30, Math.min(CALL_MAX_SECONDS, auth?.maxSeconds ?? CALL_MAX_SECONDS));
    this.#callTimers.set(connection.id, setTimeout(() => {
      void this.speak(connection, "That's the Talk time for now. Everything we said is in the chat.")
        .finally(() => setTimeout(() => this.forceEndCall(connection), 4000));
    }, limit * 1000));
    await this.speak(connection, 'Hi. What can I do for you?');
  }

  async onCallEnd(connection: Connection) {
    const timer = this.#callTimers.get(connection.id);
    if (timer) clearTimeout(timer);
    this.#callTimers.delete(connection.id);
    const started = this.#callStarted.get(connection.id);
    this.#callStarted.delete(connection.id);
    const auth = this.#calls.get(connection.id);
    this.#calls.delete(connection.id);
    // The chat holds the real record; the voice kit's own copy goes.
    try { this.sql`DELETE FROM cf_voice_messages`; } catch { /* nothing stored yet */ }
    if (started && auth) {
      // Record the minutes against the Talk allowance, the same way the orb does.
      const seconds = Math.max(1, Math.ceil((Date.now() - started) / 1000));
      await fetch(`${this.env.API_BASE.replace(/\/+$/, '')}/api/voice/session/settle`, {
        method: 'POST',
        headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ seconds, reason: 'live_talk' }),
      }).catch(() => console.log(`[live-talk] settle failed for ${seconds}s`));
    }
  }

  onClose(connection: Connection) {
    this.#calls.delete(connection.id);
  }

  async onTurn(transcript: string, context: VoiceTurnContext) {
    return this.#relay(transcript, context);
  }

  /** One spoken turn: send it as a chat message, speak the reply as it streams. */
  async *#relay(transcript: string, context: VoiceTurnContext): AsyncGenerator<string> {
    const auth = this.#calls.get(context.connection.id);
    if (!auth) { yield 'I lost the connection. Close Talk and open it again.'; return; }
    const base = this.env.API_BASE.replace(/\/+$/, '');
    const headers = { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' };
    const turnStart = Date.now();
    let saidFiller = false;

    // Starting a reply takes the production Worker a couple of seconds, so the
    // "On it" clock starts when the person finished, not when the reply opens.
    const posting = fetch(`${base}/api/chat/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ conversationId: auth.userId, message: transcript, clientRunId: crypto.randomUUID() }),
    }).then(async (res) => ({ res, body: (await res.json().catch(() => ({}))) as { runId?: string; taskRunId?: string; error?: string } }))
      .catch(() => null);
    const firstWin = await Promise.race([posting, sleep(FILLER_AFTER_MS)]);
    if (firstWin === 'tick') { saidFiller = true; yield 'On it.'; }
    const posted = await posting;
    if (!posted) { yield spokenError(0, null); return; }
    if (!posted.res.ok) { yield spokenError(posted.res.status, posted.body.error); return; }
    const runId = posted.body.runId || posted.body.taskRunId || '';
    if (!runId) { yield spokenError(0, null); return; }

    // Stream the reply. Not tied to the turn's abort signal: if the person
    // interrupts, the speech stops but the stream is drained, because the
    // production Worker finalises a reply promptly only while it is consumed.
    const events = await fetch(`${base}/api/chat/runs/${encodeURIComponent(runId)}/events`, {
      headers: { authorization: headers.authorization, accept: 'text/event-stream' },
    }).catch(() => null);
    if (!events?.ok || !events.body) { yield saidFiller ? 'The answer will be in the chat.' : 'On it. The answer will be in the chat.'; return; }

    const reader = events.body.getReader();
    const decoder = new TextDecoder();
    let lineBuffer = '';
    let sentenceBuffer = '';
    let segmentText = '';
    let spokenChars = 0;
    let finished = false;
    // ONE outstanding read: a read abandoned when the filler timer wins still
    // consumes its chunk, so starting another would lose it (it lost the whole
    // of a one-word reply on 2026-09-28).
    let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

    const drain = async () => {
      try {
        if (pendingRead) await pendingRead;
        for (;;) { const { done } = await reader.read(); if (done) break; }
      } catch { /* gone */ }
    };

    while (!finished) {
      if (context.signal.aborted) { void drain(); return; }
      const waitMs = saidFiller || spokenChars > 0 ? 30_000 : Math.max(50, FILLER_AFTER_MS - (Date.now() - turnStart));
      pendingRead ??= reader.read();
      const next = await Promise.race([pendingRead, sleep(waitMs)])
        .catch(() => ({ done: true, value: undefined }) as ReadableStreamReadResult<Uint8Array>);
      if (next === 'tick') {
        if (!saidFiller && spokenChars === 0) { saidFiller = true; yield 'On it.'; }
        continue;
      }
      pendingRead = null;
      if (next.done) break;
      lineBuffer += decoder.decode(next.value, { stream: true });
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') { finished = true; break; }
        let ev: { type?: string; event?: string; payload?: Record<string, unknown> };
        try { ev = JSON.parse(raw); } catch { continue; }
        const type = ev.type || ev.event || '';
        const p = (ev.payload ?? ev) as Record<string, unknown>;
        if (type === 'assistant.text.delta' || type === 'text_delta') {
          const d = typeof p.delta === 'string' ? p.delta : typeof p.text === 'string' ? p.text : '';
          sentenceBuffer += d;
          segmentText += d;
        } else if (type === 'assistant.text.completed' || type === 'assistant.text.done') {
          // A short reply can arrive whole: take what the deltas did not give.
          const full = typeof p.text === 'string' ? p.text : '';
          if (full.startsWith(segmentText)) sentenceBuffer += full.slice(segmentText.length);
          segmentText = '';
        } else if (type === 'assistant.approval.requested') {
          sentenceBuffer += ' I need your OK before I do that. It is waiting for you in the chat.';
        } else if (type === 'run.failed') {
          sentenceBuffer += ' Sorry, that did not work. The details are in the chat.';
          finished = true;
        } else if (type === 'run.completed') {
          finished = true;
        }
      }
      // Speak whole sentences as they complete.
      const cut = Math.max(sentenceBuffer.lastIndexOf('. '), sentenceBuffer.lastIndexOf('? '), sentenceBuffer.lastIndexOf('! '), sentenceBuffer.lastIndexOf('\n'));
      const ready = finished ? sentenceBuffer : cut >= 0 ? sentenceBuffer.slice(0, cut + 1) : '';
      if (ready) {
        sentenceBuffer = sentenceBuffer.slice(ready.length);
        const words = speakable(ready);
        if (words) {
          if (spokenChars + words.length > SPOKEN_CHAR_CAP && spokenChars > 0) {
            yield 'The rest is in the chat.';
            void drain();
            return;
          }
          spokenChars += words.length;
          yield words + ' ';
        }
      }
    }
    if (spokenChars === 0) yield saidFiller ? 'Done. It is in the chat.' : 'Done.';
  }
}

async function verifySession(env: VoiceEnv, token: string): Promise<string | null> {
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!res?.ok) return null;
  const user = (await res.json().catch(() => null)) as { id?: string } | null;
  return user?.id && USER_ID.test(user.id) ? user.id : null;
}

function isAllowed(env: VoiceEnv, userId: string): boolean {
  const list = env.ALLOWED_USER_IDS.split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes('*') || list.includes(userId);
}

export default {
  async fetch(request: Request, env: VoiceEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const enabled = env.LIVE_TALK_ENABLED !== 'false';

    if (url.pathname === '/session' && request.method === 'POST') {
      if (!enabled) return json({ error: 'live_talk_off' }, 503);
      const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
      if (!token) return json({ error: 'unauthenticated' }, 401);
      const userId = await verifySession(env, token);
      if (!userId) return json({ error: 'unauthenticated' }, 401);
      if (!isAllowed(env, userId)) return json({ error: 'live_talk_off' }, 503);
      // The Talk allowance and the subscription, exactly as the orb checks
      // them: the production Worker's own mint, with the person's session.
      const mint = await fetch(`${env.API_BASE.replace(/\/+$/, '')}/api/voice/session`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      }).catch(() => null);
      if (!mint) return json({ error: 'voice_mode_unavailable' }, 503);
      const minted = (await mint.json().catch(() => ({}))) as { error?: string; maxSeconds?: number };
      if (!mint.ok) return json({ error: minted.error || 'voice_mode_unavailable' }, mint.status);
      const maxSeconds = Math.min(CALL_MAX_SECONDS, Math.max(0, Number(minted.maxSeconds) || CALL_MAX_SECONDS));
      const stub = await getAgentByName(env.VoiceCall, userId);
      const prepared = await stub.prepareCall({ userId, token, maxSeconds });
      return json({ ticket: prepared.ticket, name: userId, maxSeconds });
    }

    // The call itself. Only an allowed name is routed; the Durable Object then
    // refuses any connection without its one-time ticket.
    const match = url.pathname.match(/^\/agents\/voice-call\/([^/]+)$/);
    if (enabled && match && USER_ID.test(decodeURIComponent(match[1])) && isAllowed(env, decodeURIComponent(match[1]))) {
      const routed = await routeAgentRequest(request, env);
      if (routed) return routed;
    }
    return json({ error: 'not_found' }, 404);
  },
} satisfies ExportedHandler<VoiceEnv>;
