import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  MAX_DEAL_STORY_BYTES,
  buildDealMemoryPath,
  readMarkdownInput,
} from "../lib/deal-memory-actions.mjs";

const DEAL_ID = "11111111-1111-4111-8111-111111111111";

test("buildDealMemoryPath exposes only the Core adapter path", () => {
  assert.equal(
    buildDealMemoryPath(DEAL_ID),
    `/api/deal-memory/${DEAL_ID}/story`,
  );
  assert.throws(() => buildDealMemoryPath("not-a-deal"), /valid deal UUID/);
});

test("readMarkdownInput preserves exact stdin Markdown bytes", async () => {
  const markdown = "---\ndeal_id: exact\n---\n\n# 原样保留\n";
  assert.equal(await readMarkdownInput("-", Readable.from([markdown])), markdown);
});

test("readMarkdownInput rejects empty and oversized stories locally", async () => {
  await assert.rejects(readMarkdownInput("-", Readable.from([""])), /cannot be empty/);
  await assert.rejects(
    readMarkdownInput("-", Readable.from(["x".repeat(MAX_DEAL_STORY_BYTES + 1)])),
    /maximum is 1048576/,
  );
});
