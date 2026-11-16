// Unit tests for the file-upload core that backs uploadRunnerFile
// (mobileRunnerFiles.ts). Runs under tsx via test:ts (node --test --import
// tsx). The core is dependency-injected (apiBaseUrl + token resolver + file
// parser + fetch), so these tests exercise the real POST wiring, the 25 MB
// cap, and the response handling with a mocked fetch and no native imports.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MOBILE_RUNNER_UPLOAD_MAX_BYTES,
  decodedBase64ByteLength,
  uploadRunnerFileCore,
  type RunnerFileUploadCoreDeps,
} from './runnerFileUpload';
import type { MobileRunnerFile } from './mobileRunnerFiles';

const API_BASE = 'https://api.example.com';
const ACCESS_TOKEN = 'test-access-token';
const VALID_FILE_ID = 'file_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DOWNLOAD_PATH = `/api/files/runner/${VALID_FILE_ID}?token=v1.signed-token`;

// A faithful stand-in for mobileRunnerFiles' parseRunnerFile: enforces the
// same id shape + a same-origin signed download URL so the test asserts the
// core wires the parser correctly (and attaches the upload-only downloadToken).
function fakeParseFile(value: unknown, apiBaseUrl: string): MobileRunnerFile | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const id = typeof v.id === 'string' ? v.id : '';
  const name = typeof v.name === 'string' ? v.name : '';
  if (!/^file_[a-f0-9]{32}$/.test(id) || !name) return null;
  return {
    id,
    name,
    sizeBytes: typeof v.sizeBytes === 'number' ? v.sizeBytes : 0,
    modifiedAt: typeof v.modifiedAt === 'number' ? v.modifiedAt : 0,
    mimeType: typeof v.mimeType === 'string' ? v.mimeType : 'application/octet-stream',
    downloadable: v.downloadable !== false,
    downloadUrl: `${apiBaseUrl}${DOWNLOAD_PATH}`,
  };
}

function okFilePayload(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    file: {
      id: VALID_FILE_ID,
      name: 'report.pdf',
      relativeName: 'documents/report.pdf',
      sizeBytes: 1234,
      modifiedAt: 1_700_000_000_000,
      mimeType: 'application/pdf',
      downloadable: true,
      downloadUrl: `${API_BASE}${DOWNLOAD_PATH}`,
      downloadToken: 'v1.download-token',
      ...overrides,
    },
  };
}

// Build a syntactically valid base64 string that decodes to exactly
// `bytes` bytes (using 'A' for data and the correct trailing padding), so
// the cap-boundary tests can target an exact decoded size.
function base64StringForByteLength(bytes: number): string {
  const fullGroups = Math.floor(bytes / 3);
  const remainder = bytes % 3; // 0, 1, or 2 leftover bytes
  let out = 'A'.repeat(fullGroups * 4);
  if (remainder === 1) out += 'AA==';
  else if (remainder === 2) out += 'AAA=';
  return out;
}

type FetchCall = { url: string; init?: RequestInit };

