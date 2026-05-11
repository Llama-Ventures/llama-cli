// OAuth 2.1 PKCE + loopback flow for the Llama CLI.
//
// Mirrors `gh auth login` / `gcloud auth login`: the CLI binds an
// ephemeral HTTP server on 127.0.0.1, opens the browser to the
// authorization endpoint with a PKCE challenge + state, and waits for
// the user to approve. The browser redirects to the loopback URL
// carrying the auth code; the local server captures it and shuts down.
// The CLI then exchanges the code (with the PKCE verifier) for tokens.
//
// Pure stdlib: node:crypto for PKCE, node:http for the loopback server,
// child_process for the platform-specific browser open. No third-party
// HTTP/OAuth client.
//
// RFC compliance: OAuth 2.1 + RFC 7636 PKCE S256 + RFC 8252 native-app
// loopback flow + RFC 8707 audience parameter.

import { createHash, randomBytes } from "crypto";
import http from "http";
import { spawn } from "child_process";

const CLIENT_ID = "llama-cli-official";
const REDIRECT_PATH = "/callback";
const FLOW_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — generous for slow Google sign-in

// ============================================================
// PKCE primitives
// ============================================================

function base64url(buf) {
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function generateVerifier() {
  // RFC 7636 §4.1: 43-128 chars from unreserved alphabet. 32 random bytes
  // → 43 base64url chars (256 bits entropy).
  return base64url(randomBytes(32));
}

export function challengeFor(verifier) {
  return base64url(createHash("sha256").update(verifier).digest());
}

// ============================================================
// Browser launcher
// ============================================================

function openBrowser(url) {
  // Platform-native open. We never block on it (the user closes the
  // browser when they're done; the loopback server is what we wait for).
  let cmd, args;
  if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (process.platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Best-effort — if we can't open the browser, the user can copy the
    // URL from stderr. The loopback server keeps listening either way.
  }
}

// ============================================================
// Loopback server response page
// ============================================================

function respondHtml(res, ok, message) {
  const color = ok ? "#16a34a" : "#dc2626";
  const title = ok ? "Llama CLI — Signed in" : "Llama CLI — Sign-in failed";
  res.statusCode = ok ? 200 : 400;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: #fafaf9; color: #292524; display: grid; place-items: center;
         min-height: 100vh; margin: 0; }
  .card { background: white; border: 1px solid #e7e5e4; border-radius: 8px;
          padding: 32px 40px; max-width: 400px; text-align: center; }
  h1 { margin: 0 0 12px; font-size: 18px; color: ${color}; }
  p  { margin: 0; color: #57534e; font-size: 14px; }
</style></head><body>
<div class="card"><h1>${title}</h1><p>${message}</p></div>
</body></html>`);
}

// ============================================================
// PKCE + loopback driver
// ============================================================

/**
 * Run the full PKCE + loopback OAuth flow.
 *
 * @param {Object} opts
 * @param {string} opts.baseUrl   AS issuer (e.g. https://command.llamaventures.vc)
 * @param {string} opts.scope     Space-separated scope request (e.g. "read write")
 * @param {string} opts.resource  RFC 8707 audience the access token will bind to
 * @returns {Promise<Object>}     {access_token, refresh_token, expires_in, scope, token_type, redirect_uri}
 */
export async function pkceLoopbackFlow({ baseUrl, scope, resource }) {
  const verifier = generateVerifier();
  const challenge = challengeFor(verifier);
  const state = base64url(randomBytes(16));

  // Bind the loopback server FIRST so we know the port for redirect_uri.
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  const redirectUri = `http://127.0.0.1:${port}${REDIRECT_PATH}`;

  // Set up the request handler now that we have the port.
  const codePromise = new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      try { server.close(); } catch { /* */ }
      reject(new Error(
        "Error[OAUTH_TIMEOUT]: Browser flow did not complete within " +
        Math.round(FLOW_TIMEOUT_MS / 1000) + "s. Re-run `llama auth login`."
      ));
    }, FLOW_TIMEOUT_MS);

    server.on("request", (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== REDIRECT_PATH) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const code = url.searchParams.get("code");
      const respState = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description") ?? "";

      if (error) {
        respondHtml(res, false, `${error}: ${errorDescription}`);
        clearTimeout(timeoutId);
        server.close();
        reject(new Error(`Error[OAUTH_DENIED]: ${error} — ${errorDescription}`));
        return;
      }
      if (respState !== state) {
        respondHtml(res, false, "state parameter mismatch (CSRF defense)");
        clearTimeout(timeoutId);
        server.close();
        reject(new Error("Error[OAUTH_BAD_STATE]: state mismatch — possible CSRF or stale callback"));
        return;
      }
      if (!code) {
        respondHtml(res, false, "missing code parameter");
        clearTimeout(timeoutId);
        server.close();
        reject(new Error("Error[OAUTH_BAD_CALLBACK]: callback missing code parameter"));
        return;
      }

      respondHtml(res, true, "You can close this window and return to the terminal.");
      clearTimeout(timeoutId);
      server.close();
      resolve(code);
    });
  });

  // Build authorize URL and open browser.
  const authorizeUrl = new URL(`${baseUrl}/api/oauth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", scope);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("resource", resource);

  console.error(`Opening browser to ${baseUrl} for sign-in...`);
  console.error(`(If the browser does not open, visit this URL manually:\n  ${authorizeUrl.toString()}\n)`);
  openBrowser(authorizeUrl.toString());

  const code = await codePromise;

  // Exchange code → tokens.
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: verifier,
    resource,
  }).toString();

  const tokenRes = await fetch(`${baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody,
  });
  const tokenJson = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok) {
    throw new Error(
      `Error[OAUTH_TOKEN_EXCHANGE_FAILED]: ${tokenJson.error ?? tokenRes.status} — ${tokenJson.error_description ?? "no description"}`
    );
  }

  return {
    access_token: tokenJson.access_token,
    refresh_token: tokenJson.refresh_token,
    expires_in: tokenJson.expires_in ?? 3600,
    scope: tokenJson.scope ?? scope,
    token_type: tokenJson.token_type ?? "Bearer",
    client_id: CLIENT_ID,
    resource,
    issuer: baseUrl,
  };
}

// ============================================================
// Token revoke (used by `llama auth logout`)
// ============================================================

export async function revokeToken({ baseUrl, token, tokenTypeHint }) {
  const body = new URLSearchParams({
    token,
    client_id: CLIENT_ID,
    ...(tokenTypeHint ? { token_type_hint: tokenTypeHint } : {}),
  }).toString();
  const res = await fetch(`${baseUrl}/api/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  // RFC 7009 §2.2: 200 on success OR unknown token. Anything else is unexpected.
  return res.ok;
}

export const LLAMA_CLI_CLIENT_ID = CLIENT_ID;
