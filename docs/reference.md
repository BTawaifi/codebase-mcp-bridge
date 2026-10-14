> Full tool reference: the original detailed README, kept here so the [main README](../README.md) can stay short.

# Codebase MCP Bridge

A compact MCP server for working with source repositories. The bridge exposes filesystem, search, Git, validation, and rollback capabilities; the client model decides how to combine them.

The design rule is simple:

> The bridge provides capabilities and facts. The model provides workflow and reasoning.

It supports **stdio** and **Streamable HTTP** transports.

## Public MCP surface

```text
workspace.list
workspace.status

code.search
code.read
code.symbols
code.references
code.patch
code.write
code.delete
code.rollback

git.status
git.diff
git.commit
git.push

validation.run
command.run
```

There are no MCP prompts or workflow-macro tools.

### Workspace

- `workspace.list` lists workspaces trusted by the server operator.
- `workspace.status` returns identity/path/type for a workspace.
- `workspaceId` is optional on operational tools. When omitted, the bridge uses the repository it was started in. Supplying an id targets that trusted workspace without mutable "active workspace" state.

Trust expansion is intentionally **not** an MCP capability. Configure additional workspaces out of band:

```powershell
npm run workspace -- list
npm run workspace -- trust "C:\Projects\my-repo" my-repo
npm run workspace -- untrust my-repo
```

### Code

- `code.search` batches up to 10 queries with bounded concurrency and combined match/context output. Default text mode supports literal/regex searches; `mode: "files"` discovers files by glob, with up to 200 results per query and `offset`/`nextOffset` pagination. Interrupted searches and output limits explicitly report truncation.
- `code.read` batches up to 10 file/range reads with bounded filesystem concurrency.
- `code.symbols` searches an incremental lexical symbol cache.
- Symbol searches report truncation; incoming impact traversal builds reference lookups once per query.
- `code.references` returns explicitly low-confidence identifier-based caller/callee/impact estimates. It is not an AST/LSP call graph.
- `code.patch` applies a unified diff with stale-content checks and rollback snapshots.
- `code.write` creates or replaces a complete file.
- `code.delete` deletes one file with rollback support.
- `code.rollback` restores a rollback snapshot and creates an inverse rollback snapshot.

### Git

- `git.status` returns branch plus staged, unstaged, mixed, and untracked paths.
- `git.diff` returns exact Git diff facts; an invalid explicit base fails rather than silently choosing another branch.
- `git.commit` commits the existing index or, when `paths` are supplied, stages and commits only those paths.
- `git.push` performs remote impact and is treated separately from local Git operations.

Git path operations block sensitive files such as `.env` and private-key material but do not confuse model-read exclusions with Git exclusions; explicit lockfiles/generated files may still be committed.

### Validation and shell

- `validation.run` runs configured allowlisted validation command ids and returns compact structured results. Successful runs default to failure-focused output to avoid returning thousands of irrelevant test lines. When exactly one command is selected, optional safe `args` can target a specific spec/file/flag without exposing shell syntax; npm validators automatically receive them after `--`.
- `command.run` is an escape hatch. It is disabled unless `BRIDGE_ENABLE_COMMAND_RUN=true`, has a bounded timeout/output size, and is classified high risk. It returns structured `status`, `exitCode`, `durationMs`, `timedOut`, `output`, and `error` fields even when the command exits non-zero.

`validation.run` arguments reject control characters and shell metacharacters; spaces inside one argument are preserved safely. If a validation needs arbitrary shell composition, use the explicitly high-risk `command.run` capability instead of weakening the allowlisted path.

## Fast client usage

There is no mandatory call sequence. Use the smallest capability that answers the current question.

Typical small fix:

```text
code.search  -> locate relevant code, batching related queries
code.read    -> read the few relevant ranges in one call
code.patch   -> apply the edit
validation.run
```

Use `code.symbols` when symbol discovery is materially better than text search. Use `code.references` only when an approximate relationship estimate is useful. Do not call either ritualistically.

Find filenames without searching their contents:

```json
{"queries":[{"mode":"files","query":"src/**/*.ts","maxMatches":200,"offset":0}]}
```

Use the returned `nextOffset` for the next page; `null` means no more results. Pagination reflects the current directory contents, so changes between calls can shift pages. File discovery does not follow symbolic links.

For an already-known file and change, it is valid to go directly to `code.read` or `code.patch`.

## Search and symbol semantics

`code.search` is text retrieval, not "semantic search".

The symbol cache stores definitions and lexical identifier references. `code.references` deliberately reports:

```text
confidence: low
basis: lexical-identifier-matching
```

For true semantic/resolved reference behavior, use a future compiler/LSP-backed implementation rather than overstating lexical matching.

## Run

```powershell
npm install
npm run dev
```

HTTP MCP endpoint:

```text
http://localhost:3030/mcp
```

Stdio during development:

```powershell
npm run stdio
```

Compiled stdio:

```powershell
npm run build
node dist/stdio.js
```

## HTTP/OAuth

HTTP mode uses OAuth by default. Set the externally reachable issuer URL when using a tunnel:

```powershell
$env:BRIDGE_PUBLIC_URL="https://your-tunnel.example.com"
npm run dev
```

The connector endpoint is then:

```text
https://your-tunnel.example.com/mcp
```

Relevant controls:

| Variable | Default | Meaning |
|---|---|---|
| `BRIDGE_PORT` | `3030` | HTTP port |
| `BRIDGE_PUBLIC_URL` | `http://localhost:<port>` | OAuth/public issuer URL |
| `BRIDGE_ALLOW_UNAUTHENTICATED_LOCAL` | `false` | Skip OAuth checks for local HTTP; does **not** bypass high-risk HTTP blocking |
| `BRIDGE_REQUIRE_CLIENT_SECRET` | `true` | Require OAuth client secret |
| `BRIDGE_SECURITY_STRICT` | `false` | Refuse startup when security warnings exist |
| `BRIDGE_OAUTH_SETUP_SECRET` | unset | Protect dynamic client registration/authorization setup |
| `BRIDGE_ALLOW_HIGH_RISK_HTTP` | `false` | Opt in to high-risk/external-impact HTTP tools |
| `BRIDGE_ENABLE_COMMAND_RUN` | `false` | Enable `command.run` |
| `BRIDGE_MAX_COMMAND_OUTPUT_BYTES` | `50000` | Raw command output cap |
| `CODEBASE_MCP_WORKSPACE_MANIFEST` | unset | Absolute validation-manifest override |

`git.push` and `command.run` are blocked over HTTP unless `BRIDGE_ALLOW_HIGH_RISK_HTTP=true`, even when unauthenticated-local mode is enabled.

See [clients.md](clients.md) for connector setup.

## Local safety

- Repository paths are confined to the selected repository.
- Read/search paths exclude secret-bearing content.
- Code mutations create rollback snapshots.
- Git commits reject sensitive staged paths.
- Arbitrary shell is opt-in.
- Audit logging stores metadata only (tool/repository/status/duration/result size/error), not source patches or full tool arguments.

Transient bridge data lives under `.ai-bridge/`, principally:

```text
.ai-bridge/
  symbols.json
  symbol-manifest.json
  rollback/
  audit.jsonl
  oauth.json
```

The trusted-workspace registry lives under the bridge operator's home `.ai-bridge/workspaces.json`.

## Validation

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

After changing MCP registrations or schemas, rebuild and restart the running bridge process before judging the live tool surface.
