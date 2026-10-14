import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolve the ripgrep executable.
 *
 * Invoking bare "rg" relies on the launching process's PATH, which on Windows is
 * a stale snapshot taken when the process started. When ripgrep is installed in a
 * location that only fresh shells pick up (e.g. the winget Links shim dir,
 * `%LOCALAPPDATA%\Microsoft\WinGet\Links`), a long-lived bridge process spawns
 * `rg` and gets ENOENT even though ripgrep is installed and on the *persistent*
 * PATH. To be robust to that, honor an explicit override and otherwise probe the
 * common per-user install locations before falling back to the PATH lookup.
 */

const RG_BINARY = process.platform === "win32" ? "rg.exe" : "rg";

function candidatePaths(): string[] {
  const candidates: string[] = [];

  const override = process.env.BRIDGE_RG_PATH?.trim();
  if (override) candidates.push(override);

  const home = os.homedir();
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    const programData = process.env.ProgramData ?? "C:\\ProgramData";
    candidates.push(
      path.join(localAppData, "Microsoft", "WinGet", "Links", "rg.exe"),
      path.join(home, ".cargo", "bin", "rg.exe"),
      path.join(home, "scoop", "shims", "rg.exe"),
      path.join(programData, "chocolatey", "bin", "rg.exe"),
    );
  } else {
    candidates.push(
      path.join(home, ".cargo", "bin", "rg"),
      "/opt/homebrew/bin/rg",
      "/usr/local/bin/rg",
      "/usr/bin/rg",
    );
  }
  return candidates;
}

let cached: string | undefined;

/**
 * Returns an absolute path to a ripgrep binary if one can be located, otherwise
 * the bare binary name (which relies on PATH and may ENOENT — callers handle
 * that). The result is cached for the process lifetime.
 */
export function resolveRipgrepPath(): string {
  if (cached) return cached;
  for (const candidate of candidatePaths()) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        cached = candidate;
        return cached;
      }
    } catch {
      // Unreadable candidate — keep probing.
    }
  }
  cached = RG_BINARY;
  return cached;
}

/** Test seam: clear the cached resolution so env changes take effect. */
export function resetRipgrepPathCache(): void {
  cached = undefined;
}
