import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Response } from "express";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

const DEFAULT_SCOPES = ["mcp:read", "mcp:write"];

type AuthCode = {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
};

type TokenRecord = {
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
};

type OAuthState = {
  clients: OAuthClientInformationFull[];
  accessTokens: Record<string, TokenRecord>;
  refreshTokens: Record<string, TokenRecord>;
};

export class InMemoryOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly codes = new Map<string, AuthCode>();
  private readonly accessTokens = new Map<string, TokenRecord>();
  private readonly refreshTokens = new Map<string, TokenRecord>();
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly statePath: string;

  constructor(
    private readonly issuerUrl: URL,
    repoRoot = process.env.BRIDGE_REPO_ROOT ?? process.cwd()
  ) {
    this.statePath = path.join(repoRoot, ".ai-bridge", "oauth.json");
    this.loadState();
    this.clientsStore = {
      getClient: (clientId: string) => this.clients.get(clientId),
      registerClient: async (client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) => {
        const now = Math.floor(Date.now() / 1000);
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: crypto.randomUUID(),
          client_id_issued_at: now,
          client_secret: crypto.randomBytes(32).toString("base64url"),
          client_secret_expires_at: 0
        };
        this.clients.set(full.client_id, full);
        await this.saveState();
        return full;
      }
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const code = crypto.randomBytes(32).toString("base64url");
    this.codes.set(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      scopes: params.scopes?.length ? params.scopes : DEFAULT_SCOPES,
      resource: params.resource?.toString(),
      expiresAt: Date.now() + 10 * 60_000
    });

    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set("code", code);
    if (params.state) redirect.searchParams.set("state", params.state);
    res.redirect(302, redirect.toString());
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const record = this.getCode(client, authorizationCode);
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const record = this.getCode(client, authorizationCode);
    if (redirectUri && redirectUri !== record.redirectUri) throw new Error("redirect_uri mismatch");
    this.codes.delete(authorizationCode);
    return this.issueTokens(client.client_id, record.scopes, resource?.toString() ?? record.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const record = this.refreshTokens.get(refreshToken);
    if (!record || record.clientId !== client.client_id || record.expiresAt < Date.now()) throw new Error("Invalid refresh token");
    return this.issueTokens(client.client_id, scopes?.length ? scopes : record.scopes, resource?.toString() ?? record.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.accessTokens.get(token);
    if (!record || record.expiresAt < Date.now()) throw new Error("Invalid access token");
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: record.resource ? new URL(record.resource) : undefined
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.accessTokens.delete(request.token);
    this.refreshTokens.delete(request.token);
    await this.saveState();
  }

  private getCode(client: OAuthClientInformationFull, authorizationCode: string): AuthCode {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAt < Date.now()) throw new Error("Invalid authorization code");
    return record;
  }

  private async issueTokens(clientId: string, scopes: string[], resource?: string): Promise<OAuthTokens> {
    const accessToken = crypto.randomBytes(32).toString("base64url");
    const refreshToken = crypto.randomBytes(32).toString("base64url");
    const expiresIn = 60 * 60;
    const record: TokenRecord = {
      clientId,
      scopes: scopes.length ? scopes : DEFAULT_SCOPES,
      resource,
      expiresAt: Date.now() + expiresIn * 1000
    };
    this.accessTokens.set(accessToken, record);
    this.refreshTokens.set(refreshToken, { ...record, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 });
    await this.saveState();
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: record.scopes.join(" ")
    };
  }

  private loadState(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as OAuthState;
      for (const client of parsed.clients ?? []) this.clients.set(client.client_id, client);
      for (const [token, record] of Object.entries(parsed.accessTokens ?? {})) this.accessTokens.set(token, record);
      for (const [token, record] of Object.entries(parsed.refreshTokens ?? {})) this.refreshTokens.set(token, record);
    } catch {
      // Fresh bridge state.
    }
  }

  private async saveState(): Promise<void> {
    await fsp.mkdir(path.dirname(this.statePath), { recursive: true });
    const state: OAuthState = {
      clients: [...this.clients.values()],
      accessTokens: Object.fromEntries(this.accessTokens),
      refreshTokens: Object.fromEntries(this.refreshTokens)
    };
    await fsp.writeFile(this.statePath, JSON.stringify(state, null, 2), "utf8");
  }
}