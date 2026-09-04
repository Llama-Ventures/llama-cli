import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const DEAL_ACTIONS = Object.freeze(["search", "read", "create", "write"]);
export const DEAL_WRITE_OPERATIONS = Object.freeze([
  "input.submit",
  "information.put",
  "page.patch",
  "artifact.put",
]);

/**
 * A Llama user's own subjective judgment about the team (.people) or the deal
 * (.business). An agent may record it, but the record must name the user and
 * quote them verbatim from their own input, so the type alone stays a reliable
 * filter. Core enforces the same rule; this check only fails faster.
 */
export const HUMAN_SUBJECTIVE_VIEW_TYPES = Object.freeze([
  "human_subjective_view.people",
  "human_subjective_view.business",
]);

const RETIRED_HUMAN_VIEW_TYPES = Object.freeze([
  "human_view",
  "human_statement",
  "human_opinion",
  "human_judgment",
  "partner_view",
]);

function normalizeWhitespace(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function stringField(object, key) {
  const value = object && typeof object === "object" && !Array.isArray(object) ? object[key] : undefined;
  return typeof value === "string" ? value.trim() : "";
}

export function validateHumanSubjectiveView(information, origin) {
  const type = stringField(information, "type");
  const lower = type.toLowerCase();
  if (RETIRED_HUMAN_VIEW_TYPES.includes(lower) || lower.startsWith("human_view.")) {
    throw new Error(
      `Information type "${type}" is retired: a Llama user's own judgment is human_subjective_view.people or human_subjective_view.business`,
    );
  }
  if (lower !== "human_subjective_view" && !lower.startsWith("human_subjective_view.")) {
    return information;
  }
  if (!HUMAN_SUBJECTIVE_VIEW_TYPES.includes(type)) {
    throw new Error(
      "human_subjective_view must be exactly human_subjective_view.people (team) or human_subjective_view.business (deal)",
    );
  }
  const utterance = origin?.kind === "user" ? stringField(origin, "originalUserUtterance") : "";
  if (!utterance) {
    throw new Error(
      "human_subjective_view.* must originate from a user and carry the user's words in origin.originalUserUtterance",
    );
  }
  const speaker = stringField(information.value, "speaker");
  const rawText = stringField(information.value, "rawText");
  if (!speaker) {
    throw new Error("human_subjective_view.* requires value.speaker: the Llama user whose judgment this is");
  }
  if (!rawText) {
    throw new Error("human_subjective_view.* requires value.rawText: the user's verbatim words");
  }
  if (!normalizeWhitespace(utterance).includes(normalizeWhitespace(rawText))) {
    throw new Error(
      "human_subjective_view.* value.rawText must appear verbatim inside origin.originalUserUtterance; do not paraphrase",
    );
  }
  return information;
}

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
    const information = Array.isArray(command.information) ? command.information : [];
    for (const item of information) validateHumanSubjectiveView(item, command.origin);
  }
  if (action === "write" && command.operation === "page.patch") {
    validateLocalizedTextPairs(command.patch ?? {});
  }
  if (action === "write" && command.operation === "information.put") {
    validateHumanSubjectiveView(command, command.origin);
  }
  return ensureIdempotencyKey(validateCommandOrigin(command));
}
