import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

function parameters(options) {
  const params = new URLSearchParams();
  const format = options.output ? "source" : options.format || "text";
  if (!["text", "source"].includes(format)) throw new Error("--format must be text or source");
  params.set("format", format);
  for (const [key, min, max] of [["version", 1, Number.MAX_SAFE_INTEGER], ["offset", 0, 2000000], ["limit", 1, 50000]]) {
    if (options[key] === undefined) continue;
    if (!/^\d+$/.test(String(options[key])) || !Number.isSafeInteger(Number(options[key])) || Number(options[key]) < min || Number(options[key]) > max) throw new Error(`Invalid --${key}`);
    params.set(key, String(options[key]));
  }
  if (options.sha256 !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(options.sha256)) throw new Error("Invalid --sha256");
    params.set("sha256", options.sha256);
  }
  if (Number(options.offset) > 0 && !options.sha256) throw new Error("Continuation reads require --sha256 from the first response");
  if (options.output !== undefined && (typeof options.output !== "string" || !options.output)) throw new Error("--output requires a file path");
  return params;
}

export function buildArtifactReadPath(dealId, artifactId, options = {}) {
  if (typeof dealId !== "string" || !dealId || typeof artifactId !== "string" || !artifactId) throw new Error("Usage: llama deal read <dealId> --artifact <artifactId>");
  return `/api/occam/deals/${encodeURIComponent(dealId)}/artifacts/${encodeURIComponent(artifactId)}?${parameters(options)}`;
}

export function buildWikiReadPath(slug, options = {}) {
  if (typeof slug !== "string" || !slug) throw new Error("Usage: llama wiki read <slug>");
  const params = options.format || options.output || options.attachment ? parameters(options) : new URLSearchParams();
  params.set("lang", options.lang === "zh" ? "zh" : "en");
  if (options.attachment !== undefined) {
    if (typeof options.attachment !== "string" || !options.attachment) throw new Error("--attachment requires a reference ID from the wiki read");
    params.set("attachment", options.attachment);
  }
  if (options.version !== undefined) throw new Error("Wiki reads pin --sha256, not --version");
  if (!options.format && !options.output && !options.attachment && [options.offset, options.limit, options.sha256].some(x => x !== undefined)) throw new Error("Use --format text with pagination options");
  return `/api/wiki/${encodeURIComponent(slug)}?${params}`;
}

export async function saveContentSource(result, output) {
  if (!output) return result;
  if (result?.format !== "source" || typeof result.contentBase64 !== "string") throw new Error("Server did not return original file bytes");
  const bytes = Buffer.from(result.contentBase64, "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== result.source?.sha256 || bytes.length !== result.source?.byteSize) throw new Error("Downloaded file hash or size does not match the source");
  await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
  return { saved: output, source: result.source, verified: true };
}
