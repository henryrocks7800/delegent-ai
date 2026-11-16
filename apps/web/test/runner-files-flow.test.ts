import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  createRunnerFileDownloadToken,
  handleRunnerFileDownloadRequest,
  handleRunnerFilesListRequest,
  type RunnerFilesServerEnv,
  type RunnerFilesStore,
} from '../lib/server/runnerFilesFlow';

const userId = '11111111-1111-4111-8111-111111111111';
const fileId = 'file_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const readyEnv: RunnerFilesServerEnv = {
  SUPABASE_URL: 'https://sidekick-test.supabase.co',
  SUPABASE_ANON_KEY: 'anon_test_key',
  SUPABASE_SERVICE_ROLE_KEY: 'service_role_test_key',
  SIDEKICK_FILE_LINK_SIGNING_SECRET: 'fixture_file_link_secret',
};

class InMemoryRunnerFilesStore implements RunnerFilesStore {
  binding = {
    userId,
    runnerBaseUrl: 'https://runner.sidekick.test',
    runnerSharedSecret: 'fixture_runner_secret',
  };
  calls: string[] = [];

  async getRunnerBinding(requestedUserId: string) {
    this.calls.push(requestedUserId);
    return requestedUserId === this.binding.userId ? this.binding : null;
  }
}

function listRequest(headers: Record<string, string> = { authorization: 'Bearer access_token' }) {
  return new Request('https://dashboard.sidekick.example/api/files/runner', {
    method: 'GET',
    headers,
  });
}

function expectedRunnerToken(secret: string, timestamp: number) {
  const signature = createHmac('sha256', secret).update(`v1:${userId}:${timestamp}`).digest('hex');
  return `v1.${signature}`;
}

function assertSafeResponse(text: string) {
  assert.doesNotMatch(text, /fixture_runner_secret|service_role_test_key|fixture_file_link_secret|access_token|\/data\/hermes|SIDEKICK_RUNNER_SHARED_SECRET/i);
}

test('runner file list requires server config and app auth before contacting runner storage', async () => {
  const store = new InMemoryRunnerFilesStore();
  let fetchCalls = 0;
  const missingConfig = await handleRunnerFilesListRequest(listRequest(), {
    env: { ...readyEnv, SUPABASE_SERVICE_ROLE_KEY: '' },
    store,
    fetchRunner: async () => {
      fetchCalls += 1;
      return Response.json({ ok: true, files: [] });
    },
    async getAuthenticatedUser() {
      throw new Error('auth should not run before readiness passes');
    },
  });
  const missingConfigText = await missingConfig.text();
  assert.equal(missingConfig.status, 503);
  assert.deepEqual(JSON.parse(missingConfigText), {
    error: 'runner_files_unavailable',
    missing: ['SUPABASE_SERVICE_ROLE_KEY'],
  });
  assert.deepEqual(store.calls, []);
  assert.equal(fetchCalls, 0);
  assertSafeResponse(missingConfigText);

  const unauthenticated = await handleRunnerFilesListRequest(listRequest({}), {
    env: readyEnv,
    store,
    fetchRunner: async () => {
      fetchCalls += 1;
      return Response.json({ ok: true, files: [] });
    },
    async getAuthenticatedUser() {
      throw new Error('auth should not run without a bearer token');
    },
  });
  const unauthenticatedText = await unauthenticated.text();
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(JSON.parse(unauthenticatedText), { error: 'unauthenticated' });
  assert.deepEqual(store.calls, []);
  assert.equal(fetchCalls, 0);
  assertSafeResponse(unauthenticatedText);
});

test('runner file list signs runner request and returns only safe app download URLs', async () => {
  const store = new InMemoryRunnerFilesStore();
  const runnerRequests: Array<{ url: string; headers: Headers }> = [];
  const response = await handleRunnerFilesListRequest(listRequest(), {
    env: readyEnv,
    store,
    now: () => 1770000000,
    async getAuthenticatedUser(token) {
      assert.equal(token, 'access_token');
      return { id: userId };
    },
    async fetchRunner(input, init) {
      const url = input instanceof Request ? input.url : String(input);
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      runnerRequests.push({ url, headers });
      return Response.json({
        ok: true,
        truncated: false,
        files: [
          {
            id: fileId,
            name: 'report.txt',
            relativeName: 'reports/report.txt',
            sizeBytes: 1234,
            modifiedAt: 1770000100,
            mimeType: 'text/plain',
            downloadable: true,
            path: '/data/hermes/workspace/reports/report.txt',
            runnerSharedSecret: 'fixture_runner_secret',
          },
          {
            id: 'not-safe',
            name: '.env',
            sizeBytes: 10,
            modifiedAt: 1770000100,
            mimeType: 'text/plain',
            downloadable: true,
          },
        ],
      });
    },
  });

  const text = await response.text();
  assert.equal(response.status, 200);
  assertSafeResponse(text);
  assert.equal(runnerRequests.length, 1);
  assert.equal(runnerRequests[0].url, 'https://runner.sidekick.test/files');
  assert.equal(runnerRequests[0].headers.get('x-sidekick-user-id'), userId);
  assert.equal(runnerRequests[0].headers.get('x-sidekick-runner-timestamp'), '1770000000');
  assert.equal(runnerRequests[0].headers.get('x-sidekick-runner-token'), expectedRunnerToken('fixture_runner_secret', 1770000000));

  const payload = JSON.parse(text);
  assert.equal(payload.ok, true);
  assert.equal(payload.storageStatus, 'ready');
  assert.equal(payload.truncated, false);
  assert.equal(payload.files.length, 1);
  assert.deepEqual(payload.files[0], {
    id: fileId,
    name: 'report.txt',
    relativeName: 'reports/report.txt',
    sizeBytes: 1234,
    modifiedAt: 1770000100,
    mimeType: 'text/plain',
    downloadable: true,
    downloadUrl: `https://dashboard.sidekick.example/api/files/runner/${fileId}?token=${payload.files[0].downloadToken}`,
    downloadToken: payload.files[0].downloadToken,
  });
  assert.match(payload.files[0].downloadToken, /^v1\.1770000300\./);
});

