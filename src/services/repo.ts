import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Minimatch } from "minimatch";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_EXCLUDE_GLOBS, MAX_FILE_BYTES, MAX_SEARCH_RESULTS } from "../config/allowlist.js";
import { SecurityService } from "./security.js";
import { resolveRipgrepPath } from "./ripgrep.js";

const execFileAsync = promisify(execFile);
const RG_SEARCH_TIMEOUT_MS = Number(process.env.BRIDGE_RG_SEARCH_TIMEOUT_MS ?? (process.platform === "win32" ? 750 : 250));
const RG_TIMEOUT_COOLDOWN_MS = Number(process.env.BRIDGE_RG_TIMEOUT_COOLDOWN_MS ?? 5_000);
// Timed backoff after rg fails (timeout or ENOENT). Not a permanent latch: a
// transient failure or a fixed environment recovers after the cooldown.
let ripgrepRetryAfterMs = 0;

type GlobOptions = { onlyFiles: boolean; ignore: string[]; deep?: number };

// Replaces fast-glob, whose micromatch -> braces chain carries an unpatched advisory.
// Node's fs.glob is not a substitute: it has no `dot` option and follows junctions.
// Symbolic links are never followed, so discovery cannot leave the repository.
async function globRepo(root: string, patterns: string[], options: GlobOptions): Promise<string[]> {
  const mm = (pattern: string) => new Minimatch(pattern, { dot: true });
  const include = patterns.map(mm);
  const ignore = options.ignore.map(mm);
  // micromatch treats "dir/**" as matching "dir" itself; minimatch does not, so
  // directories are also pruned against each such pattern without its "/**".
  const ignoreDir = [...ignore, ...options.ignore.filter((p) => p.endsWith("/**")).map((p) => mm(p.slice(0, -3)))];
  const results: string[] = [];
  const walk = async (dirRel: string, depth: number): Promise<void> => {
    for (const entry of await fs.readdir(path.join(root, dirRel), { withFileTypes: true })) {
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (ignoreDir.some((m) => m.match(rel))) continue;
        if (!options.onlyFiles && include.some((m) => m.match(rel))) results.push(rel);
        // depth counts path segments, matching fast-glob's `deep`
        if ((options.deep === undefined || depth < options.deep) && include.some((m) => m.match(rel, true))) {
          await walk(rel, depth + 1);
        }
      } else if (entry.isFile() && !ignore.some((m) => m.match(rel)) && include.some((m) => m.match(rel))) {
        results.push(rel);
      }
    }
  };
  await walk("", 1);
  return results;
}

type StructuredSearchContextLine = {
  line: number;
  text: string;
};

type StructuredSearchMatch = {
  path: string;
  line: number;
  column: number;
  text: string;
  context?: {
    before: StructuredSearchContextLine[];
    after: StructuredSearchContextLine[];
  };
};

type StructuredSearchProfile = {
  globMs: number;
  statMs: number;
  readMs: number;
  binaryCheckMs: number;
  secretScanMs: number;
  splitMs: number;
  matchMs: number;
  contextMs: number;
};

type StructuredSearchResult = {
  query: string;
  glob?: string;
  contextLines: number;
  backend: "rg" | "native";
  durationMs: number;
  profile?: StructuredSearchProfile;
  truncated: boolean;
  skipped: {
    binaryLike: number;
    assetLike: number;
    secretBearing: number;
  };
  matches: StructuredSearchMatch[];
};

type SearchOptions = {
  caseInsensitive?: boolean;
  isRegex?: boolean;
  textOnly?: boolean;
  includeAssets?: boolean;
  matchPerLine?: boolean;
};

type MatchContextResult = StructuredSearchResult & {
  fileMetadata: Record<string, {
    imports: string[];
    exports: string[];
  }>;
};

const ASSET_GLOBS = [
  "**/public/assets/**",
  "public/assets/**",
  "**/assets/**",
];

const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".config", ".cpp", ".cs", ".css", ".csv", ".go", ".graphql", ".h", ".html",
  ".java", ".js", ".json", ".jsx", ".kt", ".less", ".mjs", ".md", ".mdx", ".php", ".ps1",
  ".py", ".rs", ".scss", ".sh", ".sql", ".svelte", ".swift", ".toml", ".ts", ".tsx", ".txt",
  ".vue", ".xml", ".yaml", ".yml",
]);

