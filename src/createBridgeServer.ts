import path from "node:path";
import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AuditService } from "./services/audit.js";
import { GitService } from "./services/git.js";
import { IndexerService } from "./services/indexer.js";
import { PatchService } from "./services/patches.js";
import { RepoService } from "./services/repo.js";
import { SecurityService } from "./services/security.js";
import { WorkspaceService } from "./services/workspaces.js";
import { COMMAND_IDS } from "./config/commands.js";
import { MAX_SEARCH_RESULTS } from "./config/allowlist.js";

export type BridgeServices = {
  repoRoot: string;
  security: SecurityService;
  workspaces: WorkspaceService;
  audit: AuditService;
  git: GitService;
  repo: RepoService;
  indexer: IndexerService;
  patches: PatchService;
  workspaceCache: Map<string, { path: string; services: BridgeServices }>;
};

export function createBridgeServices(
  repoRoot = process.env.BRIDGE_REPO_ROOT ?? process.cwd(),
  workspaces = new WorkspaceService(),
  workspaceCache: Map<string, { path: string; services: BridgeServices }> = new Map(),
): BridgeServices {
  repoRoot = path.resolve(repoRoot);
  const security = new SecurityService(repoRoot);
  const audit = new AuditService(repoRoot);
  const git = new GitService(repoRoot);
  const repo = new RepoService(repoRoot, security);
  const indexer = new IndexerService(repoRoot, repo);
  const patches = new PatchService(repoRoot, security);
  return { repoRoot, security, workspaces, audit, git, repo, indexer, patches, workspaceCache };
}

type ToolHandler<T> = (args: T, services: BridgeServices) => Promise<string>;

const SEARCH_CONCURRENCY = 4;
const READ_CONCURRENCY = 8;
const PUBLIC_SEARCH_MAX_MATCHES = Math.min(MAX_SEARCH_RESULTS, 500);
const DEFAULT_SEARCH_MATCHES = Math.min(PUBLIC_SEARCH_MAX_MATCHES, 200);
const MAX_SEARCH_LINE_CHARS = 1_000;
const MAX_READ_BATCH_CHARS = 300_000;
const MAX_SEARCH_BATCH_CHARS = 300_000;

const workspaceIdSchema = z.string().min(1);
const symbolKindSchema = z.enum(["class", "interface", "function", "method", "other"]);
const searchQuerySchema = z.union([z.object({
  mode: z.literal("text").optional(),
  query: z.string().min(1),
  glob: z.string().optional(),
  contextLines: z.number().int().min(0).max(20).optional(),
  caseInsensitive: z.boolean().optional(),
  isRegex: z.boolean().optional(),
  maxMatches: z.number().int().positive().max(PUBLIC_SEARCH_MAX_MATCHES).optional(),
}), z.object({
  mode: z.literal("files"),
  query: z.string().min(1).describe("Repository-relative file glob, e.g. src/**/*.ts"),
  maxMatches: z.number().int().positive().max(200).optional(),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
})]);
const fileReadSchema = z.object({
    path: z.string().min(1),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    redactSecrets: z.boolean().optional(),
  })
  .refine(
    ({ startLine, endLine }) => startLine === undefined || endLine === undefined || endLine >= startLine,
    { message: "endLine must be greater than or equal to startLine" },
  );
const referenceInputSchema = z.object({
    workspaceId: workspaceIdSchema.optional(),
    symbolName: z.string().min(1),
    direction: z.enum(["incoming", "outgoing", "impact"]),
    maxDepth: z.number().int().positive().max(10).optional().describe("Traversal depth for impact lookups; ignored for incoming and outgoing lookups."),
  });
const gitArgumentSchema = z.string().min(1).max(512).refine((value) => !value.startsWith("-") && !/[\0\r\n]/.test(value), {
  message: "Git argument must not start with '-' or contain control line breaks",
});
const validationArgumentSchema = z.string().min(1).max(512).refine(
  (value) => /^[A-Za-z0-9_./:@\\=,+-]+(?:[ \t]+[A-Za-z0-9_./:@\\=,+-]+)*$/.test(value),
  { message: "Validation arguments must be argv-like values without shell metacharacters" },
);

