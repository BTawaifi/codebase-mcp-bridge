import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { COMMANDS, type CommandId } from "../config/commands.js";
import { resolveValidationCommands } from "../config/workspace-manifest.js";
import { SecurityService } from "./security.js";

const execAsync = promisify(exec);

type CommandOutputOptions = {
  summaryOnly?: boolean;
  failuresOnly?: boolean;
  maxOutputChars?: number;
};

type FileSnapshot = {
  path: string;
  sha256: string;
};

type CommandExecutionResult = {
  command: string;
  label: string;
  status: "passed" | "failed";
  exitCode: number | string | null;
  durationMs: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  output: string;
  error?: string;
};

type RollbackFile = {
  path: string;
  existed: boolean;
  content: string;
};

export class PatchService {
  constructor(
    private readonly repoRoot: string,
    private readonly security: SecurityService
  ) {}

  async writeFile(inputPath: string, content: string): Promise<string> {
    this.validateWrite(inputPath, content);
    const abs = this.security.resolveRepoPath(inputPath);
    const relative = this.security.toRepoRelative(abs);
    const existing = await this.readExistingFileForRollback(abs);
    const rollbackId = await this.createRollbackSnapshot([{ path: relative, ...existing }]);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return `Wrote ${relative}. Rollback: ${rollbackId}`;
  }

  async applyUnifiedDiff(diff: string): Promise<string> {
    const parsed = parseSimpleUnifiedDiff(diff);
    assertUniquePatchPaths(parsed);
    const snapshots = await this.snapshotUnifiedDiffFiles(parsed);
    return this.applyUnifiedDiffNow(diff, snapshots);
  }

  async deletePath(inputPath: string): Promise<string> {
    const abs = this.security.resolveRepoPath(inputPath);
    const relative = this.security.toRepoRelative(abs);
    this.security.assertSafeMutationPath(relative);
    let stats;
    try {
      stats = await fs.stat(abs);
    } catch {
      throw new Error(`Cannot delete missing path: ${relative}`);
    }
    if (stats.isDirectory()) throw new Error(`Refusing to delete a directory (not a file): ${relative}`);
    const existing = await fs.readFile(abs, "utf8");
    const rollbackId = await this.createRollbackSnapshot([{ path: relative, existed: true, content: existing }]);
    await fs.rm(abs, { force: true, recursive: false });
    return `Deleted ${relative}. Rollback: ${rollbackId}`;
  }

  async runArbitraryCommand(command: string, timeoutMs?: number): Promise<string> {
    const result = await this.executeCommandStructured(command, timeoutMs ?? 120_000, "raw-command");
    return JSON.stringify({
      status: result.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      output: result.output,
      error: result.error ?? null,
    }, null, 2);
  }

