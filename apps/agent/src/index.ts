/**
 * The agent engine's internal API. Reached only by the production Worker through
 * its AGENT service binding (this Worker has no route and no workers.dev
 * address), and every request is signed as the user it acts for (internal.ts).
 *
 *   POST /runs                 start a reply: { runId, message, attachments, agentName }
 *   GET  /runs/:id/events      the reply as run events (SSE), replayed from the start
 *   GET  /runs/:id             the outcome, for the Worker's reconcile
 *   POST /runs/:id/stop        stop a reply
 *   POST /control/reset        start a fresh chat
 *   POST /warm                 get ready before the person sends
 *   GET|POST /files            chat attachments (the runner /files contract)
 *   GET|DELETE /files/:id      one file
 *   POST /files/:id/rename     rename a file
 *   DELETE /account            account deletion: wipe everything held for the user
 *   GET  /ops/turns            timings, tokens and cost of recent replies (no content)
 *   GET  /ops/diagnostics      memory and conversation size, for a reported defect
 *   POST /ops/memory           correct the memory block
 *   GET  /ops/health           the uptime probe: storage and model key (ops-probe only)
 */
import { getAgentByName } from 'agents';
import { Buffer } from 'node:buffer';
import { CoworkerAgent, type AgentEnv, type RunAttachment } from './agent.ts';
import { PROBE_USER, verifyRequest } from './internal.ts';

export { CoworkerAgent };
// Bulk inbox sorting runs as a Cloudflare Workflow (wrangler.jsonc: workflows).
export { InboxSortWorkflow } from './inboxSortWorkflow.ts';
export { MoneyFinderWorkflow } from './moneyFinderWorkflow.ts';

const json = (body: unknown, status = 200) => Response.json(body, { status });

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_ID = /^file_[a-f0-9]{32}$/;
const MAX_MESSAGE_CHARS = 32_000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const SENSITIVE_NAME = /(\.env|secret|token|credential|password|private_key|passwd|apikey|api_key)|\.(pem|key|p12|pfx)$/i;

function attachmentsFrom(value: unknown): RunAttachment[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === 'object')
    .map((a) => ({
      id: String(a.id ?? ''),
      name: String(a.name ?? 'file').slice(0, 200),
      mimeType: String(a.mimeType ?? ''),
      sizeBytes: Number(a.sizeBytes ?? 0),
    }))
    .filter((a) => FILE_ID.test(a.id))
    .slice(0, 10);
}

function safeUploadName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > 200 || /[\\/]/.test(name) || name.startsWith('.') || SENSITIVE_NAME.test(name)) return null;
  return name;
}

