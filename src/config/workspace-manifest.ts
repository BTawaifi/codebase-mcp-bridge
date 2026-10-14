import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { COMMANDS, type CommandId } from "./commands.js";

/**
 * Resolve per-repository validation commands from an explicit manifest or a
 * `workspace.json` discovered from the repository upward. No external control
 * repository or machine-specific path is assumed.
 */

function resolveManifestPath(): string | undefined {
  const fromEnv = process.env.CODEBASE_MCP_WORKSPACE_MANIFEST?.trim();
  if (!fromEnv) return undefined;
  return path.isAbsolute(fromEnv) ? fromEnv : undefined;
}

interface ManifestRepo {
  id: string;
  name?: string;
  path: string;
  commands?: Record<string, string>;
}

interface WorkspaceManifest {
  repos?: ManifestRepo[];
}

function normalizePath(p: string): string {
  return path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
}

const manifestCache = new Map<
  string,
  { mtimeMs: number; manifest: WorkspaceManifest | null }
>();

function loadManifest(manifestPath: string): WorkspaceManifest | null {
  try {
    const mtimeMs = statSync(manifestPath).mtimeMs;
    const cached = manifestCache.get(manifestPath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.manifest;
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as WorkspaceManifest;
    manifestCache.set(manifestPath, { mtimeMs, manifest });
    return manifest;
  } catch {
    return null;
  }
}

/** Reset the in-process manifest cache. Test-only. */
export function clearManifestCache(): void {
  manifestCache.clear();
}

/** Candidate manifest paths in priority order for the given repo root. */
function candidateManifestPaths(root: string): string[] {
  const explicit = resolveManifestPath();
  if (explicit) return [explicit];

  const candidates: string[] = [];
  let dir = path.resolve(root);
  while (true) {
    candidates.push(path.join(dir, "workspace.json"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates;
}

function findManifestRepo(
  root: string,
): { manifestPath: string; repo: ManifestRepo } | null {
  const target = normalizePath(root);
  for (const manifestPath of candidateManifestPaths(root)) {
    const manifest = loadManifest(manifestPath);
    const repo = manifest?.repos?.find(
      (entry) => entry.path && normalizePath(entry.path) === target,
    );
    if (repo) return { manifestPath, repo };
  }
  return null;
}

/**
 * Maps each static validation id to the manifest command key(s) it should
 * prefer. Safety-critical: `lint` resolves to the manifest's `lintCheck` so the
 * bridge never runs a mutating `lint --fix` as verification. `script:ps-parse`
 * is bridge-internal and is never workspace-derived.
 */
const MANIFEST_KEYS_BY_ID: Record<CommandId, string[]> = {
  "test:unit": ["test"],
  lint: ["lintCheck"],
  typecheck: ["typecheck"],
  build: ["build"],
  "script:ps-parse": [],
};

interface UnavailableCommand {
  id: CommandId;
  command: string;
  reason: string;
}

interface ResolvedValidation {
  commands: Record<CommandId, string>;
  source: "workspace-manifest" | "static-default";
  manifestPath?: string;
  repoId?: string;
  notes: string[];
  /**
   * True when the resolved npm-script commands were checked against the repo's
   * package.json. False when no package.json was found/readable (so the
   * commands could not be verified — not that they are known-bad).
   */
  verifiedAgainstPackageJson: boolean;
  /** Commands whose underlying npm script does not exist in package.json. */
  unavailableCommands?: UnavailableCommand[];
}

/**
 * Determine which npm script a validation command invokes, if any. Returns
 * undefined for non-npm commands (npx, powershell, etc.) which we cannot verify
 * against package.json scripts.
 */
function npmScriptName(command: string): string | undefined {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] !== "npm") return undefined;
  // `npm test` / `npm test -- ...` map to the "test" lifecycle script.
  if (tokens[1] === "test" || tokens[1] === "t") return "test";
  if ((tokens[1] === "run" || tokens[1] === "run-script") && tokens[2]) {
    return tokens[2];
  }
  return undefined;
}

/**
 * Verify the resolved commands against the repo's package.json scripts. Flags
 * (does not silently drop) any command whose npm script is missing so the agent
 * caller never runs a command that does not exist, while non-npm commands and
 * unreadable package.json files are left untouched.
 */
export function verifyCommandsAgainstPackageJson(
  root: string,
  commands: Record<CommandId, string>,
): { verifiedAgainstPackageJson: boolean; unavailableCommands: UnavailableCommand[] } {
  let scripts: Record<string, unknown> | undefined;
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { scripts?: Record<string, unknown> };
    scripts = pkg.scripts ?? {};
  } catch {
    return { verifiedAgainstPackageJson: false, unavailableCommands: [] };
  }

  const unavailableCommands: UnavailableCommand[] = [];
  for (const id of Object.keys(commands) as CommandId[]) {
    const script = npmScriptName(commands[id]);
    if (script && !(script in scripts)) {
      unavailableCommands.push({
        id,
        command: commands[id],
        reason: `package.json has no "${script}" script`,
      });
    }
  }
  return { verifiedAgainstPackageJson: true, unavailableCommands };
}

/**
 * Resolve the validation command map for a repo root, overlaying
 * manifest-declared safe commands on top of the static defaults. Empty manifest
 * commands (declared as "") are ignored so the static default is preserved.
 */
export function resolveValidationCommands(
  root: string | undefined,
): ResolvedValidation {
  const base = { ...COMMANDS } as Record<CommandId, string>;
  const notes: string[] = [];

  if (!root) {
    notes.push("No repository root was supplied; using static default validation commands.");
    return enforceExplicitLintCheck({
      commands: base,
      source: "static-default",
      notes,
      verifiedAgainstPackageJson: false,
    }, false);
  }

  const found = findManifestRepo(root);
  if (!found) {
    notes.push("Repository is not listed in a workspace.json; using static defaults.");
    return enforceExplicitLintCheck({
      commands: base,
      source: "static-default",
      notes,
      ...applyPackageJsonVerification(root, base, notes),
    }, false);
  }

  const { manifestPath, repo } = found;
  const merged = { ...base };
  let hasExplicitLintCheck = false;
  for (const id of Object.keys(MANIFEST_KEYS_BY_ID) as CommandId[]) {
    for (const key of MANIFEST_KEYS_BY_ID[id]) {
      const command = repo.commands?.[key]?.trim();
      if (command) {
        merged[id] = command;
        if (id === "lint" && key === "lintCheck") {
          hasExplicitLintCheck = true;
          notes.push("Resolved 'lint' to the manifest's explicitly configured lintCheck command.");
        }
        break;
      }
    }
  }

  return enforceExplicitLintCheck({
    commands: merged,
    source: "workspace-manifest",
    manifestPath,
    repoId: repo.id,
    notes,
    ...applyPackageJsonVerification(root, merged, notes),
  }, hasExplicitLintCheck);
}

/**
 * Run package.json verification and append a human-readable note for any
 * unavailable command so the prep response makes the discrepancy obvious.
 */
function enforceExplicitLintCheck(result: ResolvedValidation, hasExplicitLintCheck: boolean): ResolvedValidation {
  if (hasExplicitLintCheck) return result;
  const unavailableCommands = (result.unavailableCommands ?? []).filter((entry) => entry.id !== "lint");
  unavailableCommands.push({
    id: "lint",
    command: result.commands.lint,
    reason: "lint requires an explicit workspace.json lintCheck command because a generic npm lint script may mutate files",
  });
  result.notes.push("Lint validation is disabled until workspace.json provides an explicit lintCheck command.");
  return { ...result, unavailableCommands };
}

function applyPackageJsonVerification(
  root: string,
  commands: Record<CommandId, string>,
  notes: string[],
): { verifiedAgainstPackageJson: boolean; unavailableCommands?: UnavailableCommand[] } {
  const { verifiedAgainstPackageJson, unavailableCommands } =
    verifyCommandsAgainstPackageJson(root, commands);
  if (unavailableCommands.length > 0) {
    notes.push(
      `Some validation commands have no matching package.json script and will fail if run: ${unavailableCommands
        .map((entry) => `${entry.id} (${entry.reason})`)
        .join(", ")}.`,
    );
  }
  return verifiedAgainstPackageJson
    ? {
        verifiedAgainstPackageJson,
        ...(unavailableCommands.length > 0 ? { unavailableCommands } : {}),
      }
    : { verifiedAgainstPackageJson };
}
