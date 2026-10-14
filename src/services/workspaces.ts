import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type WorkspaceEntry = {
  id: string;
  name: string;
  path: string;
  trustedAt: string;
  kind: "git" | "directory";
  gitRemote?: string;
};

type WorkspaceRegistry = {
  instance: {
    id: string;
    name: string;
    createdAt: string;
    hostname: string;
  };
  workspaces: WorkspaceEntry[];
};

export class WorkspaceService {
  private readonly stateDir: string;
  private readonly registryPath: string;

  constructor(stateRoot = os.homedir()) {
    const resolvedStateRoot = path.resolve(stateRoot);
    this.stateDir = path.join(resolvedStateRoot, ".ai-bridge");
    this.registryPath = path.join(this.stateDir, "workspaces.json");
  }

  async getInstance(): Promise<WorkspaceRegistry["instance"]> {
    return (await this.readRegistry()).instance;
  }

  async listWorkspaces(): Promise<string> {
    const registry = await this.readRegistry();
    return JSON.stringify({ instance: registry.instance, workspaces: registry.workspaces }, null, 2);
  }

  async getWorkspaceEntries(): Promise<WorkspaceEntry[]> {
    return (await this.readRegistry()).workspaces;
  }

  async trustWorkspace(input: { path: string; name?: string; id?: string }): Promise<string> {
    const repoRoot = await validateWorkspacePath(input.path);
    const registry = await this.readRegistry();
    const existing = registry.workspaces.find((entry) => samePath(entry.path, repoRoot));
    const kind = await detectWorkspaceKind(repoRoot);
    const gitRemote = kind === "git" ? await readGitRemote(repoRoot) : undefined;

    if (existing) {
      existing.name = input.name?.trim() || existing.name;
      existing.kind = kind;
      existing.gitRemote = gitRemote;
      await this.writeRegistry(registry);
      return JSON.stringify({ workspace: existing, alreadyTrusted: true }, null, 2);
    }

    const workspace: WorkspaceEntry = {
      id: uniqueWorkspaceId(registry, input.id || input.name || path.basename(repoRoot)),
      name: input.name?.trim() || path.basename(repoRoot),
      path: repoRoot,
      trustedAt: new Date().toISOString(),
      kind,
      gitRemote,
    };
    registry.workspaces.push(workspace);
    await this.writeRegistry(registry);
    return JSON.stringify({ workspace, alreadyTrusted: false }, null, 2);
  }

  async untrustWorkspace(id: string): Promise<string> {
    const registry = await this.readRegistry();
    const before = registry.workspaces.length;
    registry.workspaces = registry.workspaces.filter((entry) => entry.id !== id);
    await this.writeRegistry(registry);
    return JSON.stringify({ removed: before !== registry.workspaces.length, id }, null, 2);
  }

  private async readRegistry(): Promise<WorkspaceRegistry> {
    try {
      const raw = JSON.parse(await fs.readFile(this.registryPath, "utf8")) as Record<string, unknown>;
      const workspaces = Array.isArray(raw.workspaces) ? raw.workspaces : [];
      return {
        instance: isInstance(raw.instance) ? raw.instance : createInstance(),
        workspaces: workspaces.flatMap((entry) => normalizeWorkspaceEntry(entry)),
      };
    } catch {
      return { instance: createInstance(), workspaces: [] };
    }
  }

  private async writeRegistry(registry: WorkspaceRegistry): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    await fs.writeFile(this.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  }
}

function createInstance(): WorkspaceRegistry["instance"] {
  return {
    id: process.env.BRIDGE_INSTANCE_ID?.trim() || crypto.randomUUID(),
    name: process.env.BRIDGE_INSTANCE_NAME?.trim() || os.hostname(),
    createdAt: new Date().toISOString(),
    hostname: os.hostname(),
  };
}

function isInstance(value: unknown): value is WorkspaceRegistry["instance"] {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return ["id", "name", "createdAt", "hostname"].every((key) => typeof candidate[key] === "string");
}

function normalizeWorkspaceEntry(value: unknown): WorkspaceEntry[] {
  if (!value || typeof value !== "object") return [];
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.path !== "string" ||
    typeof candidate.trustedAt !== "string"
  ) return [];

  const kind = candidate.kind === "git" || candidate.kind === "directory" ? candidate.kind : "directory";
  return [{
    id: candidate.id,
    name: candidate.name,
    path: candidate.path,
    trustedAt: candidate.trustedAt,
    kind,
    ...(typeof candidate.gitRemote === "string" ? { gitRemote: candidate.gitRemote } : {}),
  }];
}

async function validateWorkspacePath(inputPath: string): Promise<string> {
  if (!path.isAbsolute(inputPath)) throw new Error("Workspace path must be absolute");
  const repoRoot = path.resolve(inputPath);
  rejectDangerousRoot(repoRoot);
  const stat = await fs.stat(repoRoot).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Workspace path is not a directory: ${inputPath}`);
  return repoRoot;
}

async function detectWorkspaceKind(repoRoot: string): Promise<WorkspaceEntry["kind"]> {
  const gitStat = await fs.stat(path.join(repoRoot, ".git")).catch(() => null);
  return gitStat ? "git" : "directory";
}

function rejectDangerousRoot(repoRoot: string): void {
  const parsed = path.parse(repoRoot);
  const normalized = repoRoot.toLowerCase();
  const home = os.homedir().toLowerCase();
  const blocked = [
    parsed.root.toLowerCase(),
    home,
    path.join(home, ".ssh").toLowerCase(),
    path.join(home, ".codex").toLowerCase(),
    path.join(parsed.root, "windows").toLowerCase(),
    path.join(parsed.root, "program files").toLowerCase(),
    path.join(parsed.root, "program files (x86)").toLowerCase(),
  ];
  if (blocked.includes(normalized)) throw new Error(`Refusing to trust dangerous workspace root: ${repoRoot}`);
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
}

function uniqueWorkspaceId(registry: WorkspaceRegistry, source: string): string {
  const base = slug(source);
  const used = new Set(registry.workspaces.map((entry) => entry.id));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

async function readGitRemote(repoRoot: string): Promise<string | undefined> {
  const config = await fs.readFile(path.join(repoRoot, ".git", "config"), "utf8").catch(() => "");
  return config.match(/\[remote "origin"\][\s\S]*?\n\s*url\s*=\s*(.+)/)?.[1]?.trim();
}
