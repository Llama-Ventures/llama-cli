import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOAuthTokenManager } from '../lib/oauth-refresh.mjs';

function fixture(overrides = {}) {
  let bundle = { access_token: 'old-access', refresh_token: 'old-refresh', expires_at: Date.now() + 3600000, issuer: 'https://example.test', resource: 'https://example.test', created_at: 123 };
  let calls = 0;
  let queue = Promise.resolve();
  const manager = createOAuthTokenManager({
    readBundle: async () => bundle,
    writeBundle: async (value) => { bundle = value; },
    withRefreshLock: (fn) => { const result = queue.then(fn); queue = result.catch(() => {}); return result; },
    fetch: async (_url, request) => {
      calls++;
      assert.equal(new URLSearchParams(request.body).get('refresh_token'), 'old-refresh');
      return new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: 'read' }), { status: 200 });
    },
    ...overrides,
  });
  return { manager, get bundle() { return bundle; }, set bundle(value) { bundle = value; }, get calls() { return calls; } };
}

test('valid cached credential makes no renewal request', async () => {
  const f = fixture();
  assert.equal(await f.manager.getValidAccessToken(), 'old-access');
  assert.equal(f.calls, 0);
});
test('expired access renews and persists both credentials without changing login time', async () => {
  const f = fixture(); f.bundle.expires_at = 0;
  assert.equal(await f.manager.getValidAccessToken(), 'new-access');
  assert.equal(f.bundle.refresh_token, 'new-refresh');
  assert.equal(f.bundle.created_at, 123);
});
test('API rejection forces renewal despite a future local expiry', async () => {
  const f = fixture();
  assert.equal(await f.manager.forceRefresh('old-access'), 'new-access');
  assert.equal(f.calls, 1);
});
test('concurrent API rejections rotate once and reuse the replacement', async () => {
  const f = fixture();
  assert.deepEqual(await Promise.all([f.manager.forceRefresh('old-access'), f.manager.forceRefresh('old-access')]), ['new-access', 'new-access']);
  assert.equal(f.calls, 1);
});
test('expired or revoked authorization explicitly requests browser sign-in', async () => {
  const f = fixture({ fetch: async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }) });
  f.bundle.expires_at = 0;
  await assert.rejects(f.manager.getValidAccessToken(), /OAUTH_REAUTH_REQUIRED.*llama auth login/);
  assert.equal(f.bundle.refresh_token, 'old-refresh');
});
test('temporary issuer failure retains credentials and asks for retry', async () => {
  const f = fixture({ fetch: async () => new Response('{}', { status: 503 }) });
  await assert.rejects(f.manager.forceRefresh(), /OAUTH_REFRESH_FAILED.*503/);
  assert.equal(f.bundle.refresh_token, 'old-refresh');
});
