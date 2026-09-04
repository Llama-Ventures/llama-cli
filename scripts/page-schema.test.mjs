import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_DEAL_PAGE_SCHEMA_PATH,
  MAX_PAGE_SCHEMA_FIELDS,
  buildPageSchemaPath,
} from "../lib/page-schema.mjs";

test("buildPageSchemaPath starts at the compact index", () => {
  assert.equal(buildPageSchemaPath(), LIVE_DEAL_PAGE_SCHEMA_PATH);
});

test("buildPageSchemaPath selects only exact unique fields", () => {
  assert.equal(
    buildPageSchemaPath({ fields: ["description", "foundersJson.founders", "description"] }),
    `${LIVE_DEAL_PAGE_SCHEMA_PATH}?field=description&field=foundersJson.founders`,
  );
});

test("buildPageSchemaPath selects one section", () => {
  assert.equal(
    buildPageSchemaPath({ section: "people" }),
    `${LIVE_DEAL_PAGE_SCHEMA_PATH}?section=people`,
  );
});

test("buildPageSchemaPath rejects broad or ambiguous disclosure", () => {
  assert.throws(
    () => buildPageSchemaPath({ fields: ["description"], section: "people" }),
    /exact fields or one section/,
  );
  assert.throws(
    () => buildPageSchemaPath({ fields: Array.from({ length: MAX_PAGE_SCHEMA_FIELDS + 1 }, (_, i) => `field-${i}`) }),
    /at most 20 exact fields/,
  );
  assert.throws(() => buildPageSchemaPath({ section: " " }), /cannot be empty/);
});
