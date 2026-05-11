// OAuth refresh-token rotation for the Llama CLI.
//
// Called from lib/client.mjs::request when an OAuth-bearing call returns
// 401. We exchange the stored refresh_token for a new (access, refresh)
// pair via POST /api/oauth/token, persist the new bundle, and surface
// the new access_token so the caller can retry once.
//
// Cross-process locking via oauth-storage.withRefreshLock so two shells
// hitting 401 simultaneously don't burn each other's refresh token.
// After acquiring the lock we re-read the bundle in case the other
// shell has already refreshed.

import { LLAMA_CLI_CLIENT_ID } from "./oauth-flow.mjs";
import { readBundle, withRefreshLock, writeBundle } from "./oauth-storage.mjs";

const ACCESS_TOKEN_SKEW_MS = 30_000; // refresh proactively 30s before expiry

/**
 * Returns the current access token if non-expired, else attempts
 * refresh. Returns null if no bundle is stored, refresh fails, or the
 * refresh token itself is expired/revoked (caller should fall through
 * to the next auth method or surface NO_AUTH).
 */
export async function getValidAccessToken() {
  const bundle = await readBundle();
  if (!bundle?.access_token) return null;
  if (bundle.expires_at - Date.now() > ACCESS_TOKEN_SKEW_MS) {
    return bundle.access_token;
  }
  // Near or past expiry — refresh under lock.
  return refreshUnderLock();
}

/**
 * Force a refresh regardless of expiry. Used by client.mjs on a 401
 * with an OAuth bundle present (the access token may have been revoked
 * server-side, in which case the refresh might still work).
 */
export async function forceRefresh() {
  return refreshUnderLock();
}

async function refreshUnderLock() {
  return withRefreshLock(async () => {
    // Re-read inside the lock — another shell may have refreshed already.
    const fresh = await readBundle();
    if (!fresh?.refresh_token) return null;
    if (fresh.expires_at - Date.now() > ACCESS_TOKEN_SKEW_MS) {
      // Another shell already refreshed; we're good.
      return fresh.access_token;
    }
    return performRefresh(fresh);
  });
}

async function performRefresh(bundle) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: bundle.refresh_token,
    client_id: bundle.client_id ?? LLAMA_CLI_CLIENT_ID,
    resource: bundle.resource,
  }).toString();

  const res = await fetch(`${bundle.issuer}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    // Refresh failed — most likely refresh expired or grant was revoked.
    // Don't delete the bundle automatically; the user might want to
    // inspect it or `llama auth logout` themselves to clear it.
    return null;
  }
  const json = await res.json().catch(() => null);
  if (!json?.access_token || !json?.refresh_token) return null;

  const newBundle = {
    ...bundle,
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
    scope: json.scope ?? bundle.scope,
  };
  await writeBundle(newBundle);
  return newBundle.access_token;
}
