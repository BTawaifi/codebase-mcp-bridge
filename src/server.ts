import "dotenv/config";
import express from "express";
import process from "node:process";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createBridgeServer, createBridgeServices } from "./createBridgeServer.js";
import { InMemoryOAuthProvider } from "./services/oauth.js";
import { classifyTool } from "./services/policy.js";

const port = Number(process.env.PORT ?? process.env.BRIDGE_PORT ?? 3030);
const publicUrl = new URL(process.env.BRIDGE_PUBLIC_URL ?? `http://localhost:${port}`);
const mcpUrl = new URL("/mcp", publicUrl);
const allowUnauthenticatedLocal = process.env.BRIDGE_ALLOW_UNAUTHENTICATED_LOCAL === "true";
const requireClientSecret = process.env.BRIDGE_REQUIRE_CLIENT_SECRET !== "false";
const securityStrict = process.env.BRIDGE_SECURITY_STRICT === "true";
const startupSecurityWarnings = getStartupSecurityWarnings({ publicUrl, allowUnauthenticatedLocal, requireClientSecret });
if (securityStrict && startupSecurityWarnings.length > 0) {
  throw new Error(`Refusing to start in strict security mode: ${startupSecurityWarnings.join("; ")}`);
}
for (const warning of startupSecurityWarnings) console.warn(`[security warning] ${warning}`);
const services = createBridgeServices();
const oauthProvider = new InMemoryOAuthProvider(publicUrl);

process.on("uncaughtException", (error) => console.error("uncaughtException", error));
process.on("unhandledRejection", (error) => console.error("unhandledRejection", error));

const app = createMcpExpressApp({ host: publicUrl.hostname });
app.use(express.urlencoded({ extended: false }));

app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json(oauthMetadata());
});

app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
  res.json({
    resource: mcpUrl.href,
    authorization_servers: [publicUrl.href],
    scopes_supported: ["mcp:read", "mcp:write"],
    resource_name: "Codebase MCP Bridge"
  });
});

app.post("/register", async (req, res) => {
  try {
    if (!setupSecretAllowed(req)) return res.status(403).json({ error: "forbidden", error_description: "Missing or invalid setup secret" });
    const registered = await oauthProvider.clientsStore.registerClient?.(req.body ?? {});
    if (!registered) return res.status(400).json({ error: "registration_not_supported" });
    res.status(201).json(registered);
  } catch (error) {
    res.status(400).json({ error: "invalid_client_metadata", error_description: messageOf(error) });
  }
});

app.get("/authorize", authorizeHandler);
app.post("/authorize", authorizeHandler);

app.post("/token", async (req, res) => {
  try {
    const client = await authenticateOAuthClient(req.body ?? {});
    const grantType = req.body?.grant_type;
    if (grantType === "authorization_code") {
      const tokens = await oauthProvider.exchangeAuthorizationCode(
        client,
        String(req.body.code ?? ""),
        req.body.code_verifier ? String(req.body.code_verifier) : undefined,
        req.body.redirect_uri ? String(req.body.redirect_uri) : undefined,
        req.body.resource ? new URL(String(req.body.resource)) : undefined
      );
      return res.json(tokens);
    }
    if (grantType === "refresh_token") {
      const scopes = req.body.scope ? String(req.body.scope).split(" ") : undefined;
      const tokens = await oauthProvider.exchangeRefreshToken(
        client,
        String(req.body.refresh_token ?? ""),
        scopes,
        req.body.resource ? new URL(String(req.body.resource)) : undefined
      );
      return res.json(tokens);
    }
    res.status(400).json({ error: "unsupported_grant_type" });
  } catch (error) {
    res.status(400).json({ error: "invalid_grant", error_description: messageOf(error) });
  }
});

app.post("/revoke", async (req, res) => {
  try {
    const client = await authenticateOAuthClient(req.body ?? {});
    await oauthProvider.revokeToken?.(client, { token: String(req.body.token ?? ""), token_type_hint: req.body.token_type_hint });
    res.status(200).end();
  } catch {
    res.status(200).end();
  }
});

