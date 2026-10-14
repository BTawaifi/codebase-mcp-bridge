import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";
import { DEFAULT_EXCLUDE_GLOBS, DEFAULT_INCLUDE_GLOBS, MAX_FILE_BYTES } from "../config/allowlist.js";

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function secretPatterns(): Array<[string, RegExp]> {
  return [
    ["OpenAI-style API key", /sk-[A-Za-z0-9_-]{20,}/g],
    ["GitHub token", /gh[pousr]_[A-Za-z0-9_]{20,}/g],
    ["Private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
    ["AWS access key", /AKIA[0-9A-Z]{16}/g]
  ];
}

const SENSITIVE_MUTATION_GLOBS = [
  "**/.git/**",
  "**/.env",
  "**/.env.*",
  "**/*secret*",
  "**/*secrets*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
];

export class SecurityService {
  private readonly repoRoot: string;
  private readonly realRepoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = path.resolve(repoRoot);
    this.realRepoRoot = realpathSync.native(this.repoRoot);
  }

  resolveRepoPath(inputPath: string): string {
    const normalizedInput = inputPath.replaceAll("\\", "/");
    if (normalizedInput.includes("\0")) {
      throw new Error("Path contains invalid null byte");
    }

    const resolved = path.resolve(this.repoRoot, normalizedInput);
    if (!isWithinRoot(this.repoRoot, resolved)) {
      throw new Error(`Path escapes repository root: ${inputPath}`);
    }

    let existingAncestor = resolved;
    while (!existsSync(existingAncestor)) {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) break;
      existingAncestor = parent;
    }
    const realAncestor = realpathSync.native(existingAncestor);
    if (!isWithinRoot(this.realRepoRoot, realAncestor)) {
      throw new Error(`Path escapes repository root through a symbolic link: ${inputPath}`);
    }
    if (existsSync(resolved)) {
      const realResolved = realpathSync.native(resolved);
      if (!isWithinRoot(this.realRepoRoot, realResolved)) {
        throw new Error(`Path escapes repository root through a symbolic link: ${inputPath}`);
      }
    }
    return resolved;
  }

  toRepoRelative(absPath: string): string {
    return path.relative(this.repoRoot, absPath).replaceAll("\\", "/");
  }

  assertReadable(relativePath: string, sizeBytes?: number): void {
    const rel = relativePath.replaceAll("\\", "/");
    if (sizeBytes !== undefined && sizeBytes > MAX_FILE_BYTES) {
      throw new Error(`File exceeds ${MAX_FILE_BYTES} byte limit: ${rel}`);
    }
    if (DEFAULT_EXCLUDE_GLOBS.some((glob) => minimatch(rel, glob, { dot: true }))) {
      throw new Error(`Path is excluded by bridge policy: ${rel}`);
    }
  }

  assertSafeMutationPath(relativePath: string): void {
    const rel = relativePath.replaceAll("\\", "/");
    if (SENSITIVE_MUTATION_GLOBS.some((glob) => minimatch(rel, glob, { dot: true }))) {
      throw new Error(`Path is blocked from mutation by bridge security policy: ${rel}`);
    }
  }

  isIndexable(relativePath: string): boolean {
    const rel = relativePath.replaceAll("\\", "/");
    const included = DEFAULT_INCLUDE_GLOBS.some((glob) => minimatch(rel, glob, { dot: true }));
    const excluded = DEFAULT_EXCLUDE_GLOBS.some((glob) => minimatch(rel, glob, { dot: true }));
    return included && !excluded;
  }

  scanForSecrets(text: string, _relativePath?: string): string[] {
    return secretPatterns().filter(([, regex]) => regex.test(text)).map(([name]) => name);
  }

  redactSecrets(text: string): string {
    return secretPatterns().reduce((current, [name, regex]) => current.replace(regex, `[redacted ${name}]`), text);
  }

  assertValidId(id: string, context?: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error(`Invalid ID format${context ? ` for ${context}` : ''}: ${id}. Directory traversal is blocked.`);
    }
  }
}
