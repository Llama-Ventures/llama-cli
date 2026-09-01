import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const DEAL_ACTIONS = Object.freeze(["search", "read", "create", "write"]);
export const DEAL_WRITE_OPERATIONS = Object.freeze([
  "input.submit",
  "information.put",
  "page.patch",
  "artifact.put",
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function ensureIdempotencyKey(command) {
  if (typeof command?.idempotencyKey === "string" && command.idempotencyKey.trim()) {
    return command;
  }
  const digest = createHash("sha256").update(canonicalJson(command)).digest("hex").slice(0, 40);
  return { ...command, idempotencyKey: `cli:${digest}` };
}

export function validateCommandOrigin(command) {
  const origin = command?.origin;
  if (!origin || !["user", "agent", "system"].includes(origin.kind)) {
    throw new Error("Mutation JSON must include origin.kind: user, agent, or system");
  }
  if (
    origin.kind === "user" &&
    !(typeof origin.originalUserUtterance === "string" && origin.originalUserUtterance.trim()) &&
    !(typeof origin.originatingChatRecordId === "string" && origin.originatingChatRecordId.trim())
  ) {
    throw new Error(
      "User-originated mutation JSON must preserve origin.originalUserUtterance or origin.originatingChatRecordId",
    );
  }
  return command;
}

function validateLocalizedTextPairs(value, path = "page") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateLocalizedTextPairs(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  const hasEnglish = Object.prototype.hasOwnProperty.call(value, "en");
  const hasChinese = Object.prototype.hasOwnProperty.call(value, "zh");
  if (hasEnglish || hasChinese) {
    if (
      Object.keys(value).some((key) => key !== "en" && key !== "zh") ||
      typeof value.en !== "string" ||
      !value.en.trim() ||
      typeof value.zh !== "string" ||
      !value.zh.trim()
    ) {
      throw new Error(
        `${path} localized text must contain only non-empty en and zh values`,
      );
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    validateLocalizedTextPairs(child, `${path}.${key}`);
  }
}

export async function readJsonInput(path, stdin = process.stdin) {
  if (!path || path === true) throw new Error("--json <file|-> is required");
  const text = path === "-"
    ? await new Promise((resolve, reject) => {
        let value = "";
        stdin.setEncoding("utf8");
        stdin.on("data", (chunk) => { value += chunk; });
        stdin.on("end", () => resolve(value));
        stdin.on("error", reject);
      })
    : await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function buildDealSearchPath(query, flags = {}) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (flags.state && flags.state !== true) params.set("state", String(flags.state));
  if (flags.limit && flags.limit !== true) params.set("limit", String(flags.limit));
  return `/api/occam/deals${params.size ? `?${params}` : ""}`;
}

export function buildDealReadPath(dealId, detail = "overview") {
  if (!dealId || dealId.startsWith("--")) {
    throw new Error("Usage: llama deal read <dealId> [--detail overview|memory|files|conversation|history|all]");
  }
  const expansion = {
    overview: "",
    memory: "information",
    files: "artifacts",
    conversation: "chat",
    history: "feed",
    all: "information,artifacts,chat,feed",
  }[detail];
  if (expansion === undefined) throw new Error(`Unknown detail: ${detail}`);
  return `/api/occam/deals/${encodeURIComponent(dealId)}${expansion ? `?expand=${expansion}` : ""}`;
}

/**
 * page.patch previously echoed the entire Live Deal Page after every write.
 * Keep the authoritative revision receipt and tell the Agent exactly what to
 * read back, without paying another full-page context cost before verification.
 */
export function compactDealWriteResult(command, response) {
  if (command?.operation !== "page.patch" || !response?.result?.page) return response;
  const page = response.result.page;
  return {
    ...response,
    result: {
      idempotent: Boolean(response.result.idempotent),
      page: {
        id: page.id,
        revision: page.revision,
        updatedAt: page.updatedAt,
      },
      verify: {
        dealId: command.dealId,
        fields: Object.keys(command.patch ?? {}),
        command: `llama deal read ${command.dealId}`,
      },
    },
  };
}

export function prepareDealCommand(action, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Mutation JSON must be an object");
  }
  const command = action === "create" ? { operation: "deal.create", ...input } : input;
  if (action === "create" && command.operation !== "deal.create") {
    throw new Error("create JSON must describe one deal.create intent");
  }
  if (action === "write" && !DEAL_WRITE_OPERATIONS.includes(command.operation)) {
    throw new Error(`write JSON operation must be ${DEAL_WRITE_OPERATIONS.join(", ")}`);
  }
  if (action === "create") {
    validateLocalizedTextPairs(command.page ?? {});
  }
  if (action === "write" && command.operation === "page.patch") {
    validateLocalizedTextPairs(command.patch ?? {});
  }
  return ensureIdempotencyKey(validateCommandOrigin(command));
}
