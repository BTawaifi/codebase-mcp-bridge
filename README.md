# Codebase MCP Bridge

A compact [Model Context Protocol](https://modelcontextprotocol.io) server that gives LLM clients (ChatGPT, Claude, Codex, Gemini, Cursor) **controlled** access to a source repository: search, read, patch with rollback, Git, and allowlisted validation.

> **Design rule:** the bridge provides capabilities and facts; the model provides workflow and reasoning.

There are no prompts, no workflow macros and no mandatory call sequence, just 16 small tools with hard limits and a server-side security model the model can't talk its way around.

## Highlights

- **Safe edits.** `code.patch` applies unified diffs with stale-content checks and takes a rollback snapshot. Every mutation can be undone with `code.rollback`, which itself creates an inverse snapshot.
- **Batched, bounded I/O.** Up to 10 searches or 10 file/range reads per call, run with bounded concurrency. Each search returns up to 200 matches by default (500 on request). Combined output is capped and truncation is always reported. File discovery is paginated.
- **Secrets stay out.** Search and read skip secret-bearing files. Git operations refuse `.env`, private keys and Git internals. Audit logs store metadata only, never source or full arguments.
- **Operator-controlled trust.** The model can list and target workspaces but can't add them. Trust is granted out of band with a CLI.
- **Validation without a shell.** `validation.run` runs allowlisted command ids. Its arguments reject shell metacharacters, and output defaults to failures only. Arbitrary shell (`command.run`) is off unless the operator enables it.
- **Two transports.** stdio for local agents; Streamable HTTP with OAuth (dynamic client registration, refresh tokens) for ChatGPT connectors and remote clients. High-risk tools stay blocked over HTTP unless explicitly allowed.

## Tools

| Group | Tools | Notes |
|---|---|---|
| Workspace | `workspace.list`, `workspace.status` | `workspaceId` is optional; defaults to the repo the server started in |
| Code | `code.search`, `code.read`, `code.symbols`, `code.references` | Text/regex search and file globbing; incremental lexical symbol cache. `code.references` is explicitly *low-confidence lexical*, not an LSP graph. |
| Edits | `code.patch`, `code.write`, `code.delete`, `code.rollback` | All mutations snapshot for rollback |
| Git | `git.status`, `git.diff`, `git.commit`, `git.push` | `git.commit` can stage and commit only given paths. An invalid diff base fails instead of silently picking another. `git.push` is treated as high risk. |
| Validation | `validation.run`, `command.run` | Allowlisted checks; `command.run` is an opt-in, time- and output-bounded escape hatch |

Typical small fix: `code.search` → `code.read` → `code.patch` → `validation.run`.

## Quick start

```bash
npm install
npm run build
node dist/stdio.js          # stdio, for local agents
npm run dev                 # HTTP endpoint at http://localhost:3030/mcp
```

Client setup (Claude, Codex, Cursor, Gemini CLI, ChatGPT connector over OAuth) is in [docs/clients.md](docs/clients.md). Tool-selection guidance for models is in [docs/mcp-instructions.md](docs/mcp-instructions.md).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `BRIDGE_REPO_ROOT` | launch directory | Repository the bridge serves when no `workspaceId` is given |
| `BRIDGE_PORT` | `3030` | HTTP port |
| `BRIDGE_PUBLIC_URL` | `http://localhost:<port>` | OAuth/public issuer URL (set to your tunnel URL) |
| `BRIDGE_ALLOW_UNAUTHENTICATED_LOCAL` | `false` | Skip OAuth for local HTTP; does **not** unlock high-risk tools |
| `BRIDGE_REQUIRE_CLIENT_SECRET` | `true` | Require an OAuth client secret |
| `BRIDGE_SECURITY_STRICT` | `false` | Refuse to start when security warnings exist |
| `BRIDGE_OAUTH_SETUP_SECRET` | unset | Protect dynamic client registration |
| `BRIDGE_ALLOW_HIGH_RISK_HTTP` | `false` | Allow `git.push` / `command.run` over HTTP |
| `BRIDGE_ENABLE_COMMAND_RUN` | `false` | Enable `command.run` |
| `BRIDGE_MAX_COMMAND_OUTPUT_BYTES` | `50000` | Raw command output cap |
| `CODEBASE_MCP_WORKSPACE_MANIFEST` | unset | Override the validation-command manifest |

Trust another repository: `npm run workspace -- trust "C:\path\to\repo" my-repo`.

Transient data (symbol cache, rollback snapshots, audit log, OAuth state) lives in `.ai-bridge/` inside each repository.

## Project layout

```text
src/
  createBridgeServer.ts   tool registration, input schemas and limits
  server.ts / stdio.ts    HTTP (Express + OAuth) and stdio entry points
  workspace-cli.ts        operator CLI for trusted workspaces
  config/                 path allowlist, validation commands, workspace manifest
  services/               repo (search/read), indexer (symbols), patches (diff + rollback),
                          git, policy + security (risk and secret rules), oauth, audit, workspaces
tests/                    node:test suites: tool bounds, security, OAuth, patching, git, routing, performance
```

## Development

```bash
npm run typecheck
npm test          # typecheck + node:test suites
npm run build
```

## License

MIT. See [LICENSE](LICENSE).