export default {
  async fetch(request: Request, env: AgentEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/health') return json({ ok: true, service: 'delegent-agent' });

    const userId = await verifyRequest(request.headers, env.SIDEKICK_AGENT_SHARED_SECRET);
    if (!userId) return json({ error: 'unauthenticated' }, 401);
    const agent = await getAgentByName(env.CoworkerAgent, userId);
    const segments = path.split('/').filter(Boolean);

    // ── Runs ────────────────────────────────────────────────────────────────
    if (path === '/runs' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const runId = typeof body?.runId === 'string' ? body.runId : '';
      const message = typeof body?.message === 'string' ? body.message : '';
      if (!RUN_ID.test(runId)) return json({ error: 'invalid_run_id' }, 400);
      if (message.length > MAX_MESSAGE_CHARS) return json({ error: 'content_too_long' }, 400);
      const result = await agent.startRun({
        runId,
        message,
        attachments: attachmentsFrom(body?.attachments),
        agentName: typeof body?.agentName === 'string' ? body.agentName : null,
      });
      if (result.kind === 'error') return json({ error: result.error }, result.status);
      return json({ ok: true, runId: result.runId, status: result.status }, 201);
    }
    if (segments[0] === 'runs' && segments.length >= 2) {
      const runId = decodeURIComponent(segments[1]);
      if (!RUN_ID.test(runId)) return json({ error: 'invalid_run_id' }, 400);
      if (segments.length === 3 && segments[2] === 'events' && request.method === 'GET') {
        const stream = await agent.openRunStream(runId);
        if (!stream) return json({ error: 'run_not_found' }, 404);
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform' },
        });
      }
      if (segments.length === 3 && segments[2] === 'stop' && request.method === 'POST') {
        const stopped = await agent.stopRun(runId);
        return stopped ? json(stopped) : json({ error: 'run_not_found' }, 404);
      }
      if (segments.length === 2 && request.method === 'GET') {
        const status = await agent.runStatus(runId);
        return status ? json(status) : json({ error: 'run_not_found' }, 404);
      }
    }

    // ── Conversation control ────────────────────────────────────────────────
    if (path === '/control/reset' && request.method === 'POST') return json(await agent.reset());
    if (path === '/warm' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { agentName?: unknown } | null;
      return json(await agent.warm(typeof body?.agentName === 'string' ? body.agentName : null));
    }

    // ── Files ───────────────────────────────────────────────────────────────
    if (path === '/files' && request.method === 'GET') {
      return json({ ok: true, files: await agent.listFiles(), truncated: false });
    }
    if (path === '/files' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const name = safeUploadName(body?.name);
      const contentBase64 = typeof body?.contentBase64 === 'string' ? body.contentBase64 : '';
      if (!name || !contentBase64) return json({ error: 'invalid_request' }, 400);
      if (Math.floor((contentBase64.length * 3) / 4) > MAX_UPLOAD_BYTES + 3) return json({ error: 'file_too_large' }, 413);
      const mime = typeof body?.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(body.mimeType) ? body.mimeType : 'application/octet-stream';
      const stored = await agent.storeFile(name, mime, new Uint8Array(Buffer.from(contentBase64, 'base64')));
      if ('error' in stored) return json({ error: stored.error === 'too_large' ? 'file_too_large' : 'invalid_request' }, stored.error === 'too_large' ? 413 : 400);
      return json({ ok: true, file: { ...stored.file, relativeName: name, downloadable: true } });
    }
    if (segments[0] === 'files' && segments.length >= 2) {
      const fileId = decodeURIComponent(segments[1]);
      if (!FILE_ID.test(fileId)) return json({ error: 'file_not_found' }, 404);
      if (segments.length === 2 && request.method === 'GET') {
        const file = await agent.readFile(fileId);
        if (!file) return json({ error: 'file_not_found' }, 404);
        return new Response(new Uint8Array(file.bytes), {
          headers: {
            'content-type': file.mime,
            'content-length': String(file.bytes.byteLength),
            'content-disposition': `inline; filename="${file.name.replace(/["\\\r\n]/g, '')}"`,
            'cache-control': 'private, no-store',
          },
        });
      }
      if (segments.length === 2 && request.method === 'DELETE') {
        return (await agent.deleteFile(fileId)) ? json({ ok: true }) : json({ error: 'file_not_found' }, 404);
      }
      if (segments.length === 3 && segments[2] === 'rename' && request.method === 'POST') {
        const body = (await request.json().catch(() => null)) as { newName?: unknown } | null;
        const newName = safeUploadName(body?.newName);
        if (!newName) return json({ error: 'invalid_file_name' }, 400);
        return (await agent.renameFile(fileId, newName)) === 'ok' ? json({ ok: true }) : json({ error: 'file_not_found' }, 404);
      }
    }

    // ── Account and operator ────────────────────────────────────────────────
    if (path === '/account' && request.method === 'DELETE') return json(await agent.wipe());
    if (path === '/ops/turns' && request.method === 'GET') {
      return json(await agent.recentTurns(Number(url.searchParams.get('limit') ?? 20)));
    }
    if (path === '/ops/diagnostics' && request.method === 'GET') return json(await agent.diagnostics());
    if (path === '/ops/health' && request.method === 'GET') {
      // Only the probe instance: a customer's own instance is never woken by the uptime check.
      if (userId !== PROBE_USER) return json({ error: 'not_found' }, 404);
      const health = await agent.health();
      return json(health, health.ok ? 200 : 503);
    }
    if (path === '/ops/memory' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { content?: unknown } | null;
      if (typeof body?.content !== 'string') return json({ error: 'content_required' }, 400);
      return json(await agent.setMemory(body.content));
    }

    return json({ error: 'not_found' }, 404);
  },
} satisfies ExportedHandler<AgentEnv>;
