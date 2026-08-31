import assert from "node:assert/strict";
import test from "node:test";

import { extractApiOperations, operationKey } from "./core-api-call-sites.mjs";

test("extracts literal, template, helper, fetch, and annotated operations", () => {
  const source = `
    function artifactUrl(dealId, artifactId) {
      return \`/api/occam/deals/\${encodeURIComponent(dealId)}/artifacts/\${encodeURIComponent(artifactId)}\`;
    }
    request("GET", "/api/me");
    requestSse("POST", \`/api/occam/deals/\${dealId}/chat\`, {});
    fetch(\`\${baseUrl}/api/oauth/token\`, { method: "POST" });
    callApi("GET", artifactUrl(dealId, artifactId));
    // @core-api-operation POST /api/occam/deals/commands
    request(method, dynamicPath);
  `;
  const result = extractApiOperations(source, "fixture.mjs");
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(
    [...new Set(result.operations.map(({ method, path }) => operationKey(method, path)))].sort(),
    [
      "GET /api/me",
      "GET /api/occam/deals/{}/artifacts/{}",
      "POST /api/oauth/token",
      "POST /api/occam/deals/commands",
      "POST /api/occam/deals/{}/chat",
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