test('runner file list reports storage not ready without leaking private runner binding fields', async () => {
  const store = new InMemoryRunnerFilesStore();
  store.binding.runnerBaseUrl = '';
  const response = await handleRunnerFilesListRequest(listRequest(), {
    env: readyEnv,
    store,
    fetchRunner: async () => {
      throw new Error('runner should not be contacted without a usable binding');
    },
    async getAuthenticatedUser() {
      return { id: userId };
    },
  });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(text), {
    ok: true,
    storageStatus: 'not_ready',
    files: [],
    truncated: false,
    publicMessage: "Your coworker's cloud space is still coming online.",
  });
  assertSafeResponse(text);
});

test('runner file download validates short-lived app token and proxies the runner file safely', async () => {
  const store = new InMemoryRunnerFilesStore();
  const token = createRunnerFileDownloadToken({
    userId,
    fileId,
    signingSecret: readyEnv.SIDEKICK_FILE_LINK_SIGNING_SECRET!,
    now: 1770000000,
    ttlSeconds: 300,
  });
  const runnerRequests: Array<{ url: string; headers: Headers }> = [];

  const response = await handleRunnerFileDownloadRequest(
    new Request(`https://dashboard.sidekick.example/api/files/runner/${fileId}?token=${token}`, { method: 'GET' }),
    fileId,
    {
      env: readyEnv,
      store,
      now: () => 1770000020,
      async fetchRunner(input, init) {
        const url = input instanceof Request ? input.url : String(input);
        const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
        runnerRequests.push({ url, headers });
        return new Response('download me', {
          status: 200,
          headers: {
            'content-type': 'text/plain',
            'content-disposition': 'attachment; filename="report.txt"',
            'cache-control': 'public, max-age=86400',
          },
        });
      },
    },
  );

  const text = await response.text();
  assert.equal(response.status, 200);
  assert.equal(text, 'download me');
  assert.equal(response.headers.get('content-type'), 'text/plain');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="report.txt"');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(runnerRequests.length, 1);
  assert.equal(runnerRequests[0].url, `https://runner.sidekick.test/files/${fileId}`);
  assert.equal(runnerRequests[0].headers.get('x-sidekick-runner-token'), expectedRunnerToken('fixture_runner_secret', 1770000020));
});

test('runner file preview range forwards a bounded byte range instead of full downloading the file', async () => {
  const store = new InMemoryRunnerFilesStore();
  const token = createRunnerFileDownloadToken({
    userId,
    fileId,
    signingSecret: readyEnv.SIDEKICK_FILE_LINK_SIGNING_SECRET!,
    now: 1770000000,
    ttlSeconds: 300,
  });
  const runnerRequests: Array<{ url: string; headers: Headers }> = [];

  const response = await handleRunnerFileDownloadRequest(
    new Request(`https://dashboard.sidekick.example/api/files/runner/${fileId}?token=${token}`, {
      method: 'GET',
      headers: { range: 'bytes=0-7' },
    }),
    fileId,
    {
      env: readyEnv,
      store,
      now: () => 1770000020,
      async fetchRunner(input, init) {
        const url = input instanceof Request ? input.url : String(input);
        const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
        runnerRequests.push({ url, headers });
        assert.equal(headers.get('range'), 'bytes=0-7');
        return new Response('preview!', {
          status: 206,
          headers: {
            'content-type': 'text/plain',
            'content-disposition': 'attachment; filename="report.txt"',
            'content-length': '8',
            'content-range': 'bytes 0-7/64',
            'cache-control': 'public, max-age=86400',
          },
        });
      },
    },
  );

  const text = await response.text();
  assert.equal(response.status, 206);
  assert.equal(text, 'preview!');
  assert.equal(response.headers.get('content-range'), 'bytes 0-7/64');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(runnerRequests.length, 1);
  assert.equal(runnerRequests[0].url, `https://runner.sidekick.test/files/${fileId}`);
});

test('runner file download rejects tampered or expired app tokens before runner contact', async () => {
  const store = new InMemoryRunnerFilesStore();
  let fetchCalls = 0;
  const expiredToken = createRunnerFileDownloadToken({
    userId,
    fileId,
    signingSecret: readyEnv.SIDEKICK_FILE_LINK_SIGNING_SECRET!,
    now: 1770000000,
    ttlSeconds: 10,
  });

  const expired = await handleRunnerFileDownloadRequest(
    new Request(`https://dashboard.sidekick.example/api/files/runner/${fileId}?token=${expiredToken}`, { method: 'GET' }),
    fileId,
    {
      env: readyEnv,
      store,
      now: () => 1770000100,
      async fetchRunner() {
        fetchCalls += 1;
        return new Response('should not happen');
      },
    },
  );
  assert.equal(expired.status, 401);
  assert.equal(fetchCalls, 0);
  assertSafeResponse(await expired.text());

  const tampered = await handleRunnerFileDownloadRequest(
    new Request(`https://dashboard.sidekick.example/api/files/runner/${fileId}?token=${expiredToken}x`, { method: 'GET' }),
    fileId,
    {
      env: readyEnv,
      store,
      now: () => 1770000001,
      async fetchRunner() {
        fetchCalls += 1;
        return new Response('should not happen');
      },
    },
  );
  assert.equal(tampered.status, 401);
  assert.equal(fetchCalls, 0);
  assertSafeResponse(await tampered.text());
});
