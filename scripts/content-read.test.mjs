import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildArtifactReadPath, buildWikiReadPath, saveContentSource } from "../lib/content-read.mjs";

test("read builders retain existing wiki behavior and validate bounded continuations", () => {
  assert.equal(buildWikiReadPath("example"), "/api/wiki/example?lang=en");
  assert.equal(buildWikiReadPath("example", { attachment: "ref" }), "/api/wiki/example?format=text&lang=en&attachment=ref");
  assert.equal(buildArtifactReadPath("deal", "file", { version: 2 }), "/api/occam/deals/deal/artifacts/file?format=text&version=2");
  for (const options of [{ limit: 50001 }, { offset: -1 }, { offset: 1 }, { sha256: "bad" }, { output: true }]) assert.throws(() => buildArtifactReadPath("deal", "file", options));
});

test("source download verifies bytes and never overwrites a file", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "llama-content-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = path.join(dir, "source.pdf");
  const bytes = Buffer.from([0, 255, 10, 42]);
  const source = { sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length };
  const result = { format: "source", source, contentBase64: bytes.toString("base64") };
  assert.equal((await saveContentSource(result, output)).verified, true);
  assert.deepEqual(await readFile(output), bytes);
  await assert.rejects(saveContentSource(result, output), /EEXIST/);
  await assert.rejects(saveContentSource({ ...result, contentBase64: "AAAA" }, output), /hash or size/);
});

test("real CLI reads artifact and wiki source through authenticated Core endpoints", async t => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, command: req.headers["x-llama-command"], auth: req.headers["x-llama-token"] || req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ text: "Original source", source: { sha256: "a".repeat(64) }, url: req.url }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/llama.mjs", ...args], { env: { ...process.env, LLAMA_API_URL: baseUrl, LLAMA_TOKEN: "llc_local_read_test", LLAMA_NO_TELEMETRY: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
  });
  const artifact = await run(["deal", "read", "example", "--artifact", "file", "--version", "2"]);
  assert.equal(artifact.code, 0, artifact.stderr);
  assert.equal(JSON.parse(artifact.stdout).url, "/api/occam/deals/example/artifacts/file?format=text&version=2");
  const wiki = await run(["wiki", "read", "example", "--format", "text", "--lang", "zh"]);
  assert.equal(wiki.code, 0, wiki.stderr);
  assert.equal(JSON.parse(wiki.stdout).url, "/api/wiki/example?format=text&lang=zh");
  assert.ok(seen.filter(x => x.url.includes("/artifacts/") || x.url.includes("/wiki/")).every(x => x.auth));
  const invalid = await run(["deal", "read", "example", "--offset", "10"]);
  assert.notEqual(invalid.code, 0);
});