const authMiddleware = allowUnauthenticatedLocal
  ? (_req: unknown, _res: unknown, next: () => void) => next()
  : requireBearerAuth({
      verifier: oauthProvider,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
      requiredScopes: []
    });

app.post("/mcp", authMiddleware, async (req, res) => {
  if (!allowUnauthenticatedLocal) {
    const requiredScopes = requiredScopesForMcpRequest(req.body);
    const grantedScopes = new Set(Array.isArray((req as any).auth?.scopes) ? (req as any).auth.scopes : []);
    const missingScopes = requiredScopes.filter((scope) => !grantedScopes.has(scope));
    if (missingScopes.length > 0) {
      res.setHeader("WWW-Authenticate", `Bearer error="insufficient_scope", scope="${missingScopes.join(" ")}"`);
      return res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: `Insufficient OAuth scope. Required: ${missingScopes.join(", ")}` },
        id: requestId(req.body)
      });
    }

  }

  const blockedTools = highRiskHttpTools(req.body);
  if (blockedTools.length > 0 && process.env.BRIDGE_ALLOW_HIGH_RISK_HTTP !== "true") {
    return res.status(403).json({
      jsonrpc: "2.0",
      error: {
        code: -32002,
        message: `High-risk HTTP tools are disabled by default: ${blockedTools.join(", ")}. Set BRIDGE_ALLOW_HIGH_RISK_HTTP=true to opt in.`
      },
      id: requestId(req.body)
    });
  }

  const server = createBridgeServer(services);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: error instanceof Error ? error.message : "Internal server error" },
        id: null
      });
    }
  }
});

app.get("/mcp", authMiddleware, (_req, res) => {
  res.status(405).json({ error: "Method not allowed. Use POST for MCP Streamable HTTP." });
});

app.head("/mcp", authMiddleware, (_req, res) => {
  res.status(405).end();
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    name: "codebase-mcp-bridge",
    ...(includeHealthSecurityDetails() ? { auth: allowUnauthenticatedLocal ? "disabled-local" : "oauth", securityStrict, securityWarnings: startupSecurityWarnings.length } : {}),
    ...(process.env.BRIDGE_HEALTH_INCLUDE_REPO_ROOT === "true" ? { repoRoot: services.repoRoot } : {}),
  });
});

app.listen(port, "127.0.0.1", (error?: Error) => {
  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log(`Codebase MCP Bridge listening on http://127.0.0.1:${port}/mcp`);
  console.log(`Public OAuth issuer URL: ${publicUrl.toString()}`);
});

async function authorizeHandler(req: any, res: any): Promise<void> {
  try {
    const params = req.method === "POST" ? req.body : req.query;
    const clientId = String(params.client_id ?? "");
    const redirectUri = String(params.redirect_uri ?? "");
    const client = await oauthProvider.clientsStore.getClient(clientId);
    if (!client) return redirectOAuthError(res, redirectUri, "invalid_client", params.state);
    if (!client.redirect_uris?.includes(redirectUri)) return redirectOAuthError(res, redirectUri, "invalid_request", params.state);
    await oauthProvider.authorize(
      client,
      {
        redirectUri,
        state: params.state ? String(params.state) : undefined,
        scopes: params.scope ? String(params.scope).split(" ") : ["mcp:read", "mcp:write"],
        codeChallenge: params.code_challenge ? String(params.code_challenge) : "connector-no-pkce",
        resource: params.resource ? new URL(String(params.resource)) : undefined
      },
      res
    );
  } catch (error) {
    res.status(400).json({ error: "invalid_request", error_description: messageOf(error) });
  }
}

function redirectOAuthError(res: any, redirectUri: string, error: string, state?: string): void {
  if (!redirectUri || !URL.canParse(redirectUri)) {
    res.status(400).json({ error });
    return;
  }
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("error", error);
  if (state) redirect.searchParams.set("state", state);
  res.redirect(302, redirect.toString());
}

async function authenticateOAuthClient(body: Record<string, unknown>): Promise<OAuthClientInformationFull> {
  const clientId = String(body.client_id ?? "");
  const client = await oauthProvider.clientsStore.getClient(clientId);
  if (!client) throw new Error("Invalid client_id");
  const suppliedSecret = body.client_secret === undefined ? undefined : String(body.client_secret);
  if (requireClientSecret && client.client_secret && !suppliedSecret) throw new Error("Client secret is required");
  if (client.client_secret && suppliedSecret !== client.client_secret) throw new Error("Invalid client_secret");
  return client;
}

