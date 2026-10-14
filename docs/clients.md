# Connecting clients

The bridge speaks MCP over **stdio** (local clients) and **Streamable HTTP** (anything that needs a network endpoint, with OAuth).

## Stdio: Claude Code, Codex, Antigravity, Gemini CLI and other local agents

```json
{
  "mcpServers": {
    "codebase-mcp-bridge": {
      "command": "node",
      "args": ["dist/stdio.js"]
    }
  }
}
```

`npm run mcp:install` / `npm run mcp:uninstall` registers or removes the bridge in the Claude Desktop, Claude Code and Cursor configs (Windows, macOS and Linux paths). `npm run mcp:sync` writes the Gemini CLI config and copies [`mcp-instructions.md`](mcp-instructions.md) as its tool-selection guidance.

## HTTP + OAuth: ChatGPT developer-mode connector and remote clients

1. Expose the local endpoint `http://127.0.0.1:3030/mcp` through an HTTPS tunnel. `scripts/start-all.ps1` does this with Cloudflare Tunnel: it starts the tunnel, reads the public URL, starts the bridge and registers the OAuth client.
2. Start the bridge with the public URL as the OAuth issuer:

   ```powershell
   $env:BRIDGE_PUBLIC_URL="https://your-tunnel.example.com"
   npm run dev
   ```

3. Point the client at `https://your-tunnel.example.com/mcp`.

The bridge publishes OAuth authorization-server and protected-resource metadata, and supports:
- dynamic client registration;
- authorization-code exchange;
- refresh tokens;
- bearer-token MCP calls.

To lock down registration, set `BRIDGE_OAUTH_SETUP_SECRET`. For a pre-registered client:

```powershell
$env:BRIDGE_OAUTH_SETUP_SECRET="choose-a-long-random-secret"
$env:BRIDGE_REQUIRE_CLIENT_SECRET="true"
npm run chatgpt:register -- -CallbackUrl "https://chatgpt.com/connector/oauth/YOUR_CALLBACK_ID"
```

The script prints the connector URL, client id and secret, authorization and token URLs, resource and scopes to paste into ChatGPT's advanced OAuth settings. Use `client_secret_post` when client secrets are required.

### HTTP safety

OAuth scopes and the high-risk gate are separate controls:
- `BRIDGE_ALLOW_UNAUTHENTICATED_LOCAL=true` skips OAuth for local HTTP use, but does **not** unlock high-risk tools.
- `git.push` and `command.run` stay blocked over HTTP unless `BRIDGE_ALLOW_HIGH_RISK_HTTP=true`.
- `command.run` additionally needs `BRIDGE_ENABLE_COMMAND_RUN=true`.

## Working in more than one repository

Tools default to the repository the bridge was started in. Extra repositories are trusted by the operator outside MCP; the model can't widen its own access:

```powershell
npm run workspace -- trust "C:\path\to\repo" my-repo
```

Clients then discover ids with `workspace.list` and pass `workspaceId` to code, Git and validation tools.