  async rollbackOperation(rollbackId: string): Promise<string> {
    this.security.assertValidId(rollbackId, "rollback");
    const rollbackPath = path.join(this.repoRoot, ".ai-bridge", "rollback", `${rollbackId}.json`);
    const stored = JSON.parse(await fs.readFile(rollbackPath, "utf8")) as {
      files: Array<Partial<RollbackFile> & { path: string; content?: string }>;
    };
    const files: RollbackFile[] = stored.files.map((file) => ({
      path: file.path,
      existed: file.existed ?? true,
      content: file.content ?? "",
    }));

    const inverse: RollbackFile[] = [];
    for (const file of files) {
      const abs = this.security.resolveRepoPath(file.path);
      this.security.assertSafeMutationPath(this.security.toRepoRelative(abs));
      inverse.push({ path: file.path, ...(await this.readExistingFileForRollback(abs)) });
      if (file.existed) this.validateWrite(file.path, file.content);
    }
    const inverseRollbackId = await this.createRollbackSnapshot(inverse);

    for (const file of files) {
      const abs = this.security.resolveRepoPath(file.path);
      if (file.existed) {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, file.content, "utf8");
      } else {
        await fs.rm(abs, { force: true, recursive: false });
      }
    }
    return `Rolled back ${rollbackId}. Rollback: ${inverseRollbackId}`;
  }

  private formatCommandOutput(result: CommandExecutionResult, options: CommandOutputOptions): string {
    const raw = result.output || result.error || "";
    const lines = raw.split(/\r?\n/);
    let output = raw;

    if (options.summaryOnly) {
      output = JSON.stringify({
        command: result.command,
        status: result.status,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        outputLines: lines.length,
      }, null, 2);
    } else if (options.failuresOnly) {
      const interesting = lines.filter((line) =>
        /^not ok\b/i.test(line) ||
        /\b(error|failed|failure|ERR_|AssertionError|TypeError|SyntaxError)\b/i.test(line) ||
        /^#\s+(tests|pass|fail|cancelled|skipped|todo|duration_ms)\b/i.test(line)
      );
      output = interesting.length > 0 ? interesting.join("\n") : result.status === "failed" ? raw : "";
    }

    if (options.maxOutputChars && options.maxOutputChars > 0 && output.length > options.maxOutputChars) {
      output = `${output.slice(0, options.maxOutputChars)}\n... truncated ${output.length - options.maxOutputChars} chars ...`;
    }
    return output;
  }

  private async runCommandStructured(commandId: string, args: readonly string[] = []): Promise<CommandExecutionResult> {
    const resolved = resolveValidationCommands(this.repoRoot);
    const command: string | undefined = resolved.commands[commandId as CommandId];
    if (!command) throw new Error(`Unknown commandId. Allowed: ${Object.keys(COMMANDS).join(", ")}`);

    const unavailable = resolved.unavailableCommands?.find((entry) => entry.id === commandId);
    if (unavailable) {
      throw new Error(`Validation command "${commandId}" is unavailable: ${unavailable.reason}`);
    }
    return this.executeCommandStructured(appendValidationArgs(command, args), 120_000, `allowlisted-command:${commandId}`);
  }

  async runValidationSuite(
    commandIds: string[],
    stopOnFailure = false,
    options: CommandOutputOptions = {},
    args: readonly string[] = [],
  ): Promise<string> {
    if (args.length > 0 && commandIds.length !== 1) {
      throw new Error("Validation arguments require exactly one command id");
    }
    assertSafeValidationArgs(args);
    const results: Array<Record<string, unknown>> = [];
    let passed = 0;
    let failed = 0;

    for (const commandId of commandIds) {
      let result: CommandExecutionResult;
      try {
        result = await this.runCommandStructured(commandId, args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = {
          command: "",
          label: `allowlisted-command:${commandId}`,
          status: "failed",
          exitCode: null,
          durationMs: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          output: message,
          error: message,
        };
      }
      const formattedOutput = this.formatCommandOutput(result, options);
      results.push({
        commandId,
        status: result.status,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        exitCode: result.exitCode,
        ...(formattedOutput ? { output: formattedOutput } : {}),
      });

      if (result.status === "passed") {
        passed += 1;
      } else {
        failed += 1;
        if (stopOnFailure) break;
      }
    }

    const total = passed + failed;

    return JSON.stringify({
      summary: { total, passed, failed },
      results,
    }, null, 2);
  }

  private async executeCommandStructured(command: string, timeoutMs: number, label: string): Promise<CommandExecutionResult> {
    if (!command.trim()) throw new Error("Command is required");

    const started = Date.now();

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.repoRoot,
        timeout: timeoutMs,
        maxBuffer: 5_000_000,
        windowsHide: true,
      });
      const output = truncateOutput([stdout, stderr].filter(Boolean).join("\n"));

      return {
        command,
        label,
        status: "passed",
        exitCode: 0,
        durationMs: Date.now() - started,
        timedOut: false,
        stdout: truncateOutput(stdout || ""),
        stderr: truncateOutput(stderr || ""),
        output: output || "(command produced no output)",
      };
    } catch (error) {
      const execError = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        signal?: string;
        killed?: boolean;
      };

      const stdout = truncateOutput(execError.stdout || "");
      const stderr = truncateOutput(execError.stderr || "");
      const output = truncateOutput([stdout, stderr].filter(Boolean).join("\n"));

      return {
        command,
        label,
        status: "failed",
        exitCode: execError.code ?? null,
        durationMs: Date.now() - started,
        timedOut: execError.killed === true || execError.signal === "SIGTERM",
        stdout,
        stderr,
        output,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async applyUnifiedDiffNow(diff: string, snapshots?: FileSnapshot[]): Promise<string> {
    const parsed = parseSimpleUnifiedDiff(diff);
    await this.assertSnapshotsFresh(snapshots);
    const changed: string[] = [];

    const planned: Array<{ abs: string; relative: string; source: string; next: string; existed: boolean }> = [];
    for (const patch of parsed) {
      const abs = this.security.resolveRepoPath(patch.path);
      const relative = this.security.toRepoRelative(abs);
      const source = await this.readUnifiedDiffSource(abs, patch);
      if (!patch.isNewFile) this.security.assertReadable(relative, Buffer.byteLength(source, "utf8"));

      const hasCrlf = source.includes("\r\n");
      const normalizedSource = source.replace(/\r\n/g, "\n");
      const sourceLines = patch.isNewFile && normalizedSource === "" ? [] : normalizedSource.split("\n");
      let workingLines = [...sourceLines];
      let offset = 0;

      try {
        for (const hunk of patch.hunks) {
          const preferredIndex = Math.max(0, hunk.oldStart - 1 + offset);
          const { index: hunkIndex, mode } = findHunkApplicationIndex(workingLines, hunk, preferredIndex, relative);
          const applied = applyHunkAt(workingLines, hunk, hunkIndex, relative, mode);
          const removedCount = hunk.lines.filter((line) => line.kind !== "add").length;
          offset += applied.length - removedCount;
          workingLines = [
            ...workingLines.slice(0, hunkIndex),
            ...applied,
            ...workingLines.slice(hunkIndex + removedCount),
          ];
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("Unified diff context mismatch") || msg.includes("Unified diff hunk application ambiguous") || msg.includes("stale removal mismatch")) {
          throw new Error(`${msg}. The source no longer matches this diff; refresh the relevant code and regenerate the patch.`);
        }
        throw error;
      }

      const next = workingLines.join(hasCrlf ? "\r\n" : "\n");
      this.validateWrite(relative, next);
      planned.push({ abs, relative, source, next, existed: !patch.isNewFile });
    }

    const rollbackFiles = planned
      .filter((file) => file.source !== file.next)
      .map((file) => ({ path: file.relative, existed: file.existed, content: file.source }));
    const rollbackId = rollbackFiles.length > 0 ? await this.createRollbackSnapshot(rollbackFiles) : undefined;

    const written: typeof planned = [];
    try {
      for (const file of planned) {
        if (file.source === file.next) continue;
        await fs.mkdir(path.dirname(file.abs), { recursive: true });
        await fs.writeFile(file.abs, file.next, "utf8");
        written.push(file);
        changed.push(file.relative);
      }
    } catch (error) {
      const restoreErrors: string[] = [];
      for (const file of written.reverse()) {
        try {
          if (file.existed) await fs.writeFile(file.abs, file.source, "utf8");
          else await fs.rm(file.abs, { force: true, recursive: false });
        } catch (restoreError) {
          restoreErrors.push(`${file.relative}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
        }
      }
      const cause = error instanceof Error ? error.message : String(error);
      if (restoreErrors.length > 0) {
        throw new Error(`Unified diff write failed: ${cause}. Rollback snapshot: ${rollbackId ?? "none"}. Automatic restore also failed for: ${restoreErrors.join("; ")}`);
      }
      throw new Error(`Unified diff write failed and prior writes were restored: ${cause}${rollbackId ? `. Rollback: ${rollbackId}` : ""}`);
    }

    return `Applied unified diff to: ${changed.join(", ")}${rollbackId ? `. Rollback: ${rollbackId}` : ""}`;
  }

  private async snapshotUnifiedDiffFiles(patches: UnifiedDiffPatch[]): Promise<FileSnapshot[]> {
    const snapshots: FileSnapshot[] = [];
    for (const patch of patches) {
      if (patch.isNewFile) continue;
      const abs = this.security.resolveRepoPath(patch.path);
      const relative = this.security.toRepoRelative(abs);
      if (snapshots.some((snapshot) => snapshot.path === relative)) continue;
      const content = await fs.readFile(abs, "utf8");
      this.security.assertReadable(relative, Buffer.byteLength(content, "utf8"));
      snapshots.push({ path: relative, sha256: sha256(content) });
    }
    return snapshots;
  }

  private async readUnifiedDiffSource(abs: string, patch: UnifiedDiffPatch): Promise<string> {
    if (!patch.isNewFile) return fs.readFile(abs, "utf8");
    try {
      await fs.access(abs);
      throw new Error(`Unified diff new-file target already exists: ${patch.path}`);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  private async assertSnapshotsFresh(snapshots: FileSnapshot[] | undefined): Promise<void> {
    if (!snapshots?.length) return;
    for (const snapshot of snapshots) {
      const abs = this.security.resolveRepoPath(snapshot.path);
      const current = await fs.readFile(abs, "utf8");
      const currentSha = sha256(current);
      if (currentSha !== snapshot.sha256) {
        throw new Error(`Edit stale: ${snapshot.path} changed after the edit was prepared. Expected SHA: ${snapshot.sha256}. Current SHA: ${currentSha}.`);
      }
    }
  }

  private validateWrite(inputPath: string, content: string): void {
    const abs = this.security.resolveRepoPath(inputPath);
    this.security.assertReadable(this.security.toRepoRelative(abs), Buffer.byteLength(content, "utf8"));
    const findings = this.security.scanForSecrets(content, this.security.toRepoRelative(abs));
    if (findings.length > 0) throw new Error(`Secret-like content detected in proposed ${inputPath}: ${findings.join(", ")}`);
  }

  private async readExistingFileForRollback(abs: string): Promise<{ existed: boolean; content: string }> {
    try {
      return { existed: true, content: await fs.readFile(abs, "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { existed: false, content: "" };
      throw error;
    }
  }

  private async createRollbackSnapshot(files: RollbackFile[]): Promise<string> {
    const id = crypto.randomUUID();
    const rollbackDir = path.join(this.repoRoot, ".ai-bridge", "rollback");
    await fs.mkdir(rollbackDir, { recursive: true });
    await fs.writeFile(path.join(rollbackDir, `${id}.json`), JSON.stringify({ id, createdAt: new Date().toISOString(), files }, null, 2), "utf8");
    return id;
  }

}

function truncateOutput(output: string): string {
  const max = Number(process.env.BRIDGE_MAX_COMMAND_OUTPUT_BYTES ?? 50_000);
  if (Buffer.byteLength(output, "utf8") <= max) return output;
  return `${output.slice(0, max)}\n[truncated to ${max} bytes]`;
}

const SAFE_VALIDATION_ARG = /^[A-Za-z0-9_./:@\\=,+-]+(?:[ \t]+[A-Za-z0-9_./:@\\=,+-]+)*$/;

function assertSafeValidationArgs(args: readonly string[]): void {
  if (args.length > 20) throw new Error("Validation accepts at most 20 extra arguments");
  for (const arg of args) {
    if (!arg || arg.length > 512 || !SAFE_VALIDATION_ARG.test(arg)) {
      throw new Error(`Unsafe validation argument: ${JSON.stringify(arg)}. Use argv-like values without shell metacharacters.`);
    }
  }
}

function appendValidationArgs(command: string, args: readonly string[]): string {
  if (args.length === 0) return command;
  assertSafeValidationArgs(args);
  const trimmed = command.trim();
  const npmScript = /^npm(?:\.cmd)?\s+(?:test|t|run(?:-script)?\s+\S+)/i.test(trimmed);
  const alreadyPassesThrough = /(?:^|\s)--(?:\s|$)/.test(trimmed);
  // npm consumes flags unless script arguments follow `--`. Other configured
  // validators (npx, powershell, direct binaries) receive arguments directly.
  const separator = npmScript && !alreadyPassesThrough ? " -- " : " ";
  return `${command}${separator}${args.map(quoteValidationArg).join(" ")}`;
}

function quoteValidationArg(arg: string): string {
  if (!/[ \t]/.test(arg)) return arg;
  return `"${arg.replace(/\\+$/g, (slashes) => `${slashes}${slashes}`)}"`;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

type UnifiedDiffLine = { kind: "context" | "add" | "remove"; text: string };

type UnifiedDiffHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: UnifiedDiffLine[];
};

type UnifiedDiffPatch = {
  path: string;
  hunks: UnifiedDiffHunk[];
  isNewFile?: boolean;
};

function assertUniquePatchPaths(patches: UnifiedDiffPatch[]): void {
  const seen = new Set<string>();
  for (const patch of patches) {
    const key = patch.path.replaceAll("\\", "/").toLowerCase();
    if (seen.has(key)) throw new Error(`Unified diff contains duplicate file sections for: ${patch.path}`);
    seen.add(key);
  }
}

function parseSimpleUnifiedDiff(diff: string): UnifiedDiffPatch[] {
  const normalizedDiff = diff.replace(/\r\n/g, "\n");
  const lines = normalizedDiff.split("\n");
  const patches: UnifiedDiffPatch[] = [];
  let current: UnifiedDiffPatch | undefined;
  let currentHunk: UnifiedDiffHunk | undefined;
  let previousOldPath: string | undefined;

  for (const line of lines) {
    if (line.startsWith("--- ")) {
      previousOldPath = parseUnifiedDiffRawPath(line);
      currentHunk = undefined;
      continue;
    }

    if (line.startsWith("+++ ")) {
      current = { path: parseUnifiedDiffPath(line), hunks: [], isNewFile: previousOldPath === "/dev/null" };
      patches.push(current);
      currentHunk = undefined;
      continue;
    }

    if (line.startsWith("@@")) {
      if (!current) throw new Error(
        "Unified diff hunk encountered before file header. " +
        "The diff must begin with '--- a/<path>' and '+++ b/<path>' lines before any @@ hunk markers. " +
        "Example format:\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,4 +1,4 @@\n context line\n-old line\n+new line"
      );
      currentHunk = parseUnifiedDiffHunkHeader(line);
      current.hunks.push(currentHunk);
      continue;
    }

    if (!current) continue;

    if (!currentHunk) {
      if (line.startsWith("-") && !line.startsWith("---")) {
        currentHunk = { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [] };
        current.hunks.push(currentHunk);
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        currentHunk = { oldStart: 1, oldCount: 0, newStart: 1, newCount: 1, lines: [] };
        current.hunks.push(currentHunk);
      } else {
        continue;
      }
    }

    if (line === "\\ No newline at end of file") continue;
    if (line.startsWith("-")) currentHunk.lines.push({ kind: "remove", text: line.slice(1) });
    else if (line.startsWith("+")) currentHunk.lines.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith(" ")) currentHunk.lines.push({ kind: "context", text: line.slice(1) });
    else if (line === "") currentHunk.lines.push({ kind: "context", text: "" });
  }

  if (patches.length === 0) throw new Error("Unified diff must include at least one +++ b/<path> header");
  if (patches.some((patch) => patch.hunks.length === 0 || patch.hunks.every((hunk) => hunk.lines.every((item) => item.kind === "context")))) {
    throw new Error("Unified diff contains no supported changes");
  }
  return patches;
}

function parseUnifiedDiffPath(header: string): string {
  const raw = parseUnifiedDiffRawPath(header);
  if (!raw || raw === "/dev/null") throw new Error("Unified diff target path is required");
  return raw.startsWith("b/") ? raw.slice(2) : raw;
}

function parseUnifiedDiffRawPath(header: string): string {
  return header.slice(4).trim().split(/\s+/)[0] ?? "";
}

function parseUnifiedDiffHunkHeader(header: string): UnifiedDiffHunk {
  // Full standard: @@ -L,C +L,C @@
  const full = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (full) {
    return {
      oldStart: Number(full[1]),
      oldCount: full[2] === undefined ? 1 : Number(full[2]),
      newStart: Number(full[3]),
      newCount: full[4] === undefined ? 1 : Number(full[4]),
      lines: [],
    };
  }
  // Lenient: @@ -L +L @@ or @@ @@ (LLM may omit counts or emit bare @@)
  const lenient = /^@@\s*(?:-(\d+))?(?:\s*\+(\d+))?\s*@@/.exec(header);
  if (lenient) {
    return {
      oldStart: lenient[1] !== undefined ? Number(lenient[1]) : 1,
      oldCount: 1,
      newStart: lenient[2] !== undefined ? Number(lenient[2]) : 1,
      newCount: 1,
      lines: [],
    };
  }
  throw new Error(
    `Invalid unified diff hunk header: "${header}". ` +
    `Expected format: "@@ -<oldStart>[,<oldCount>] +<newStart>[,<newCount>] @@" — e.g. "@@ -10,6 +10,7 @@"`
  );
}

// Context/removal lines anchor a hunk against the source. `exact` requires a
// byte-for-byte match; `loose` compares trimmed text so a diff still applies
// when an authored line's leading/trailing whitespace drifted (e.g. the common
// LLM error of dropping a context line's mandatory leading prefix space, which
// makes the parser's slice(1) eat one real indent space). Loose matching is
// only ever a fallback after exact matching finds nothing, and applied output
// always preserves the source bytes — so indentation is never corrupted.
type HunkMatchMode = "exact" | "loose";

type HunkMatch = { index: number; mode: HunkMatchMode };

function lineMatches(sourceLine: string, hunkText: string, mode: HunkMatchMode): boolean {
  if (sourceLine === hunkText) return true;
  return mode === "loose" && sourceLine.trim() === hunkText.trim();
}

function findCandidateHunkIndexes(sourceLines: string[], hunk: UnifiedDiffHunk, preferredIndex: number, mode: HunkMatchMode = "exact"): number[] {
  const candidates: number[] = [];
  const searchRadius = 500;

  for (let offset = -searchRadius; offset <= searchRadius; offset += 1) {
    const index = preferredIndex + offset;
    if (index < 0 || index > sourceLines.length) continue;
    if (matchesHunkAt(sourceLines, hunk, index, mode)) {
      candidates.push(index);
    }
  }

  return candidates;
}

// Resolve a hunk to a single application site, preferring exact matches and
// falling back to whitespace-tolerant matching only when exact finds nothing.
// Returns the chosen mode so the apply step uses the same comparison.
function resolveHunkCandidates(sourceLines: string[], hunk: UnifiedDiffHunk, preferredIndex: number): { candidates: number[]; mode: HunkMatchMode } {
  const exact = findCandidateHunkIndexes(sourceLines, hunk, preferredIndex, "exact");
  if (exact.length > 0) return { candidates: exact, mode: "exact" };
  const loose = findCandidateHunkIndexes(sourceLines, hunk, preferredIndex, "loose");
  return { candidates: loose, mode: loose.length > 0 ? "loose" : "exact" };
}

function findHunkApplicationIndex(sourceLines: string[], hunk: UnifiedDiffHunk, preferredIndex: number, relative: string): HunkMatch {
  const { candidates, mode } = resolveHunkCandidates(sourceLines, hunk, preferredIndex);

  if (candidates.length === 1) return { index: candidates[0], mode };
  if (candidates.length > 1) {
    throw new Error(`Unified diff hunk application ambiguous in ${relative}`);
  }

  throw new Error(`Unified diff context mismatch in ${relative}`);
}

function matchesHunkAt(sourceLines: string[], hunk: UnifiedDiffHunk, index: number, mode: HunkMatchMode = "exact"): boolean {
  let cursor = index;

  for (const line of hunk.lines) {
    if (line.kind === "add") continue;
    if (cursor >= sourceLines.length) return false;
    if (!lineMatches(sourceLines[cursor], line.text, mode)) return false;
    cursor += 1;
  }

  return true;
}

function applyHunkAt(sourceLines: string[], hunk: UnifiedDiffHunk, index: number, relative: string, mode: HunkMatchMode = "exact"): string[] {
  const applied: string[] = [];
  let cursor = index;

  for (const line of hunk.lines) {
    if (line.kind === "context") {
      if (!lineMatches(sourceLines[cursor], line.text, mode)) {
        throw new Error(`Unified diff context mismatch in ${relative} at line ${cursor + 1}`);
      }
      // Preserve the source line verbatim so a loose match never rewrites indentation.
      applied.push(sourceLines[cursor]);
      cursor += 1;
      continue;
    }

    if (line.kind === "remove") {
      if (!lineMatches(sourceLines[cursor], line.text, mode)) {
        throw new Error(`Unified diff stale removal mismatch in ${relative} at line ${cursor + 1}`);
      }
      cursor += 1;
      continue;
    }

    applied.push(line.text);
  }

  return applied;
}