async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class RepoService {
  constructor(
    private readonly repoRoot: string,
    private readonly security: SecurityService
  ) {}

  private async getGitignoreRules(): Promise<string[]> {
    try {
      const gitignorePath = path.join(this.repoRoot, ".gitignore");
      const content = await fs.readFile(gitignorePath, "utf8");
      const rules: string[] = [];
      for (let line of content.split(/\r?\n/)) {
        line = line.trim();
        if (!line || line.startsWith("#")) continue;
        let pattern = line;
        if (pattern.startsWith("/")) {
          pattern = pattern.slice(1);
        }
        if (pattern.endsWith("/")) {
          rules.push(`**/${pattern}**`, `${pattern}**`);
        } else {
          rules.push(`**/${pattern}`, `**/${pattern}/**`, pattern, `${pattern}/**`);
        }
      }
      return rules;
    } catch {
      return [];
    }
  }

  private async getExcludeGlobs(): Promise<string[]> {
    const gitignoreRules = await this.getGitignoreRules();
    return [
      ...DEFAULT_EXCLUDE_GLOBS,
      "**/.ai-bridge/**",
      ".ai-bridge/**",
      ...gitignoreRules
    ];
  }

  async readFile(inputPath: string, startLine?: number, endLine?: number): Promise<string> {
    const absPath = this.security.resolveRepoPath(inputPath);
    const stat = await fs.stat(absPath);
    const rel = this.security.toRepoRelative(absPath);
    this.security.assertReadable(rel, stat.size);
    const text = await fs.readFile(absPath, "utf8");
    const findings = this.security.scanForSecrets(text);
    if (findings.length > 0) {
      throw new Error(`Secret-like content detected in ${rel}: ${findings.join(", ")}`);
    }

    if (startLine === undefined && endLine === undefined) {
      return text;
    }
    const lines = text.split(/\r?\n/);
    if (text.endsWith("\n")) {
      lines.pop();
    }
    const start = Math.max((startLine ?? 1) - 1, 0);
    const end = Math.min(endLine ?? lines.length, lines.length);
    return lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join("\n");
  }

  async readFileRedacted(inputPath: string, startLine?: number, endLine?: number): Promise<string> {
    const absPath = this.security.resolveRepoPath(inputPath);
    const stat = await fs.stat(absPath);
    const rel = this.security.toRepoRelative(absPath);
    this.security.assertReadable(rel, stat.size);
    const text = this.security.redactSecrets(await fs.readFile(absPath, "utf8"));

    if (startLine === undefined && endLine === undefined) {
      return text;
    }

    const lines = text.split(/\r?\n/);
    if (text.endsWith("\n")) {
      lines.pop();
    }
    const start = Math.max((startLine ?? 1) - 1, 0);
    const end = Math.min(endLine ?? lines.length, lines.length);
    return lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join("\n");
  }

  async readFilesBatch(files: Array<{ path: string; startLine?: number; endLine?: number }>): Promise<string> {
    const results = await Promise.allSettled(files.map((file) =>
      withTimeout(async () => {
        const content = await this.readFile(file.path, file.startLine, file.endLine);
        return {
          path: file.path,
          startLine: file.startLine,
          endLine: file.endLine,
          status: "ok",
          sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
          content,
        };
      }, 10_000)
    ));

    return JSON.stringify({
      files: results.map((result, index) => result.status === "fulfilled"
        ? result.value
        : {
          path: files[index]?.path,
          status: "error",
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        })
    }, null, 2);
  }

  async searchBatch(queries: Array<{ query: string; glob?: string; contextLines?: number; textOnly?: boolean; includeAssets?: boolean }>): Promise<string> {
    const results = await Promise.allSettled(queries.map((item) =>
      withTimeout(async () => ({
        query: item.query,
        glob: item.glob,
        contextLines: item.contextLines,
        status: "ok",
        results: item.contextLines === undefined
          ? await this.search(item.query, item.glob, undefined, undefined, {
            textOnly: item.textOnly,
            includeAssets: item.includeAssets,
            matchPerLine: true,
          })
          : await this.searchStructured(item.query, item.glob, item.contextLines, undefined, undefined, {
            textOnly: item.textOnly,
            includeAssets: item.includeAssets,
          }),
      }), 15_000)
    ));

    return JSON.stringify({
      queries: results.map((result, index) => result.status === "fulfilled"
        ? result.value
        : {
          query: queries[index]?.query,
          glob: queries[index]?.glob,
          contextLines: queries[index]?.contextLines,
          status: "error",
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        })
    }, null, 2);
  }

  async tree(depth = 3, exclude?: string[]): Promise<string> {
    const excludes = await this.getExcludeGlobs();
    const allExcludes = exclude ? [...excludes, ...exclude] : excludes;
    const files = await globRepo(this.repoRoot, ["**/*"], { onlyFiles: false, deep: depth, ignore: allExcludes });
    return files.sort().join("\n");
  }

  async findFiles(pattern = "**/*", maxResults = 100, offset = 0): Promise<string> {
    if (path.isAbsolute(pattern) || /^[A-Za-z]:/.test(pattern) || pattern.replaceAll("\\", "/").split("/").includes("..")) {
      throw new Error("File pattern must stay within the repository root");
    }
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 200 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("File discovery requires a limit of 1-200 and a non-negative integer offset");
    }
    const excludes = await this.getExcludeGlobs();
    const files = await globRepo(this.repoRoot, [pattern], { onlyFiles: true, ignore: excludes });

    const fileSlice = files.sort().slice(offset, offset + maxResults);
    const results = await mapWithConcurrency(
      fileSlice, 8, async (file) => {
        const rel = file.replaceAll("\\", "/");
        try {
          const abs = this.security.resolveRepoPath(rel);
          const stat = await fs.stat(abs);
          this.security.assertReadable(rel, stat.size);
          return { path: rel, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
        } catch (error) {
          return { path: rel, error: error instanceof Error ? error.message : String(error) };
        }
      }
    );

    return JSON.stringify({
      pattern,
      count: results.length,
      offset,
      nextOffset: offset + results.length < files.length ? offset + results.length : null,
      truncated: offset + results.length < files.length,
      files: results,
    }, null, 2);
  }

  async search(query: string, glob?: string, caseInsensitive?: boolean, isRegex?: boolean, options: SearchOptions = {}): Promise<string> {
    const structured = await this.searchStructuredObject(query, glob, 0, {
      ...options,
      caseInsensitive,
      isRegex,
    });
    if (structured.matches.length === 0) {
      return "(no matches)";
    }
    if (options.matchPerLine) {
      return structured.matches.map((match) => `${match.path}:${match.line}:${match.text}`).join("\n");
    } else {
      const uniquePaths = [...new Set(structured.matches.map((match) => match.path))];
      return uniquePaths.join("\n");
    }
  }

  async searchStructured(query: string, glob?: string, contextLines = 0, caseInsensitive?: boolean, isRegex?: boolean, options: SearchOptions = {}, maxMatches?: number): Promise<string> {
    const structured = await this.searchStructuredObject(query, glob, contextLines, {
      ...options,
      caseInsensitive,
      isRegex,
    });
    const limit = maxMatches === undefined ? MAX_SEARCH_RESULTS : normalizeMaxMatches(maxMatches);
    const matches = structured.matches.slice(0, limit);
    return JSON.stringify({
      ...structured,
      truncated: structured.truncated || structured.matches.length > matches.length,
      matches,
    }, null, 2);
  }

  async getMatchContext(
    query: string,
    glob?: string,
    contextLines = 8,
    maxMatches = 20,
    options: SearchOptions = {}
  ): Promise<string> {
    const structured = await this.searchStructuredObject(query, glob, contextLines, options);
    const matches = structured.matches.slice(0, normalizeMaxMatches(maxMatches));
    const fileMetadata: MatchContextResult["fileMetadata"] = {};

    const uniqueFilePaths = [...new Set(matches.map((match) => match.path))];
    const metadataResults = await Promise.all(
      uniqueFilePaths.map(async (filePath) => {
        const meta = await this.getFileMetadata(filePath);
        return { filePath, meta };
      })
    );
    for (const { filePath, meta } of metadataResults) {
      fileMetadata[filePath] = meta;
    }

    return JSON.stringify({
      ...structured,
      truncated: structured.truncated || structured.matches.length > matches.length,
      matches,
      fileMetadata,
    } satisfies MatchContextResult, null, 2);
  }

  async readIndexableFile(inputPath: string): Promise<string | undefined> {
    const abs = this.security.resolveRepoPath(inputPath);
    const stat = await fs.stat(abs);
    const rel = this.security.toRepoRelative(abs);
    this.security.assertReadable(rel, stat.size);
    const text = await fs.readFile(abs, "utf8");
    return this.security.scanForSecrets(text, rel).length > 0 ? undefined : text;
  }

  async indexableFiles(): Promise<string[]> {
    const excludes = await this.getExcludeGlobs();
    const files = await globRepo(this.repoRoot, ["**/*"], { onlyFiles: true, ignore: excludes });

    const indexableCandidates = files.filter(file => this.security.isIndexable(file));
    const stats = await mapWithConcurrency(
      indexableCandidates,
      16,
      async (file) => {
        try {
          const stat = await fs.stat(path.join(this.repoRoot, file));
          return { file, size: stat.size };
        } catch {
          return { file, size: Infinity };
        }
      }
    );

    const result: string[] = [];
    for (const entry of stats) {
      if (entry.size <= MAX_FILE_BYTES) {
        result.push(entry.file.replaceAll("\\", "/"));
      }
    }
    return result;
  }

  private async searchStructuredObject(
    query: string,
    glob?: string,
    contextLines = 0,
    options: SearchOptions = {}
  ): Promise<StructuredSearchResult> {
    const started = Date.now();
    const normalizedContextLines = normalizeContextLines(contextLines);
    const rgResult = await this.searchWithRipgrepStructured(query, glob, options);
    const result = rgResult ?? await this.searchNativelyStructured(query, glob, options);
    const contextStarted = performance.now();
    const withContext = normalizedContextLines > 0
      ? await this.attachContext(result.matches, normalizedContextLines)
      : result.matches;
    const contextMs = performance.now() - contextStarted;
    return {
      ...result,
      contextLines: normalizedContextLines,
      matches: withContext,
      durationMs: Date.now() - started,
      profile: result.profile ? {
        ...result.profile,
        contextMs: Math.round(contextMs * 10) / 10,
      } : undefined,
    };
  }

  private async searchWithRipgrepStructured(
    query: string,
    glob?: string,
    options: SearchOptions = {}
  ): Promise<Omit<StructuredSearchResult, "durationMs" | "contextLines"> | undefined> {
    if (Date.now() < ripgrepRetryAfterMs) return undefined;

    const args = ["--line-number", "--column", "--hidden", "--max-filesize", String(MAX_FILE_BYTES)];
    const excludes = await this.getExcludeGlobs();
    for (const excluded of excludes) {
      args.push("--glob", `!${excluded}`);
    }
    if (options.includeAssets === false) {
      for (const assetGlob of ASSET_GLOBS) {
        args.push("--glob", `!${assetGlob}`);
      }
    }
    if (options.textOnly === false) {
      args.push("--text");
    }
    if (options.caseInsensitive) {
      args.push("--ignore-case");
    }
    if (!options.isRegex) {
      args.push("--fixed-strings");
    }
    if (glob) {
      args.push("--glob", glob);
    }
    // `--` stops flag parsing (so a query starting with `-` is treated as the
    // pattern), and the explicit `.` path makes rg search the repo (via cwd).
    // Without a path argument rg reads from stdin, and under execFile stdin is a
    // pipe that never closes — so rg would block until the timeout and fall back
    // to native on every call.
    args.push("--", query, ".");
    try {
      const { stdout } = await execFileAsync(resolveRipgrepPath(), args, {
        cwd: this.repoRoot,
        maxBuffer: 2_000_000,
        timeout: RG_SEARCH_TIMEOUT_MS,
        windowsHide: true,
      });
      const rawMatches = parseRipgrepOutput(stdout);
      const filtered = await this.filterSecretBearingMatches(rawMatches);
      return {
        query,
        glob,
        backend: "rg",
        truncated: rawMatches.length > MAX_SEARCH_RESULTS,
        skipped: { binaryLike: 0, assetLike: 0, secretBearing: filtered.secretBearing },
        matches: filtered.matches.slice(0, MAX_SEARCH_RESULTS),
      };
    } catch (error: unknown) {
      const maybe = error as { code?: number | string; stdout?: string; signal?: string; message?: string };
      if (maybe.code === 1) {
        return { query, glob, backend: "rg", truncated: false, skipped: { binaryLike: 0, assetLike: 0, secretBearing: 0 }, matches: [] };
      }
      if (maybe.stdout) {
        const rawMatches = parseRipgrepOutput(maybe.stdout);
        const filtered = await this.filterSecretBearingMatches(rawMatches);
        return {
          query,
          glob,
          backend: "rg",
          truncated: true,
          skipped: { binaryLike: 0, assetLike: 0, secretBearing: filtered.secretBearing },
          matches: filtered.matches.slice(0, MAX_SEARCH_RESULTS),
        };
      }
      if (
        maybe.code === "ENOENT" ||
        maybe.signal === "SIGTERM" ||
        /timed out/i.test(maybe.message ?? "")
      ) {
        // rg is unavailable or too slow right now — back off and use the native
        // backend until the cooldown elapses, then probe rg again.
        ripgrepRetryAfterMs = Date.now() + RG_TIMEOUT_COOLDOWN_MS;
      }
      return undefined;
    }
  }

  private async filterSecretBearingMatches(matches: StructuredSearchMatch[]): Promise<{ matches: StructuredSearchMatch[]; secretBearing: number }> {
    const paths = [...new Set(matches.map((match) => match.path))];
    const checks = await mapWithConcurrency(paths, 8, async (filePath) => {
      try {
        const text = await fs.readFile(this.security.resolveRepoPath(filePath), "utf8");
        return { filePath, secretBearing: this.security.scanForSecrets(text).length > 0 };
      } catch {
        return { filePath, secretBearing: true };
      }
    });
    const blocked = new Set(checks.filter((check) => check.secretBearing).map((check) => check.filePath));
    return {
      matches: matches.filter((match) => !blocked.has(match.path)),
      secretBearing: blocked.size,
    };
  }

  private async searchNativelyStructured(
    query: string,
    glob?: string,
    options: SearchOptions = {}
  ): Promise<Omit<StructuredSearchResult, "durationMs" | "contextLines">> {
    const profile = { globMs: 0, statMs: 0, readMs: 0, binaryCheckMs: 0, secretScanMs: 0, splitMs: 0, matchMs: 0, contextMs: 0 };
    const excludes = await this.getExcludeGlobs();
    const globStart = performance.now();
    const files = await globRepo(this.repoRoot, glob ? [glob] : ["**/*"], { onlyFiles: true, ignore: excludes });
    profile.globMs = performance.now() - globStart;
    const matches: StructuredSearchMatch[] = [];
    let truncated = false;
    const skipped = { binaryLike: 0, assetLike: 0, secretBearing: 0 };

    let regex: RegExp | undefined;
    if (options.isRegex) {
      try {
        regex = new RegExp(query, options.caseInsensitive ? "i" : "");
      } catch (err) {
        throw new Error(`Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const file of files.sort()) {
      if (matches.length >= MAX_SEARCH_RESULTS) {
        truncated = true;
        break;
      }
      const rel = file.replaceAll("\\", "/");
      if (options.includeAssets === false && isAssetLikePath(rel)) {
        skipped.assetLike += 1;
        continue;
      }
      if (options.textOnly && !isLikelyTextPath(rel)) {
        skipped.binaryLike += 1;
        continue;
      }
      try {
        const abs = this.security.resolveRepoPath(rel);
        let p = performance.now();
        const stat = await fs.stat(abs);
        profile.statMs += performance.now() - p;
        this.security.assertReadable(rel, stat.size);
        p = performance.now();
        const text = await fs.readFile(abs, "utf8");
        profile.readMs += performance.now() - p;
        p = performance.now();
        if (options.textOnly && isLikelyBinaryText(text)) {
          profile.binaryCheckMs += performance.now() - p;
          skipped.binaryLike += 1;
          continue;
        }
        profile.binaryCheckMs += performance.now() - p;
        p = performance.now();
        const findings = this.security.scanForSecrets(text);
        profile.secretScanMs += performance.now() - p;
        if (findings.length > 0) {
          skipped.secretBearing += 1;
          continue;
        }
        p = performance.now();
        const lines = text.split(/\r?\n/);
        profile.splitMs += performance.now() - p;
        p = performance.now();
        for (let index = 0; index < lines.length; index += 1) {
          const lineText = lines[index];
          let column = -1;
          if (regex) {
            const match = regex.exec(lineText);
            if (match) {
              column = match.index;
            }
          } else if (options.caseInsensitive) {
            column = lineText.toLowerCase().indexOf(query.toLowerCase());
          } else {
            column = lineText.indexOf(query);
          }

          if (column !== -1) {
            if (matches.length >= MAX_SEARCH_RESULTS) {
              truncated = true;
              break;
            }
            matches.push({ path: rel, line: index + 1, column: column + 1, text: lineText });
          }
        }
        profile.matchMs += performance.now() - p;
      } catch {
        continue;
      }
    }

    return { query, glob, backend: "native", truncated, skipped, matches, profile };
  }

  private async attachContext(matches: StructuredSearchMatch[], contextLines: number): Promise<StructuredSearchMatch[]> {
    const cache = new Map<string, string[]>();
    const result: StructuredSearchMatch[] = [];

    const uniquePaths = [...new Set(matches.map((m) => m.path))];
    const fileContents = await mapWithConcurrency(uniquePaths, 16, async (filePath) => {
      try {
        const abs = this.security.resolveRepoPath(filePath);
        const stat = await fs.stat(abs);
        this.security.assertReadable(filePath, stat.size);
        const text = await fs.readFile(abs, "utf8");
        if (this.security.scanForSecrets(text).length > 0) {
          return { filePath, lines: null };
        }
        return { filePath, lines: text.split(/\r?\n/) };
      } catch {
        return { filePath, lines: null };
      }
    });
    for (const item of fileContents) {
      if (item.lines) {
        cache.set(item.filePath, item.lines);
      }
    }
    for (const match of matches) {
      const lines = cache.get(match.path);
      if (!lines) {
        result.push(match);
        continue;
      }
      const zeroBasedLine = match.line - 1;
      result.push({
        ...match,
        context: {
          before: sliceContext(lines, Math.max(0, zeroBasedLine - contextLines), zeroBasedLine),
          after: sliceContext(lines, zeroBasedLine + 1, Math.min(lines.length, zeroBasedLine + 1 + contextLines)),
        },
      });
    }
    return result;
  }

  private async getFileMetadata(filePath: string): Promise<{ imports: string[]; exports: string[] }> {
    try {
      const abs = this.security.resolveRepoPath(filePath);
      const stat = await fs.stat(abs);
      this.security.assertReadable(filePath, stat.size);
      const text = await fs.readFile(abs, "utf8");
      if (this.security.scanForSecrets(text).length > 0) {
        return { imports: [], exports: [] };
      }
      const lines = text.split(/\r?\n/);
      return {
        imports: lines.filter((line) => IMPORT_REGEX.test(line)).slice(0, 40),
        exports: lines.filter((line) => EXPORT_REGEX.test(line)).slice(0, 40),
      };
    } catch {
      return { imports: [], exports: [] };
    }
  }
}

// Hoisted Regular Expressions for Performance
const IMPORT_REGEX = /^\s*import\b/;
const EXPORT_REGEX = /^\s*export\b/;
const RIPGREP_LINE_REGEX = /^(.*?):(\d+):(\d+):(.*)$/;

function parseRipgrepOutput(stdout: string): StructuredSearchMatch[] {
  return stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const match = RIPGREP_LINE_REGEX.exec(line);
    if (!match) return [];
    return [{
      // rg is invoked with an explicit "." search path, so it prefixes every
      // match with "./" (or ".\\" on Windows). Strip it so paths are repo-root
      // relative and match the native backend's output.
      path: match[1].replaceAll("\\", "/").replace(/^\.\//, ""),
      line: Number(match[2]),
      column: Number(match[3]),
      text: match[4],
    }];
  });
}

function normalizeContextLines(contextLines: number): number {
  if (!Number.isFinite(contextLines)) return 0;
  return Math.max(0, Math.min(20, Math.floor(contextLines)));
}

function normalizeMaxMatches(maxMatches: number): number {
  if (!Number.isFinite(maxMatches)) return 20;
  return Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(maxMatches)));
}

function sliceContext(lines: string[], start: number, end: number): StructuredSearchContextLine[] {
  return lines.slice(start, end).map((line, index) => ({ line: start + index + 1, text: line }));
}

function isAssetLikePath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  return normalized.includes("/assets/") || normalized.startsWith("assets/") || normalized.startsWith("public/assets/");
}

function isLikelyTextPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

function isLikelyBinaryText(text: string): boolean {
  return text.includes("\u0000");
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), Math.max(1, items.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
