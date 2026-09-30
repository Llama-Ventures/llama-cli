import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { pkceLoopbackFlow, challengeFor } from '../lib/oauth-flow.mjs';

test('browser approval returns through loopback and exchanges the bound PKCE code', async (t) => {
  let authorize;
  let requests = 0;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/api/oauth/token');
    let body = ''; for await (const chunk of req) body += chunk;
    const values = new URLSearchParams(body);
    assert.equal(challengeFor(values.get('code_verifier')), authorize.searchParams.get('code_challenge'));
    assert.equal(values.get('redirect_uri'), authorize.searchParams.get('redirect_uri'));
    assert.equal(values.get('code'), 'synthetic-single-use-code');
    requests++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, scope: 'read' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let callback;
  const result = await pkceLoopbackFlow({ baseUrl, resource: baseUrl, scope: 'read', launchBrowser(url) {
    authorize = new URL(url);
    const redirect = new URL(authorize.searchParams.get('redirect_uri'));
    redirect.searchParams.set('state', authorize.searchParams.get('state'));
    redirect.searchParams.set('code', 'synthetic-single-use-code');
    callback = fetch(redirect).then(r => r.text());
  } });
  await callback;
  assert.equal(requests, 1);
  assert.equal(result.access_token, 'synthetic-access');
});

for (const validState of [true, false]) test(`denial validates state first (${validState}) and escapes callback content`, async () => {
  let callback;
  const flow = pkceLoopbackFlow({ baseUrl: 'http://127.0.0.1:1', resource: 'http://127.0.0.1:1', scope: 'read', launchBrowser(url) {
    const auth = new URL(url); const redirect = new URL(auth.searchParams.get('redirect_uri'));
    redirect.searchParams.set('state', validState ? auth.searchParams.get('state') : 'wrong');
    redirect.searchParams.set('error', 'access_denied');
    redirect.searchParams.set('error_description', '<script>unsafe()</script>');
    callback = fetch(redirect).then(r => r.text());
  } });
  await assert.rejects(flow, validState ? /OAUTH_DENIED/ : /OAUTH_BAD_STATE/);
  const html = await callback;
  assert.equal(html.includes('<script>unsafe()'), false);
});