// Build a mock fetch that records its single call and returns a canned
// Response. We construct a real Response so response.json()/status behave
// exactly like the production fetch path.
function mockFetch(status: number, body: unknown): { fetchImpl: RunnerFileUploadCoreDeps['fetchImpl']; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

function baseDeps(over: Partial<RunnerFileUploadCoreDeps> = {}): RunnerFileUploadCoreDeps {
  return {
    apiBaseUrl: API_BASE,
    resolveAccessToken: async () => ACCESS_TOKEN,
    parseFile: fakeParseFile,
    fetchImpl: mockFetch(200, okFilePayload()).fetchImpl,
    ...over,
  };
}

test('uploadRunnerFileCore POSTs to /api/files/runner with bearer auth + JSON body', async () => {
  const { fetchImpl, calls } = mockFetch(200, okFilePayload());
  const result = await uploadRunnerFileCore(baseDeps({ fetchImpl }), {
    name: 'report.pdf',
    mimeType: 'application/pdf',
    contentBase64: 'aGVsbG8=', // "hello"
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, `${API_BASE}/api/files/runner`);
  assert.equal(call.init?.method, 'POST');

  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(headers['content-type'], 'application/json');

  const sent = JSON.parse(String(call.init?.body));
  assert.deepEqual(sent, { name: 'report.pdf', mimeType: 'application/pdf', contentBase64: 'aGVsbG8=' });
});

test('uploadRunnerFileCore returns {ok:true, file} on 200 and attaches the download token', async () => {
  const { fetchImpl } = mockFetch(200, okFilePayload());
  const result = await uploadRunnerFileCore(baseDeps({ fetchImpl }), {
    name: 'report.pdf',
    mimeType: 'application/pdf',
    contentBase64: 'aGVsbG8=',
  });

  assert.equal(result.ok, true);
  if (!result.ok) return; // narrow for TS
  assert.equal(result.file.id, VALID_FILE_ID);
  assert.equal(result.file.name, 'report.pdf');
  assert.equal(result.file.mimeType, 'application/pdf');
  assert.equal(result.file.downloadUrl, `${API_BASE}${DOWNLOAD_PATH}`);
  assert.equal(result.file.downloadToken, 'v1.download-token');
});

test('uploadRunnerFileCore omits mimeType from the body when not provided', async () => {
  const { fetchImpl, calls } = mockFetch(200, okFilePayload());
  await uploadRunnerFileCore(baseDeps({ fetchImpl }), {
    name: 'note.txt',
    contentBase64: 'aGVsbG8=',
  });
  const sent = JSON.parse(String(calls[0].init?.body));
  assert.equal('mimeType' in sent, false);
  assert.deepEqual(Object.keys(sent).sort(), ['contentBase64', 'name']);
});

test('uploadRunnerFileCore rejects payloads over the 25 MB cap before any network call', async () => {
  // Build a base64 string whose DECODED size is just over 25 MB.
  const oversizedBase64 = base64StringForByteLength(MOBILE_RUNNER_UPLOAD_MAX_BYTES + 3);
  assert.ok((decodedBase64ByteLength(oversizedBase64) ?? 0) > MOBILE_RUNNER_UPLOAD_MAX_BYTES);

  const { fetchImpl, calls } = mockFetch(200, okFilePayload());
  const result = await uploadRunnerFileCore(baseDeps({ fetchImpl }), {
    name: 'huge.bin',
    mimeType: 'application/octet-stream',
    contentBase64: oversizedBase64,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.reason, 'too_large');
  assert.match(result.error.message, /25 MB/);
  assert.equal(calls.length, 0, 'must not hit the network for an oversized upload');
});

test('uploadRunnerFileCore accepts a payload exactly at the 25 MB cap', async () => {
  // 25 MB ≡ 1 (mod 3), so the exact-cap base64 string ends in one byte of
  // padding ("=="). Build it precisely so decodedBase64ByteLength lands on
  // the cap rather than just under/over it.
  const atCapBase64 = base64StringForByteLength(MOBILE_RUNNER_UPLOAD_MAX_BYTES);
  assert.equal(decodedBase64ByteLength(atCapBase64), MOBILE_RUNNER_UPLOAD_MAX_BYTES);

  const { fetchImpl, calls } = mockFetch(200, okFilePayload());
  const result = await uploadRunnerFileCore(baseDeps({ fetchImpl }), {
    name: 'at-cap.bin',
    contentBase64: atCapBase64,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
});

test('uploadRunnerFileCore returns missing_api_base when the app link is absent', async () => {
  const result = await uploadRunnerFileCore(baseDeps({ apiBaseUrl: null }), {
    name: 'x.txt',
    contentBase64: 'aGVsbG8=',
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.reason, 'missing_api_base');
});

test('uploadRunnerFileCore returns unauthenticated when no access token resolves', async () => {
  const { fetchImpl, calls } = mockFetch(200, okFilePayload());
  const result = await uploadRunnerFileCore(
    baseDeps({ fetchImpl, resolveAccessToken: async () => null }),
    { name: 'x.txt', contentBase64: 'aGVsbG8=' },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.reason, 'unauthenticated');
  assert.equal(calls.length, 0, 'must not POST without a token');
});

test('uploadRunnerFileCore rejects empty name / empty content as invalid_input', async () => {
  const empty = await uploadRunnerFileCore(baseDeps(), { name: '   ', contentBase64: 'aGVsbG8=' });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.error.reason, 'invalid_input');

  const noBody = await uploadRunnerFileCore(baseDeps(), { name: 'x.txt', contentBase64: '' });
  assert.equal(noBody.ok, false);
  if (!noBody.ok) assert.equal(noBody.error.reason, 'invalid_input');
});

test('uploadRunnerFileCore maps a 401 to unauthenticated', async () => {
  const { fetchImpl } = mockFetch(401, { error: 'nope' });
  const result = await uploadRunnerFileCore(baseDeps({ fetchImpl }), {
    name: 'x.txt',
    contentBase64: 'aGVsbG8=',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.reason, 'unauthenticated');
});

test('uploadRunnerFileCore maps a 413 to too_large', async () => {
  const { fetchImpl } = mockFetch(413, { error: 'too big' });
  const result = await uploadRunnerFileCore(baseDeps({ fetchImpl }), {
    name: 'x.txt',
    contentBase64: 'aGVsbG8=',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.reason, 'too_large');
});

test('uploadRunnerFileCore maps a 500 / ok:false / unparseable file to unavailable', async () => {
  const serverError = await uploadRunnerFileCore(
    baseDeps({ fetchImpl: mockFetch(500, { error: 'boom' }).fetchImpl }),
    { name: 'x.txt', contentBase64: 'aGVsbG8=' },
  );
  assert.equal(serverError.ok, false);
  if (!serverError.ok) assert.equal(serverError.error.reason, 'unavailable');

  const okFalse = await uploadRunnerFileCore(
    baseDeps({ fetchImpl: mockFetch(200, { ok: false }).fetchImpl }),
    { name: 'x.txt', contentBase64: 'aGVsbG8=' },
  );
  assert.equal(okFalse.ok, false);
  if (!okFalse.ok) assert.equal(okFalse.error.reason, 'unavailable');

  // 200 + ok:true but a file record that fails the parser (bad id) -> unavailable.
  const badFile = await uploadRunnerFileCore(
    baseDeps({ fetchImpl: mockFetch(200, okFilePayload({ id: 'not-a-file-id' })).fetchImpl }),
    { name: 'x.txt', contentBase64: 'aGVsbG8=' },
  );
  assert.equal(badFile.ok, false);
  if (!badFile.ok) assert.equal(badFile.error.reason, 'unavailable');
});

test('uploadRunnerFileCore never throws when fetch rejects (network failure -> unavailable)', async () => {
  const throwingFetch: RunnerFileUploadCoreDeps['fetchImpl'] = async () => {
    throw new Error('network down');
  };
  const result = await uploadRunnerFileCore(baseDeps({ fetchImpl: throwingFetch }), {
    name: 'x.txt',
    contentBase64: 'aGVsbG8=',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.reason, 'unavailable');
});

test('decodedBase64ByteLength computes real sizes and rejects malformed base64', () => {
  assert.equal(decodedBase64ByteLength('aGVsbG8='), 5); // "hello"
  assert.equal(decodedBase64ByteLength('YWJjZA=='), 4); // "abcd"
  assert.equal(decodedBase64ByteLength('YWJj'), 3); // "abc"
  assert.equal(decodedBase64ByteLength(''), null);
  assert.equal(decodedBase64ByteLength('not base64 *&^'), null);
  assert.equal(decodedBase64ByteLength('abc'), null); // length not a multiple of 4
});
