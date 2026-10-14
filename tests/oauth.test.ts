import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryOAuthProvider } from "../src/services/oauth.js";

test("OAuth provider registers clients and verifies access tokens", async () => {
  const provider = new InMemoryOAuthProvider(new URL("http://localhost:3030"));
  const client = await provider.clientsStore.registerClient?.({
    redirect_uris: ["http://localhost/callback"],
    token_endpoint_auth_method: "client_secret_post",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "test-client"
  });
  assert.ok(client);

  const code = "test-code";
  // Use the public provider flow through a minimal redirect response shim.
  let redirected = "";
  await provider.authorize(
    client,
    {
      redirectUri: "http://localhost/callback",
      codeChallenge: "challenge",
      scopes: ["mcp:read"],
      state: "state"
    },
    {
      req: { query: {}, body: {} },
      redirect: (_status: number, url: string) => {
        redirected = url;
      }
    } as never
  );

  const redirectedUrl = new URL(redirected);
  const authCode = redirectedUrl.searchParams.get("code");
  assert.ok(authCode);
  assert.equal(await provider.challengeForAuthorizationCode(client, authCode), "challenge");

  const tokens = await provider.exchangeAuthorizationCode(client, authCode, undefined, "http://localhost/callback");
  assert.equal(tokens.token_type, "Bearer");
  const authInfo = await provider.verifyAccessToken(tokens.access_token);
  assert.equal(authInfo.clientId, client.client_id);
  assert.deepEqual(authInfo.scopes, ["mcp:read"]);

  await provider.revokeToken?.(client, { token: tokens.access_token });
  await assert.rejects(() => provider.verifyAccessToken(tokens.access_token), /Invalid access token/);
});