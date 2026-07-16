import assert from "node:assert/strict";
import test from "node:test";

import { extractApiOperations, operationKey } from "./core-api-call-sites.mjs";

test("extracts literal, template, helper, fetch, and annotated operations", () => {
  const source = `
    function htmlUrl(dealId, slug) {
      return \`/api/deals/\${encodeURIComponent(dealId)}/documents/\${encodeURIComponent(slug)}/html\`;
    }
    request("GET", "/api/me");
    requestSse("POST", \`/api/deals/\${dealId}/threads/\${threadId}\`, {});
    fetch(\`\${baseUrl}/api/oauth/token\`, { method: "POST" });
    callApi("GET", \`\${htmlUrl(dealId, slug)}/history\`);
    // @core-api-operation DELETE /api/deals/{dealId}/links/{linkId}
    request(method, dynamicPath);
  `;
  const result = extractApiOperations(source, "fixture.mjs");
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(
    [...new Set(result.operations.map(({ method, path }) => operationKey(method, path)))].sort(),
    [
      "DELETE /api/deals/{}/links/{}",
      "GET /api/deals/{}/documents/{}/html/history",
      "GET /api/me",
      "POST /api/deals/{}/threads/{}",
      "POST /api/oauth/token",
    ],
  );
});

test("reports a dynamic call site that lacks an explicit operation annotation", () => {
  const result = extractApiOperations('request(method, dynamicPath);', "fixture.mjs");
  assert.equal(result.operations.length, 0);
  assert.equal(result.unresolved.length, 1);
});

test("rejects orphan operation annotations", () => {
  const result = extractApiOperations(
    '// @core-api-operation GET /api/stale\nconst value = "not an endpoint";\n',
    "fixture.mjs",
  );
  assert.equal(result.operations.length, 0);
  assert.equal(result.unresolved.length, 1);
  assert.match(result.unresolved[0].reason, /orphan/);
});

test("an annotation cannot hide a different resolved call", () => {
  const result = extractApiOperations(
    '// @core-api-operation DELETE /api/stale\nrequest("GET", "/api/actual");\n',
    "fixture.mjs",
  );
  assert.deepEqual(result.operations.map(({ method, path }) => operationKey(method, path)), [
    "GET /api/actual",
  ]);
  assert.equal(result.unresolved.length, 1);
  assert.match(result.unresolved[0].reason, /orphan/);
});

test("an adjacent ignore directive handles an explicitly external dynamic fetch", () => {
  const result = extractApiOperations(
    "// @core-api-ignore external registry\nfetch(REGISTRY_URL);\n",
    "fixture.mjs",
  );
  assert.deepEqual(result, { operations: [], unresolved: [] });
});

test("ignores request-like text inside comments", () => {
  const result = extractApiOperations('// request("DELETE", "/api/should-not-exist")\n', "fixture.mjs");
  assert.deepEqual(result, { operations: [], unresolved: [] });
});