function setupSecretAllowed(req: any): boolean {
  const secret = process.env.BRIDGE_OAUTH_SETUP_SECRET?.trim();
  if (!secret) return true;
  const supplied = req.header?.("x-bridge-setup-secret") ?? req.query?.setup_secret ?? req.body?.setup_secret;
  return supplied === secret;
}

function oauthMetadata() {
  return {
    issuer: publicUrl.href,
    authorization_endpoint: new URL("/authorize", publicUrl).href,
    token_endpoint: new URL("/token", publicUrl).href,
    registration_endpoint: new URL("/register", publicUrl).href,
    revocation_endpoint: new URL("/revoke", publicUrl).href,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: requireClientSecret ? ["client_secret_post"] : ["none", "client_secret_post"],
    scopes_supported: ["mcp:read", "mcp:write"],
    code_challenge_methods_supported: ["S256"]
  };
}

function requiredScopesForMcpRequest(body: unknown): Array<"mcp:read" | "mcp:write"> {
  const messages = Array.isArray(body) ? body : [body];
  const scopes = new Set<"mcp:read" | "mcp:write">();

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const method = (message as { method?: unknown }).method;
    if (method === "tools/call") {
      const params = (message as { params?: { name?: unknown } }).params;
      const tool = typeof params?.name === "string" ? params.name : undefined;
      if (!tool) {
        scopes.add("mcp:read");
        continue;
      }
      scopes.add(classifyTool(tool) === "read_only" ? "mcp:read" : "mcp:write");
      continue;
    }

    // Protocol discovery, initialization, prompts, resources, and tool listing are reads.
    scopes.add("mcp:read");
  }

  return [...scopes];
}

function requestId(body: unknown): string | number | null {
  if (Array.isArray(body)) return null;
  if (!body || typeof body !== "object") return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function highRiskHttpTools(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  const tools = new Set<string>();
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if ((message as { method?: unknown }).method !== "tools/call") continue;
    const params = (message as { params?: { name?: unknown } }).params;
    const tool = typeof params?.name === "string" ? params.name : undefined;
    if (!tool) continue;
    const risk = classifyTool(tool);
    if (risk === "high_risk" || risk === "external_impact") tools.add(tool);
  }
  return [...tools];
}

function jsonBody(req: any, res: any, next: () => void): void {
  let body = "";
  req.on("data", (chunk: Buffer) => (body += chunk));
  req.on("end", () => {
    req.body = body ? JSON.parse(body) : {};
    next();
  });
  req.on("error", () => res.status(400).json({ error: "invalid_request" }));
}

function jsonAndFormBody(req: any, res: any, next: () => void): void {
  let body = "";
  req.on("data", (chunk: Buffer) => (body += chunk));
  req.on("end", () => {
    const contentType = String(req.headers["content-type"] ?? "");
    if (!body) req.body = {};
    else if (contentType.includes("application/json")) req.body = JSON.parse(body);
    else req.body = Object.fromEntries(new URLSearchParams(body));
    next();
  });
  req.on("error", () => res.status(400).json({ error: "invalid_request" }));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getStartupSecurityWarnings(input: { publicUrl: URL; allowUnauthenticatedLocal: boolean; requireClientSecret: boolean }): string[] {
  const warnings: string[] = [];
  const publicHost = !isLocalHost(input.publicUrl.hostname);
  if (publicHost && !process.env.BRIDGE_OAUTH_SETUP_SECRET?.trim()) warnings.push("missing setup secret for non-local public URL");
  if (publicHost && input.allowUnauthenticatedLocal) warnings.push("unauthenticated local mode enabled for non-local public URL");
  if (publicHost && !input.requireClientSecret) warnings.push("client secret auth disabled for non-local public URL");
  return warnings;
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function includeHealthSecurityDetails(): boolean {
  return process.env.BRIDGE_HEALTH_INCLUDE_SECURITY === "true" || isLocalHost(publicUrl.hostname);
}