export function createBridgeServer(startupServices: BridgeServices): McpServer {
  const server = new McpServer(
    { name: "codebase-mcp-bridge", version: "1.0.0" },
    { capabilities: { logging: {} } },
  );

  function workspaceIdFromArgs(args: unknown): string | undefined {
    if (!args || typeof args !== "object") return undefined;
    const workspaceId = (args as { workspaceId?: unknown }).workspaceId;
    return typeof workspaceId === "string" && workspaceId.length > 0 ? workspaceId : undefined;
  }

  async function resolveServices(workspaceId?: string): Promise<BridgeServices> {
    if (!workspaceId) return startupServices;
    const entry = (await startupServices.workspaces.getWorkspaceEntries())
      .find((candidate) => candidate.id === workspaceId);
    if (!entry) throw new Error(`Unknown or untrusted workspaceId: ${workspaceId}.`);
    if (path.resolve(entry.path) === startupServices.repoRoot) return startupServices;
    const cached = startupServices.workspaceCache.get(workspaceId);
    if (cached && path.resolve(cached.path) === path.resolve(entry.path)) return cached.services;
    const services = createBridgeServices(entry.path, startupServices.workspaces, startupServices.workspaceCache);
    startupServices.workspaceCache.set(workspaceId, { path: entry.path, services });
    return services;
  }

  function logAudit(target: BridgeServices, event: Parameters<AuditService["log"]>[0]): void {
    void target.audit.log(event).catch((auditError) => {
      console.warn(`[audit warning] ${event.tool}: ${messageOf(auditError)}`);
    });
  }

  async function audited<T>(tool: string, args: T, handler: ToolHandler<T>) {
    const started = Date.now();
    let target: BridgeServices | undefined;
    try {
      target = await resolveServices(workspaceIdFromArgs(args));
      const result = await handler(args, target);
      logAudit(target, {
        client: "mcp",
        tool,
        repo: target.repoRoot,
        resultSize: Buffer.byteLength(result, "utf8"),
        status: "ok",
        durationMs: Date.now() - started,
      });
      return text(result);
    } catch (error) {
      const message = messageOf(error);
      const auditTarget = target ?? startupServices;
      logAudit(auditTarget, {
        client: "mcp",
        tool,
        repo: auditTarget.repoRoot,
        status: "error",
        durationMs: Date.now() - started,
        error: message,
      });
      return toolError(message);
    }
  }

  server.registerTool(
    "workspace.list",
    {
      description: "List trusted workspace identifiers and paths.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => audited("workspace.list", args, async () => JSON.stringify({
      workspaces: (await startupServices.workspaces.getWorkspaceEntries()).map(({ id, name, path: workspacePath, kind }) => ({
        id,
        name,
        path: workspacePath,
        kind,
      })),
    }, null, 2)),
  );

  server.registerTool(
    "workspace.status",
    {
      description: "Return identity and repository type for one trusted workspace.",
      inputSchema: { workspaceId: workspaceIdSchema.optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => audited("workspace.status", args, async ({ workspaceId }, target) => {
      const workspace = (await startupServices.workspaces.getWorkspaceEntries())
        .find((entry) => workspaceId ? entry.id === workspaceId : path.resolve(entry.path) === target.repoRoot);
      return JSON.stringify({
        workspaceId: workspace?.id ?? null,
        name: workspace?.name ?? path.basename(target.repoRoot),
        path: target.repoRoot,
        kind: workspace?.kind ?? "unknown",
        defaultWorkspace: workspaceId === undefined,
      }, null, 2);
    }),
  );

  server.registerTool(
    "code.search",
    {
      description: "Batch repository searches: default text mode supports literal/regex queries and context; files mode discovers paths by glob with offset pagination. Results and total output are bounded.",
      inputSchema: {
        workspaceId: workspaceIdSchema.optional(),
        queries: z.array(searchQuerySchema).min(1).max(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => audited("code.search", args, async ({ queries }, target) => {
      const results = await mapWithConcurrency(queries, SEARCH_CONCURRENCY, async (query) => {
        try {
          if (query.mode === "files") {
            return { mode: "files", query: query.query, ...asObject(await target.repo.findFiles(query.query, query.maxMatches ?? 100, query.offset ?? 0)) };
          }
          const result = await target.repo.searchStructured(
            query.query,
            query.glob,
            query.contextLines ?? 0,
            query.caseInsensitive,
            query.isRegex,
            { textOnly: true, includeAssets: false },
            query.maxMatches ?? DEFAULT_SEARCH_MATCHES,
          );
          return compactSearchResult(result);
        } catch (error) {
          return { query: query.query, error: messageOf(error) };
        }
      });
      let remaining = MAX_SEARCH_BATCH_CHARS;
      let outputLimited = false;
      const boundedResults = results.map((result) => {
        const entry = result as Record<string, unknown>;
        const key = entry.mode === "files" ? "files" : "matches";
        if (!Array.isArray(entry[key])) return entry;
        const items: unknown[] = [];
        for (const item of entry[key]) {
          const size = JSON.stringify(item).length;
          if (size > remaining) break;
          remaining -= size;
          items.push(item);
        }
        if (items.length === entry[key].length) return entry;
        outputLimited = true;
        return {
          ...entry, [key]: items, truncated: true, outputLimited: true,
          ...(key === "files" ? { count: items.length, nextOffset: Number(entry.offset) + items.length } : {}),
        };
      });
      return JSON.stringify({ results: boundedResults, ...(outputLimited ? { outputLimited: true } : {}) }, null, 2);
    }),
  );

  server.registerTool(
    "code.read",
    {
      description: "Read one or more repository files, optionally by 1-based line range and with secret-like content redacted.",
      inputSchema: {
        workspaceId: workspaceIdSchema.optional(),
        files: z.array(fileReadSchema).min(1).max(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => audited("code.read", args, async ({ files }, target) => {
      const reads = await mapWithConcurrency(files, READ_CONCURRENCY, async (file) => {
        try {
          return {
            status: "ok",
            path: file.path,
            startLine: file.startLine,
            endLine: file.endLine,
            content: file.redactSecrets
              ? await target.repo.readFileRedacted(file.path, file.startLine, file.endLine)
              : await target.repo.readFile(file.path, file.startLine, file.endLine),
          };
        } catch (error) {
          return { status: "error", path: file.path, error: messageOf(error) };
        }
      });
      let usedChars = 0;
      let outputLimited = false;
      const boundedReads = reads.map((read) => {
        if (read.status !== "ok" || typeof read.content !== "string") return read;
        if (usedChars + read.content.length > MAX_READ_BATCH_CHARS) {
          outputLimited = true;
          return {
            status: "error",
            path: read.path,
            startLine: read.startLine,
            endLine: read.endLine,
            error: `Batch read output limit of ${MAX_READ_BATCH_CHARS} characters reached; request fewer files or a narrower line range.`,
          };
        }
        usedChars += read.content.length;
        return read;
      });
      return JSON.stringify({
        files: boundedReads,
        ...(outputLimited ? { outputLimited: true, maxOutputChars: MAX_READ_BATCH_CHARS } : {}),
      }, null, 2);
    }),
  );

  server.registerTool(
    "code.symbols",
    {
      description: "Search cached symbol definitions by name and optional symbol kind. The symbol cache is refreshed incrementally before lookup.",
      inputSchema: {
        workspaceId: workspaceIdSchema.optional(),
        query: z.string().min(1),
        kind: symbolKindSchema.optional(),
        limit: z.number().int().positive().max(100).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => audited("code.symbols", args, async ({ query, kind, limit }, target) => {
      await target.indexer.ensureFreshIndex();
      return target.indexer.searchSymbols(query, kind, limit ?? 20);
    }),
  );

  server.registerTool(
    "code.references",
    {
      description: "Estimate lexical symbol relationships: incoming definitions that mention a symbol, outgoing known symbols mentioned by a definition, or recursive incoming impact. These are identifier matches, not resolved language-server references or a call graph.",
      inputSchema: referenceInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => audited("code.references", args, async ({ symbolName, direction, maxDepth }, target) => {
      await target.indexer.ensureFreshIndex();
      const details = direction === "incoming"
        ? await target.indexer.getCallers(symbolName)
        : direction === "outgoing"
          ? await target.indexer.getCallees(symbolName)
          : await target.indexer.getImpactRadius(symbolName, maxDepth ?? 2);
      return JSON.stringify({
        symbolName,
        direction,
        confidence: "low",
        basis: "lexical-identifier-matching",
        ...asObject(details),
      }, null, 2);
    }),
  );

  server.registerTool(
    "code.patch",
    {
      description: "Apply a preflighted unified diff with stale-content checks, rollback snapshots, and automatic restoration if a later file write fails. Each file section must include `--- a/<path>` and `+++ b/<path>` before any `@@` hunk.",
      inputSchema: {
        workspaceId: workspaceIdSchema.optional(),
        diff: z.string().min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => audited("code.patch", args, async ({ diff }, target) => {
      const result = await target.patches.applyUnifiedDiff(diff);
      target.indexer.markStale();
      return result;
    }),
  );

  server.registerTool(
    "code.write",
    {
      description: "Create or replace the complete contents of one repository file with path safety checks and a rollback snapshot.",
      inputSchema: {
        workspaceId: workspaceIdSchema.optional(),
        path: z.string().min(1),
        content: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => audited("code.write", args, async ({ path: filePath, content }, target) => {
      const result = await target.patches.writeFile(filePath, content);
      target.indexer.markStale();
      return result;
    }),
  );

  server.registerTool(
    "code.delete",
    {
      description: "Delete one repository file with path safety checks and a rollback snapshot.",
      inputSchema: {
        workspaceId: workspaceIdSchema.optional(),
        path: z.string().min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (args) => audited("code.delete", args, async ({ path: filePath }, target) => {
      const result = await target.patches.deletePath(filePath);
      target.indexer.markStale();
      return result;
    }),
  );

  server.registerTool(
    "code.rollback",
    {
      description: "Restore files from a rollback snapshot returned by a prior code mutation. Rolling back creates a new inverse rollback snapshot.",
      inputSchema: {
        workspaceId: workspaceIdSchema.optional(),
        rollbackId: z.string().uuid(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (args) => audited("code.rollback", args, async ({ rollbackId }, target) => {
      const result = await target.patches.rollbackOperation(rollbackId);
      target.indexer.markStale();
      return result;
    }),
  );

  server.registerTool(
    "git.status",
    {
      description: "Return Git branch plus staged, unstaged, mixed, and untracked paths.",
      inputSchema: { workspaceId: workspaceIdSchema.optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => audited("git.status", args, async (_payload, target) => JSON.stringify(await target.git.status(), null, 2)),
  );

  server.registerTool(
    "git.diff",
    {
      description: "Return a Git diff or changed-path summary, optionally scoped by base ref, paths, exclusions, or staged state.",
      inputSchema: {
        workspaceId: workspaceIdSchema.optional(),
        base: gitArgumentSchema.optional(),
        paths: z.array(z.string().min(1)).max(100).optional(),
        summaryOnly: z.boolean().optional(),
        exclude: z.array(z.string().min(1)).max(100).optional(),
        stagedOnly: z.boolean().optional(),
        maxChars: z.number().int().positive().max(200_000).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => audited("git.diff", args, ({ base, paths, summaryOnly, exclude, stagedOnly, maxChars }, target) =>
      target.git.diff(base, paths, summaryOnly, exclude, stagedOnly, maxChars ?? 50_000)),
  );

  server.registerTool(
    "git.commit",
    {
      description: "Create a Git commit. Optional paths are staged explicitly before the commit; otherwise the existing index is committed.",
      inputSchema: {
        workspaceId: workspaceIdSchema.optional(),
        message: z.string().min(1),
        paths: z.array(z.string().min(1)).min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => audited("git.commit", args, ({ message, paths }, target) => paths ? target.git.commitPaths(paths, message) : target.git.commit(message)),
  );

  server.registerTool(
    "git.push",
    {
      description: "Push the repository to a configured Git remote and optional branch.",
      inputSchema: {
        workspaceId: workspaceIdSchema.optional(),
        remote: gitArgumentSchema.optional(),
        branch: gitArgumentSchema.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => audited("git.push", args, ({ remote, branch }, target) => target.git.push(remote ?? "origin", branch)),
  );

  server.registerTool(
    "validation.run",
    {
      description: "Run one or more configured validation commands and return structured results.",
      inputSchema: {
        workspaceId: workspaceIdSchema.optional(),
        commandIds: z.array(z.enum(COMMAND_IDS)).min(1).max(COMMAND_IDS.length).refine((ids) => new Set(ids).size === ids.length, {
          message: "commandIds must not contain duplicates",
        }),
        args: z.array(validationArgumentSchema).max(20).optional().describe(
          "Extra safe arguments for one selected validation command, e.g. a test file or --include=path. Only valid when commandIds contains one id.",
        ),
        stopOnFailure: z.boolean().optional(),
        failuresOnly: z.boolean().optional(),
        maxOutputChars: z.number().int().positive().max(50_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => audited("validation.run", args, async ({ commandIds, args: commandArgs, stopOnFailure, failuresOnly, maxOutputChars }, target) => {
      if (commandArgs?.length && commandIds.length !== 1) {
        throw new Error("validation.run args are only valid when exactly one commandId is selected");
      }
      const result = await target.patches.runValidationSuite(commandIds, stopOnFailure ?? false, {
        failuresOnly: failuresOnly ?? true,
        maxOutputChars: maxOutputChars ?? 20_000,
      }, commandArgs ?? []);
      target.indexer.markStale();
      return result;
    }),
  );

  server.registerTool(
    "command.run",
    {
      description: "Run an opt-in shell command from the repository root and return structured status, exit code, timing, timeout, and output. Disabled unless BRIDGE_ENABLE_COMMAND_RUN=true; classified as high risk.",
      inputSchema: {
        workspaceId: workspaceIdSchema.optional(),
        command: z.string().min(1).max(20_000),
        timeoutMs: z.number().int().positive().max(120_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => audited("command.run", args, async ({ command, timeoutMs }, target) => {
      if (process.env.BRIDGE_ENABLE_COMMAND_RUN !== "true") {
        throw new Error("command.run is disabled by server configuration.");
      }
      try {
        return await target.patches.runArbitraryCommand(command, timeoutMs);
      } finally {
        target.indexer.markStale();
      }
    }),
  );

  return server;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await mapper(items[index], index);
      }
    },
  );

  const settled = await Promise.allSettled(workers);
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
  return results;
}

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function toolError(content: string) {
  return { content: [{ type: "text" as const, text: content }], isError: true };
}

function parseJsonOrText(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asObject(value: string): Record<string, unknown> {
  const parsed = parseJsonOrText(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : { value: parsed };
}

function compactSearchResult(value: string): Record<string, unknown> {
  const parsed = asObject(value);
  const matches = Array.isArray(parsed.matches) ? parsed.matches.map(compactSearchMatch) : [];
  return {
    query: parsed.query,
    truncated: parsed.truncated ?? false,
    ...((parsed.skipped && Object.values(parsed.skipped as Record<string, unknown>).some((count) => Number(count) > 0))
      ? { skipped: parsed.skipped }
      : {}),
    matches,
  };
}

function compactSearchMatch(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const match = value as Record<string, unknown>;
  const rawText = typeof match.text === "string" ? match.text : "";
  const context = match.context && typeof match.context === "object" && !Array.isArray(match.context)
    ? match.context as Record<string, unknown>
    : undefined;
  const compactContext = context ? {
    before: compactContextLines(context.before),
    after: compactContextLines(context.after),
  } : undefined;
  return {
    path: match.path,
    line: match.line,
    column: match.column,
    text: truncateSearchLine(rawText),
    ...(rawText.length > MAX_SEARCH_LINE_CHARS ? { textTruncated: true } : {}),
    ...(compactContext ? { context: compactContext } : {}),
  };
}

function compactContextLines(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((line) => {
    if (!line || typeof line !== "object" || Array.isArray(line)) return line;
    const item = line as Record<string, unknown>;
    const rawText = typeof item.text === "string" ? item.text : "";
    return {
      line: item.line,
      text: truncateSearchLine(rawText),
      ...(rawText.length > MAX_SEARCH_LINE_CHARS ? { textTruncated: true } : {}),
    };
  });
}

function truncateSearchLine(value: string): string {
  if (value.length <= MAX_SEARCH_LINE_CHARS) return value;
  return `${value.slice(0, MAX_SEARCH_LINE_CHARS)}…`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
