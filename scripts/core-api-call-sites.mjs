import fs from "node:fs";
import path from "node:path";

export const RUNTIME_SOURCE_DIRECTORIES = ["bin", "lib"];

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function skipTrivia(source, start) {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index + 2);
      return end === -1 ? source.length : skipTrivia(source, end + 1);
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      return end === -1 ? source.length : skipTrivia(source, end + 2);
    }
    break;
  }
  return index;
}

function readQuoted(source, start) {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) {
      return { raw: source.slice(start, index + 1), end: index + 1 };
    }
    index += 1;
  }
  throw new Error("Unterminated JavaScript string while scanning Core API calls");
}

function readTemplate(source, start) {
  let index = start + 1;
  let interpolationDepth = 0;
  let inInterpolation = false;

  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (!inInterpolation && char === "`") {
      return { raw: source.slice(start, index + 1), end: index + 1 };
    }
    if (!inInterpolation && char === "$" && source[index + 1] === "{") {
      inInterpolation = true;
      interpolationDepth = 1;
      index += 2;
      continue;
    }
    if (inInterpolation && (char === '"' || char === "'")) {
      index = readQuoted(source, index).end;
      continue;
    }
    if (inInterpolation && char === "`") {
      index = readTemplate(source, index).end;
      continue;
    }
    if (inInterpolation && char === "{") interpolationDepth += 1;
    if (inInterpolation && char === "}") {
      interpolationDepth -= 1;
      if (interpolationDepth === 0) inInterpolation = false;
    }
    index += 1;
  }
  throw new Error("Unterminated JavaScript template while scanning Core API calls");
}

function readExpression(source, start) {
  let index = skipTrivia(source, start);
  if (source[index] === '"' || source[index] === "'") return readQuoted(source, index);
  if (source[index] === "`") return readTemplate(source, index);

  const expressionStart = index;
  let depth = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'") {
      index = readQuoted(source, index).end;
      continue;
    }
    if (char === "`") {
      index = readTemplate(source, index).end;
      continue;
    }
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index + 2);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) {
      if (depth === 0 && char === ")") break;
      depth -= 1;
    } else if (char === "," && depth === 0) {
      break;
    }
    index += 1;
  }
  return { raw: source.slice(expressionStart, index).trim(), end: index };
}

function literalValue(raw) {
  if (!raw || !['"', "'"].includes(raw[0])) return null;
  try {
    return Function(`"use strict"; return (${raw});`)();
  } catch {
    return null;
  }
}

function templateShape(raw) {
  const literal = literalValue(raw);
  if (literal != null) return String(literal);
  if (!raw?.startsWith("`")) return null;

  const source = raw.slice(1, -1);
  let result = "";
  let index = 0;
  while (index < source.length) {
    if (source[index] === "\\") {
      result += source[index + 1] || "";
      index += 2;
      continue;
    }
    if (source[index] === "$" && source[index + 1] === "{") {
      let cursor = index + 2;
      let depth = 1;
      while (cursor < source.length && depth > 0) {
        if (source[cursor] === '"' || source[cursor] === "'") {
          cursor = readQuoted(source, cursor).end;
          continue;
        }
        if (source[cursor] === "`") {
          cursor = readTemplate(source, cursor).end;
          continue;
        }
        if (source[cursor] === "{") depth += 1;
        if (source[cursor] === "}") depth -= 1;
        cursor += 1;
      }
      result += "{}";
      index = cursor;
      continue;
    }
    result += source[index];
    index += 1;
  }
  return result;
}

