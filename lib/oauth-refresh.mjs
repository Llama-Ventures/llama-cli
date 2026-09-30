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

const ACCESS_TOKEN_SKEW_MS = 30_000;

// The manager keeps credential I/O separate so renewal can be verified without
// accessing a user's keychain or sending requests to a production issuer.
export function createOAuthTokenManager({ readBundle, writeBundle, withRefreshLock, fetch }) {
  async function getValidAccessToken() {
    const bundle = await readBundle();
    if (!bundle?.access_token) return null;
    if (bundle.expires_at - Date.now() > ACCESS_TOKEN_SKEW_MS) return bundle.access_token;
    return refreshUnderLock();
  }

  async function forceRefresh(rejectedAccessToken) {
    const rejected = rejectedAccessToken ?? (await readBundle())?.access_token;
    return refreshUnderLock(rejected);
  }

  async function refreshUnderLock(rejectedAccessToken) {
    return withRefreshLock(async () => {
      const fresh = await readBundle();
      if (!fresh?.refresh_token) return null;
      // Reuse a token renewed by another process, but never retry the token
      // the API just rejected merely because its local expiry is in the future.
      if (fresh.expires_at - Date.now() > ACCESS_TOKEN_SKEW_MS &&
          (!rejectedAccessToken || fresh.access_token !== rejectedAccessToken)) {
        return fresh.access_token;
      }
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: fresh.refresh_token,
        client_id: fresh.client_id ?? LLAMA_CLI_CLIENT_ID,
        resource: fresh.resource,
      }).toString();
      let res;
      try {
        // @core-api-operation POST /api/oauth/token
        res = await fetch(`${fresh.issuer}/api/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
      } catch {
        throw new Error("Error[OAUTH_REFRESH_FAILED]: Could not reach the authorization server. Retry the command.");
      }
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        if (json?.error === "invalid_grant") {
          throw new Error("Error[OAUTH_REAUTH_REQUIRED]: Authorization expired or was revoked. Run `llama auth login` to sign in again in your browser.");
        }
        throw new Error(`Error[OAUTH_REFRESH_FAILED]: Could not renew authorization (HTTP ${res.status}). Retry the command.`);
      }
      if (!json?.access_token || !json?.refresh_token) {
        throw new Error("Error[OAUTH_REFRESH_FAILED]: Invalid token response. Retry the command.");
      }
      const newBundle = {
        ...fresh,
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
        scope: json.scope ?? fresh.scope,
      };
      await writeBundle(newBundle);
      return newBundle.access_token;
    });
  }
  return { getValidAccessToken, forceRefresh };
}

const manager = createOAuthTokenManager({
  readBundle, writeBundle, withRefreshLock,
  fetch: globalThis.fetch.bind(globalThis),
});
export const getValidAccessToken = manager.getValidAccessToken;
export const forceRefresh = manager.forceRefresh;
