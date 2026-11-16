/**
 * A read-only Composio tool router session for the TEST account, opened the way
 * the engine opens one, plus an app-action mock: searches and schema lookups
 * are real, while every app action is checked against Composio's real input
 * schema and never executed. Composio offers no sandbox of its own, so this is
 * how the 35 connections are exercised without touching anyone's accounts.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import Ajv from 'ajv';
import { PRODUCT_TOOLKITS, NO_AUTH_TOOLKITS, PRELOADED_TOOLS, STRIPE_READ_ONLY_TOOLS } from '../src/toolkits.ts';

export const env = parseEnv(readFileSync(`${homedir()}/.coworker-ai/live-provider.env`, 'utf8'));
export const TEST_USER = '272b9ffd-3097-4d59-a1b4-c0fc2dddffc2';

export async function openSession() {
  const body = { user_id: TEST_USER, toolkits: { enable: [...PRODUCT_TOOLKITS.map((t) => t.slug), ...NO_AUTH_TOOLKITS] },
    auth_configs: Object.fromEntries(PRODUCT_TOOLKITS.map((t) => [t.slug, t.authConfigId])), tools: { stripe: { enable: STRIPE_READ_ONLY_TOOLS } },
    manage_connections: { enable: false }, workbench: { enable: false }, preload: { tools: PRELOADED_TOOLS } };
  const response = await fetch('https://backend.composio.dev/api/v3.1/tool_router/session', { method: 'POST',
    headers: { 'x-api-key': env.COMPOSIO_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`session ${response.status}`);
  const session = await response.json();
  const url = session.mcp.url;
  let sid = null; let id = 0;
  const post = async (payload) => fetch(url, { method: 'POST', headers: { 'x-api-key': env.COMPOSIO_API_KEY, 'content-type': 'application/json',
    accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(payload) });
  const rpc = async (method, params = {}) => {
    const res = await post({ jsonrpc: '2.0', id: ++id, method, params });
    sid = res.headers.get('mcp-session-id') ?? sid;
    const text = await res.text();
    const line = text.startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data:'))?.slice(5);
    const json = JSON.parse(line);
    if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error).slice(0, 300)}`);
    return json.result;
  };
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'delegent-eval', version: '1' } });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const { tools } = await rpc('tools/list');
  const call = async (name, args) => {
    const result = await rpc('tools/call', { name, arguments: args });
    return (result.content ?? []).map((part) => part.text ?? '').join('\n');
  };
  return { tools, call };
}

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const schemaCache = new Map();

/** Real input schema for a tool slug, fetched once through COMPOSIO_GET_TOOL_SCHEMAS. */
export async function inputSchema(session, slug) {
  if (schemaCache.has(slug)) return schemaCache.get(slug);
  const text = await session.call('COMPOSIO_GET_TOOL_SCHEMAS', { tool_slugs: [slug] });
  let schema = null;
  try {
    const parsed = JSON.parse(text);
    const found = JSON.stringify(parsed).includes(slug) ? findSchema(parsed, slug) : null;
    schema = found;
  } catch { schema = null; }
  schemaCache.set(slug, schema);
  return schema;
}
function findSchema(value, slug) {
  if (!value || typeof value !== 'object') return null;
  if ((value.tool_slug === slug || value.slug === slug) && (value.input_schema || value.input_parameters)) return value.input_schema ?? value.input_parameters;
  for (const child of Object.values(value)) { const found = findSchema(child, slug); if (found) return found; }
  return null;
}

export function validate(schema, args) {
  if (!schema) return { ok: false, errors: ['no schema returned for this slug'] };
  const check = ajv.compile(schema);
  const ok = check(args ?? {});
  return { ok, errors: ok ? [] : (check.errors ?? []).slice(0, 4).map((e) => `${e.instancePath || '/'} ${e.message}`) };
}

const WRITE = /_(CREATE|ADD|SEND|UPDATE|DELETE|POST|REPLY|FORWARD|MOVE|INSERT|UPLOAD|REMOVE|PATCH|ARCHIVE|TRASH|SET|INVITE|SHARE|MODIFY|REPLACE|CHARGE|REFUND|CANCEL)/;
export const isWrite = (slug) => WRITE.test(slug);