export function normalizeApiPath(rawPath) {
  if (typeof rawPath !== "string") return null;
  const apiIndex = rawPath.indexOf("/api/");
  if (apiIndex === -1) return null;
  let result = rawPath.slice(apiIndex).split(/[?#]/, 1)[0].replace(/\{[^}]*\}/g, "{}");
  // A template interpolation appended directly to a path is normally a
  // conditional query-string expression (`/api/deals${query ? ... : ...}`).
  // Preserve a trailing path parameter (`/api/wiki/${slug}`).
  result = result.replace(/([^/])\{\}$/, "$1").replace(/\/$/, "");
  return result;
}

export function operationKey(method, apiPath) {
  return `${String(method).toUpperCase()} ${normalizeApiPath(apiPath)}`;
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

function annotations(source, file, directive = "operation") {
  const result = [];
  const pattern =
    directive === "operation"
      ? /@core-api-operation\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/api\/[^\s*]+)/g
      : /@core-api-ignore\s+([^\n*]+)/g;
  let match;
  while ((match = pattern.exec(source))) {
    const endOfLine = source.indexOf("\n", match.index);
    result.push({
      method: directive === "operation" ? match[1] : null,
      path: directive === "operation" ? match[2] : null,
      reason: directive === "ignore" ? match[1].trim() : null,
      file,
      line: lineNumberAt(source, match.index),
      index: match.index,
      end: endOfLine === -1 ? source.length : endOfLine,
      source: directive === "operation" ? "annotation" : "ignore",
    });
  }
  return result;
}

function commentRanges(source) {
  const ranges = [];
  let index = 0;
  while (index < source.length) {
    if (source[index] === '"' || source[index] === "'") {
      index = readQuoted(source, index).end;
      continue;
    }
    if (source[index] === "`") {
      index = readTemplate(source, index).end;
      continue;
    }
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index + 2);
      const rangeEnd = end === -1 ? source.length : end;
      ranges.push([index, rangeEnd]);
      index = rangeEnd;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      const rangeEnd = end === -1 ? source.length : end + 2;
      ranges.push([index, rangeEnd]);
      index = rangeEnd;
      continue;
    }
    index += 1;
  }
  return ranges;
}

function isInsideRanges(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function annotationsForCall(entries, source, line, callIndex) {
  return entries.filter((entry) => {
    if (entry.line > line || entry.line < line - 6 || entry.end > callIndex) return false;
    // The directive must belong to the same statement. This permits wrappers
    // such as `print(await request(...))`, but rejects a stale directive when
    // another statement appears before the dynamic call.
    return !source.slice(entry.end, callIndex).includes(";");
  });
}

function apiPathMatchesShape(apiPath, shape) {
  const normalizedPath = normalizeApiPath(apiPath);
  const normalizedShape = normalizeApiPath(shape);
  if (!normalizedPath || !normalizedShape) return false;
  const pattern = normalizedShape
    .split("{}")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]+");
  return new RegExp(`^${pattern}$`).test(normalizedPath);
}

function pathHelpers(source) {
  const helpers = new Map();
  const pattern = /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{[\s\S]{0,1200}?\breturn\s+(`(?:\\.|[^`])*`|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')/g;
  let match;
  while ((match = pattern.exec(source))) {
    const normalized = normalizeApiPath(templateShape(match[2]));
    if (normalized) helpers.set(match[1], normalized);
  }
  return helpers;
}

function matchingParen(raw, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < raw.length; index += 1) {
    if (raw[index] === '"' || raw[index] === "'") {
      index = readQuoted(raw, index).end - 1;
      continue;
    }
    if (raw[index] === "`") {
      index = readTemplate(raw, index).end - 1;
      continue;
    }
    if (raw[index] === "(") depth += 1;
    if (raw[index] === ")" && --depth === 0) return index;
  }
  return -1;
}

function endpointPath(raw, helpers) {
  const direct = normalizeApiPath(templateShape(raw));
  if (direct) return direct;

  for (const [helper, helperPath] of helpers) {
    const helperIndex = raw.indexOf(`${helper}(`);
    if (helperIndex === -1) continue;
    const close = matchingParen(raw, helperIndex + helper.length);
    if (close === -1) continue;
    let suffix = raw.slice(close + 1).replace(/^}/, "").replace(/[`}\s]+$/, "");
    if (suffix.startsWith("/")) {
      suffix = templateShape(`\`${suffix}\``) || suffix;
    } else {
      suffix = "";
    }
    return normalizeApiPath(`${helperPath}${suffix}`);
  }
  return null;
}

function isKnownTransportIndirection(file, callee, methodRaw, endpointRaw) {
  if (file === "bin/llama-mcp.mjs" && callee !== "fetch") {
    return methodRaw === "method" && endpointRaw === "path";
  }
  if (file === "lib/client.mjs") {
    if (callee !== "fetch") return methodRaw === "method" && endpointRaw === "endpoint";
    return endpointRaw.includes("${endpoint}");
  }
  return false;
}

