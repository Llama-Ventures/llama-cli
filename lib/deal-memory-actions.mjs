import { readFile } from "node:fs/promises";

export const MAX_DEAL_STORY_BYTES = 1_048_576;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildDealMemoryPath(dealId) {
  if (!UUID.test(String(dealId || ""))) {
    throw new Error("Deal Memory requires a valid deal UUID");
  }
  return `/api/deal-memory/${encodeURIComponent(dealId)}/story`;
}

export async function readMarkdownInput(path, stdin = process.stdin) {
  if (!path || path === true) throw new Error("--markdown <file|-> is required");
  const markdown = path === "-"
    ? await new Promise((resolve, reject) => {
        let value = "";
        stdin.setEncoding("utf8");
        stdin.on("data", (chunk) => { value += chunk; });
        stdin.on("end", () => resolve(value));
        stdin.on("error", reject);
      })
    : await readFile(path, "utf8");
  if (!markdown) throw new Error("Deal Story Markdown cannot be empty");
  const bytes = Buffer.byteLength(markdown, "utf8");
  if (bytes > MAX_DEAL_STORY_BYTES) {
    throw new Error(`Deal Story is ${bytes} bytes; maximum is ${MAX_DEAL_STORY_BYTES}`);
  }
  return markdown;
}
