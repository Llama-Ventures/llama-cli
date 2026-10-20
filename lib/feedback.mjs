import os from "node:os";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { getBuildInfo } from "./build-info.mjs";
import { getFeedbackRuntime, request } from "./client.mjs";

const TOP = ["submission_id", "title", "body", "experienced_by", "occurred_at", "details", "environment"];
const DETAILS = { expected: 2000, steps: 4000, impact: 2000, workaround: 2000, suggestion: 2000 };
const ENV = { surface: 12, cli_version: 80, cli_source_sha: 80, agent_name: 120, agent_version: 120,
  agent_name_source: 12, agent_version_source: 12, model: 120, model_source: 12,
  os: 80, os_version: 120, arch: 40, node_version: 80, command: 160, error_code: 120, request_id: 128 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function redactFeedbackText(text) {
  return text.replace(/\b(?:llc_|sk-|ghp_|github_pat_|ya29\.)[A-Za-z0-9_.-]+/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\b(Bearer)\s+[^\s,;\x22\x27]+/gi, "$1 [redacted]")
    .replace(/\b((?:access[_-]?token|refresh[_-]?token|api[_-]?key|token|secret|password|authorization|cookie)[\x22\x27]?\s*[:=]\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@");
}
function object(value, allowed, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${name} field: ${key}`);
  return value;
}
function text(value, max, name) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(`${name} requires 1–${max} characters`);
  return redactFeedbackText(value.trim());
}
function strings(value, fields, name) {
  const result = {};
  for (const [key, val] of Object.entries(object(value, Object.keys(fields), name))) result[key] = text(val, fields[key], `${name}.${key}`);
  return result;
}
export function feedbackId(id) {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("Feedback ID must be a UUID");
  return id;
}
export async function readFeedbackInput(file, stdin = process.stdin) {
  const stream = file === "-" ? stdin : createReadStream(file);
  let size = 0; const chunks = [];
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 32768) { stream.destroy(); throw new Error("Feedback exceeds 32 KiB"); }
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Feedback file must contain valid JSON"); }
}
export function prepareFeedback(input, host) {
  object(input, TOP, "feedback");
  const runtime = getFeedbackRuntime(); const build = getBuildInfo();
  const supplied = strings(input.environment ?? {}, ENV, "environment");
  const environment = {
    surface: runtime.client, cli_version: build.packageVersion, cli_source_sha: build.sourceSha,
    os: os.platform(), os_version: os.release(), arch: os.arch(), node_version: process.version,
    agent_name: runtime.agent, agent_name_source: runtime.agentSource,
    ...(host?.name ? { agent_name: host.name, agent_name_source: "host" } : {}),
    ...(host?.version ? { agent_version: host.version, agent_version_source: "host" } : {}),
    ...(process.env.LLAMA_AGENT_VERSION ? { agent_version: process.env.LLAMA_AGENT_VERSION, agent_version_source: "reported" } : {}),
    ...(process.env.LLAMA_AGENT_MODEL ? { model: process.env.LLAMA_AGENT_MODEL, model_source: "reported" } : {}),
    ...supplied,
  };
  if (supplied.agent_name && host?.name && supplied.agent_name !== host.name && !supplied.agent_version && !process.env.LLAMA_AGENT_VERSION) {
    delete environment.agent_version;
    delete environment.agent_version_source;
  }
  // Explicit overrides are declarations, not observations of the running host.
  for (const key of ["agent_name", "agent_version", "model"]) {
    if (supplied[key] && !supplied[`${key}_source`]) environment[`${key}_source`] = "reported";
  }
  for (const key of ["agent_name_source", "agent_version_source", "model_source"]) {
    if (environment[key] && !["detected", "host", "reported", "unknown"].includes(environment[key])) throw new Error(`Invalid ${key}`);
  }
  if (!["cli", "mcp", "web", "api"].includes(environment.surface)) throw new Error("Invalid environment.surface");
  const experiencedBy = input.experienced_by ?? "both";
  if (!["user", "agent", "both"].includes(experiencedBy)) throw new Error("experienced_by must be user, agent or both");
  if (input.occurred_at && (typeof input.occurred_at !== "string" || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(input.occurred_at) || !Number.isFinite(Date.parse(input.occurred_at)))) throw new Error("occurred_at must be an ISO timestamp with timezone");
  const result = {
    submission_id: input.submission_id ? feedbackId(input.submission_id) : randomUUID(),
    title: text(input.title, 200, "title"), body: text(input.body, 8000, "body"), experienced_by: experiencedBy,
    ...(input.occurred_at ? { occurred_at: input.occurred_at } : {}),
    details: strings(input.details ?? {}, DETAILS, "details"), environment: strings(environment, ENV, "environment"),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 32768) throw new Error("Feedback exceeds 32 KiB");
  return result;
}
export async function submitFeedback(input, host) {
  const body = prepareFeedback(input, host);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
  try {
    return await request("POST", "/api/feedback", body, { signal: controller.signal, redirect: "error" });
  } catch (error) {
    const wrapped = new Error(`Error[FEEDBACK_NOT_CONFIRMED]: Feedback submission is not confirmed. ${redactFeedbackText(error.message)}\nRetry the same report with submission_id=${body.submission_id}. Do not recursively report this failure.`);
    wrapped.code = "FEEDBACK_NOT_CONFIRMED";
    throw wrapped;
  } finally { clearTimeout(timer); }
}
export async function readFeedback(id) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
  try {
    // @core-api-operation GET /api/feedback/{id}
    return await request("GET", `/api/feedback/${feedbackId(id)}`, undefined, { signal: controller.signal, redirect: "error" });
  } finally { clearTimeout(timer); }
}

/** Resolve with the caller's real reviewer identity; Core owns attribution. */
export async function resolveFeedback(id, note) {
  const feedback = feedbackId(id);
  const body = { resolution_note: text(note, 2000, "resolution_note") };
  if (body.resolution_note.length > 2000) throw new Error("Redacted resolution_note exceeds 2000 characters");
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
  try {
    // @core-api-operation PATCH /api/admin/feedback/{id}
    const result = await request("PATCH", `/api/admin/feedback/${feedback}`, body, { signal: controller.signal, redirect: "error" });
    if (result?.feedback?.id !== feedback || result.feedback.status !== "closed") {
      throw new Error("Core did not return a resolved feedback receipt");
    }
    return result;
  } catch (error) {
    if (error.status >= 400 && error.status < 500) throw error;
    const wrapped = new Error(`Error[FEEDBACK_RESOLUTION_NOT_CONFIRMED]: Resolution is not confirmed. ${redactFeedbackText(error.message)}\nRetry feedback ${feedback} with the same note. Do not recursively report this failure.`);
    wrapped.code = "FEEDBACK_RESOLUTION_NOT_CONFIRMED";
    throw wrapped;
  } finally { clearTimeout(timer); }
}

/** Read-only operational inbox; Core validates real reviewer identity and scope. */
export async function listAdminFeedback({ status = "open", cliVersion, agentName, offset = "0" } = {}) {
  if (!["open", "closed", "all"].includes(status)) throw new Error("Feedback status must be open, closed or all");
  if (!/^[0-9]+$/.test(String(offset)) || Number(offset) > 100000) throw new Error("Feedback offset must be an integer from 0 to 100000");
  const params = new URLSearchParams({ status, offset: String(Number(offset)) });
  for (const [key, value, max] of [["cli_version", cliVersion, 80], ["agent_name", agentName, 120]]) {
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(`Invalid feedback ${key} filter`);
    params.set(key, value.trim());
  }
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
  try {
    // @core-api-operation GET /api/admin/feedback
    return await request("GET", `/api/admin/feedback?${params}`, undefined, { signal: controller.signal, redirect: "error" });
  } finally { clearTimeout(timer); }
}