export function extractApiOperations(source, file = "<source>") {
  const found = [];
  const unresolved = [];
  const fileAnnotations = annotations(source, file, "operation");
  const ignoreAnnotations = annotations(source, file, "ignore");
  const usedDirectives = new Set();
  const helpers = pathHelpers(source);
  const comments = commentRanges(source);

  const callPattern = /\b(requestSse|request|callApi|fetch)\s*\(/g;
  let match;
  while ((match = callPattern.exec(source))) {
    if (isInsideRanges(match.index, comments)) continue;
    const callee = match[1];
    const line = lineNumberAt(source, match.index);
    const first = readExpression(source, match.index + match[0].length);
    let cursor = skipTrivia(source, first.end);
    const hasSecond = source[cursor] === ",";
    const second = hasSecond ? readExpression(source, cursor + 1) : { raw: "", end: cursor };
    let methodRaw;
    let endpointRaw;
    let method;
    if (callee === "fetch") {
      methodRaw = "GET";
      endpointRaw = first.raw;
      method = (second.raw.match(/\bmethod\s*:\s*["']([A-Z]+)["']/) || [])[1] || "GET";
    } else {
      methodRaw = first.raw;
      endpointRaw = second.raw;
      method = literalValue(methodRaw);
    }

    if (isKnownTransportIndirection(file, callee, methodRaw, endpointRaw)) continue;

    const apiPath = endpointPath(endpointRaw, helpers);
    const annotated = annotationsForCall(fileAnnotations, source, line, match.index);
    const ignored = annotationsForCall(ignoreAnnotations, source, line, match.index);
    const annotationExpandsDynamicPath =
      annotated.length > 0 &&
      apiPath?.includes("{}") &&
      annotated.every(
        (entry) =>
          entry.method === method && apiPathMatchesShape(entry.path, apiPath),
      );
    if (annotationExpandsDynamicPath) {
      annotated.forEach((entry) => usedDirectives.add(entry));
      found.push(...annotated);
      continue;
    }
    if (METHODS.has(method) && apiPath) {
      found.push({ method, path: apiPath, file, line, source: callee });
      continue;
    }

    if (annotated.length > 0 && ignored.length > 0) {
      unresolved.push({
        file,
        line,
        callee,
        method: methodRaw,
        endpoint: endpointRaw,
        reason: "call has both @core-api-operation and @core-api-ignore directives",
      });
      continue;
    }
    if (annotated.length > 0) {
      annotated.forEach((entry) => usedDirectives.add(entry));
      found.push(...annotated);
      continue;
    }
    if (ignored.length > 0) {
      ignored.forEach((entry) => usedDirectives.add(entry));
      continue;
    }

    unresolved.push({ file, line, callee, method: methodRaw, endpoint: endpointRaw });
  }

  // A browser navigation can itself be a Core GET without passing through the
  // shared HTTP helpers (OAuth authorize is the current example). Permit that
  // only when the directive's exact path appears in the immediately following
  // statement; otherwise fail it as an orphan rather than false-green forever.
  for (const entry of fileAnnotations) {
    if (usedDirectives.has(entry)) continue;
    const statementStart = skipTrivia(source, entry.end);
    const semicolon = source.indexOf(";", statementStart);
    const statement = source.slice(
      statementStart,
      semicolon === -1 ? Math.min(source.length, statementStart + 500) : semicolon + 1,
    );
    if (statement.includes(entry.path)) {
      usedDirectives.add(entry);
      found.push(entry);
      continue;
    }
    unresolved.push({
      file,
      line: entry.line,
      callee: "annotation",
      method: entry.method,
      endpoint: entry.path,
      reason: "orphan @core-api-operation directive",
    });
  }
  for (const entry of ignoreAnnotations) {
    if (usedDirectives.has(entry)) continue;
    unresolved.push({
      file,
      line: entry.line,
      callee: "annotation",
      method: "IGNORE",
      endpoint: entry.reason,
      reason: "orphan @core-api-ignore directive",
    });
  }

  return { operations: found, unresolved };
}

export function runtimeSourceFiles(root = process.cwd()) {
  const files = [];
  const visit = (relativeDirectory) => {
    const absoluteDirectory = path.join(root, relativeDirectory);
    for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) visit(relativePath);
      else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(relativePath);
    }
  };
  RUNTIME_SOURCE_DIRECTORIES.forEach(visit);
  return files.sort();
}

export function scanRuntimeOperations(root = process.cwd(), files = runtimeSourceFiles(root)) {
  const operations = [];
  const unresolved = [];
  for (const relativePath of files) {
    const source = fs.readFileSync(path.join(root, relativePath), "utf8");
    const extracted = extractApiOperations(source, relativePath);
    operations.push(...extracted.operations);
    unresolved.push(...extracted.unresolved);
  }

  const byKey = new Map();
  for (const operation of operations) {
    const key = operationKey(operation.method, operation.path);
    if (!byKey.has(key)) byKey.set(key, operation);
  }
  return {
    operations: [...byKey.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, operation]) => ({ ...operation, key })),
    unresolved,
  };
}
