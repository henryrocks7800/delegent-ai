// DN1.4-01 — defense-in-depth sanitization of assistant reply content
// before it is persisted to messages.content and rendered in the chat
// bubble. Verifies that known raw runtime / provider failure
// signatures are replaced with the safe-copy fallback and that
// real assistant replies pass through unchanged.
//
// Source under test: sanitizeAssistantReply in apps/worker/src/index.ts.
// IMPORTANT: runs against ../dist/index.js. Always `npm test` from the
// worker workspace so the build runs first.

import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeAssistantReply, DN1_4_01_SAFE_COPY } from "../dist/index.js";

test("DN1.4-01 — sanitizer is exported and exposes the safe-copy constant", () => {
  assert.equal(typeof sanitizeAssistantReply, "function");
  assert.match(DN1_4_01_SAFE_COPY, /try again in a moment/i);
  // Alex 2026-09-16: a generic failure has to name the way out of a conversation
  // that is itself stuck, or people resend into it and never escape.
  assert.match(DN1_4_01_SAFE_COPY, /start a fresh chat from the menu in the app/i);
});

test("DN1.4-01 — clean assistant replies pass through unchanged", () => {
  const ok = sanitizeAssistantReply("OK");
  assert.equal(ok.replaced, false);
  assert.equal(ok.text, "OK");
  assert.equal(ok.reason, "");

  const friendly = sanitizeAssistantReply("Got it — I will send the email and follow up tomorrow.");
  assert.equal(friendly.replaced, false);
  assert.equal(friendly.text, "Got it — I will send the email and follow up tomorrow.");

  const empty = sanitizeAssistantReply("");
  assert.equal(empty.replaced, false);
  assert.equal(empty.text, "");
});

test("DN1.4-01 — the exact 2026-05-17 14:44 + 06:40 banners are sanitised", () => {
  // The exact raw text observed in Alex's `messages` table for the
  // failing runs before the fix. If any of these reach the user they
  // are leaking runtime internals.
  const henryBanner = [
    "API call failed after 3 retries: HTTP 502: Error code: 502 - {'error':",
    "'model request failed'}",
    "──────────────────────────────────────────────────────────────────────────────",
    "Resume this session with:",
    "hermes --resume 20260517_144451_258f12",
    "Session: ...",
  ].join("\n");
  const out = sanitizeAssistantReply(henryBanner);
  assert.equal(out.replaced, true, "raw Hermes banner must be sanitised");
  assert.equal(out.text, DN1_4_01_SAFE_COPY);
  // Sentinel content must not survive
  assert.doesNotMatch(out.text, /HTTP 502/);
  assert.doesNotMatch(out.text, /hermes --resume/i);
  assert.doesNotMatch(out.text, /Resume this session/i);
  assert.doesNotMatch(out.text, /model request failed/i);
});

test("DN1.4-01 — each individual raw-error pattern is independently caught", () => {
  const patterns = [
    "API call failed after 3 retries",
    "Resume this session with:",
    "hermes --resume abc123",
    "HTTP 502",
    "HTTP 503",
    "Error code: 504",
    "No endpoints found for some/model",
    "PermissionDeniedError",
    "Non-retryable client error",
    "Traceback (most recent call last):",
    "model request failed",
    "insufficient credits",
    "insufficient_credits",
  ];
  for (const p of patterns) {
    const out = sanitizeAssistantReply(p);
    assert.equal(out.replaced, true, `must sanitize: ${p}`);
    assert.equal(out.text, DN1_4_01_SAFE_COPY);
    assert.notEqual(out.reason, "");
  }
});

test("DN1.4-01 — a normal reply that happens to mention small numbers like 'HTTP' is NOT mis-sanitised", () => {
  // The sanitizer should be specific enough that ordinary conversational
  // text isn't replaced. The `\bHTTP\s+5\d\d\b` pattern requires the full
  // 3-digit code, so casual mentions of HTTP don't trip it.
  const ok = sanitizeAssistantReply("I drafted an HTTP request and will send the response shortly.");
  assert.equal(ok.replaced, false);
  assert.match(ok.text, /HTTP request/);

  const okStatus = sanitizeAssistantReply("Status 200 — all good!");
  assert.equal(okStatus.replaced, false);
});

test("DN1.4-01 — multi-line replies that embed a banner are sanitised whole", () => {
  // Even if the model wraps the error with friendly chat-style chrome,
  // the banner inside still triggers replacement — we never want the
  // raw runtime detail rendered, regardless of surrounding text.
  const wrapped = [
    "Sorry, something broke. Details below:",
    "API call failed after 3 retries: HTTP 502: model request failed",
    "Resume this session with: hermes --resume abc",
  ].join("\n");
  const out = sanitizeAssistantReply(wrapped);
  assert.equal(out.replaced, true);
  assert.equal(out.text, DN1_4_01_SAFE_COPY);
  assert.doesNotMatch(out.text, /Sorry, something broke/);
});
