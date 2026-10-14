import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SecurityService } from "./security.js";

const execFileAsync = promisify(execFile);

export type GitStatus = {
  branch: string;
  staged: string[];
  unstaged: string[];
  mixed: string[];
  untracked: string[];
};

export class GitService {
  private readonly security: SecurityService;

  constructor(private readonly repoRoot: string) {
    this.security = new SecurityService(repoRoot);
  }

  async status(): Promise<GitStatus> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        "git",
        ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"],
        { cwd: this.repoRoot, maxBuffer: 5_000_000 },
      ));
    } catch (error) {
      throw new Error(`Git status failed: ${commandError(error)}`);
    }

    const staged: string[] = [];
    const unstaged: string[] = [];
    const mixed: string[] = [];
    const untracked: string[] = [];
    const records = stdout.split("\0");
    let branch = "(detached)";
    let index = 0;

    if (records[0]?.startsWith("## ")) {
      branch = parseBranchHeader(records[0]);
      index = 1;
    }

    while (index < records.length) {
      const record = records[index];
      index += 1;
      if (!record) continue;

      const status = record.slice(0, 2);
      const filePath = record.slice(3).replaceAll("\\", "/");
      const codeX = status[0];
      const codeY = status[1];

      // Porcelain -z emits an additional original path after rename/copy entries.
      if (codeX === "R" || codeX === "C" || codeY === "R" || codeY === "C") index += 1;

      if (status === "??") {
        untracked.push(filePath);
        continue;
      }

      const isStaged = codeX !== " " && codeX !== "?" && codeX !== "!";
      const isUnstaged = codeY !== " " && codeY !== "?" && codeY !== "!";
      if (isStaged && isUnstaged) mixed.push(filePath);
      else if (isStaged) staged.push(filePath);
      else if (isUnstaged) unstaged.push(filePath);
    }

    return { branch, staged, unstaged, mixed, untracked };
  }

  async diff(
    base?: string,
    paths?: string[],
    summaryOnly = false,
    exclude?: string[],
    stagedOnly = false,
    maxChars = 50_000,
  ): Promise<string> {
    if (base) validateGitArgument(base, "base ref");
    const normalizedPaths = paths?.length ? this.normalizeRepoPaths(paths) : [];
    const excludes = (exclude ?? []).map(normalizeExcludePattern);

    const args = ["diff"];
    if (stagedOnly) args.push("--cached");
    if (base) args.push(base);
    if (summaryOnly) args.push("--name-status");
    if (normalizedPaths.length > 0 || excludes.length > 0) {
      args.push("--", ...normalizedPaths, ...excludes.map((pattern) => `:(exclude)${pattern}`));
    }

    try {
      const { stdout } = await execFileAsync("git", args, { cwd: this.repoRoot, maxBuffer: 10_000_000 });
      const output = stdout.trim();
      if (!output) return "(no diff)";
      const limit = Math.max(1, Math.min(200_000, Math.floor(maxChars)));
      return output.length <= limit
        ? output
        : `${output.slice(0, limit)}\n[diff truncated to ${limit} characters; scope paths or increase maxChars]`;
    } catch (error) {
      throw new Error(`Git diff failed: ${commandError(error)}`);
    }
  }

  async stagePaths(paths: string[]): Promise<string> {
    const normalized = this.normalizeRepoPaths(paths);
    await execFileAsync("git", ["add", "--", ...normalized], { cwd: this.repoRoot, maxBuffer: 2_000_000 });
    await this.assertStagedPathsSafe(normalized);
    const { stdout } = await execFileAsync("git", ["status", "--short", "--", ...normalized], {
      cwd: this.repoRoot,
      maxBuffer: 2_000_000,
    });
    return JSON.stringify({
      staged: normalized,
      status: stdout.split(/\r?\n/).filter(Boolean).map((line) => line.trim()),
    }, null, 2);
  }

  async commit(message: string): Promise<string> {
    if (!message.trim()) throw new Error("Commit message is required");
    await this.assertStagedPathsSafe();
    try {
      const { stdout, stderr } = await execFileAsync("git", ["commit", "-m", message], {
        cwd: this.repoRoot,
        maxBuffer: 2_000_000,
      });
      return [stdout, stderr].filter(Boolean).join("\n") || "Commit created";
    } catch (error) {
      throw new Error(`Git commit failed: ${commandError(error)}`);
    }
  }

  async commitPaths(paths: string[], message: string): Promise<string> {
    if (!message.trim()) throw new Error("Commit message is required");
    const normalized = this.normalizeRepoPaths(paths);
    await execFileAsync("git", ["add", "--", ...normalized], { cwd: this.repoRoot, maxBuffer: 2_000_000 });
    await this.assertStagedPathsSafe(normalized);
    try {
      const { stdout, stderr } = await execFileAsync("git", ["commit", "-m", message, "--", ...normalized], {
        cwd: this.repoRoot,
        maxBuffer: 2_000_000,
      });
      return [stdout, stderr].filter(Boolean).join("\n") || "Commit created";
    } catch (error) {
      throw new Error(`Git commit failed: ${commandError(error)}`);
    }
  }

  async push(remote = "origin", branch?: string): Promise<string> {
    validateGitArgument(remote, "remote");
    if (branch) validateGitArgument(branch, "branch/refspec");
    const args = branch ? ["push", remote, branch] : ["push", remote];
    try {
      const { stdout, stderr } = await execFileAsync("git", args, { cwd: this.repoRoot, maxBuffer: 2_000_000 });
      return [stdout, stderr].filter(Boolean).join("\n") || "Push completed";
    } catch (error) {
      throw new Error(`Git push failed: ${commandError(error)}`);
    }
  }

  private async assertStagedPathsSafe(paths?: string[]): Promise<void> {
    const args = ["diff", "--cached", "--name-only", "-z"];
    if (paths?.length) args.push("--", ...paths);
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.repoRoot,
      maxBuffer: 2_000_000,
    });
    for (const filePath of stdout.split("\0").filter(Boolean)) {
      this.security.assertSafeMutationPath(filePath.replaceAll("\\", "/"));
    }
  }

  private normalizeRepoPaths(paths: string[]): string[] {
    if (paths.length === 0) throw new Error("At least one path is required");
    return [...new Set(paths.map((inputPath) => {
      if (inputPath.startsWith(":")) {
        throw new Error(`Refusing git pathspec magic; provide a literal repository path: ${inputPath}`);
      }
      const abs = this.security.resolveRepoPath(inputPath);
      const relative = this.security.toRepoRelative(abs);
      if (!relative || relative === ".") {
        throw new Error("Refusing to operate on the repository root; provide specific files or directories.");
      }
      this.security.assertSafeMutationPath(relative);
      return relative;
    }))];
  }
}

function parseBranchHeader(record: string): string {
  const value = record.slice(3).trim();
  for (const prefix of ["No commits yet on ", "Initial commit on "]) {
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  if (value.startsWith("HEAD (no branch)")) return "(detached)";
  return value.split("...")[0].split(" ")[0] || "(detached)";
}

function validateGitArgument(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required`);
  if (value.startsWith("-") || /[\0\r\n]/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function normalizeExcludePattern(pattern: string): string {
  const normalized = pattern.replaceAll("\\", "/").trim();
  if (!normalized || normalized.startsWith(":") || normalized.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(normalized)) {
    throw new Error(`Invalid exclude pattern: ${pattern}`);
  }
  return normalized;
}

function commandError(error: unknown): string {
  const value = error as { stderr?: unknown; message?: unknown };
  const stderr = typeof value?.stderr === "string" ? value.stderr.trim() : "";
  if (stderr) return stderr;
  return error instanceof Error ? error.message : String(error);
}
