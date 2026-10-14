// Registers the bridge in Antigravity CLI (config + generated tool schemas + instructions), Claude Desktop,
// Claude Code and Codex, using the live tool list from the compiled stdio server.
// Usage: npm run build && npm run mcp:sync
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stdioPath = path.join(repoRoot, "dist", "stdio.js");
const serverName = "codebase-mcp-bridge";
const TIMEOUT_MS = 20_000;

// Config paths
const antigravityConfigPath = path.join(os.homedir(), ".gemini", "config", "mcp_config.json");
const antigravityToolDir    = path.join(os.homedir(), ".gemini", "antigravity-cli", "mcp", serverName);
const claudeDesktopPath     = process.platform === "win32"
  ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
  : process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
const claudeCodePath        = path.join(os.homedir(), ".claude.json");
const codexConfigPath       = path.join(os.homedir(), ".codex", "config.toml");

if (!fs.existsSync(stdioPath)) {
  console.error(`❌ ${stdioPath} not found. Run "npm run build" first.`);
  process.exit(1);
}

console.log(`\n--- Syncing MCP client registrations for ${serverName} ---\n`);

// 1. Ask the compiled stdio server for its live tool list over a proper MCP handshake.
const tools = await listTools();
if (!tools) process.exit(1);

// 2. Register everywhere, then write the Antigravity per-tool schemas.
const results = [
  registerJsonClient(antigravityConfigPath, "Antigravity CLI"),
  registerJsonClient(claudeDesktopPath, "Claude Desktop"),
  registerJsonClient(claudeCodePath, "Claude Code"),
  registerCodexServer(),
  writeAntigravitySchemas(tools),
];
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n⚠️ Done with ${failed} failure(s).\n` : "\n✅ Done.\n");
process.exit(failed ? 1 : 0);

function listTools() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [stdioPath], {
      cwd: repoRoot,
      env: { ...process.env, BRIDGE_REPO_ROOT: repoRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) console.error(`❌ ${error}${stderr.trim() ? `\n--- server stderr ---\n${stderr.trim().slice(-2000)}` : ""}`);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null, `No tools/list response within ${TIMEOUT_MS / 1000}s.`), TIMEOUT_MS);
    const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (err) => finish(null, `Could not start the server: ${err.message}`));
    child.on("exit", (code) => finish(null, `Server exited (code ${code}) before listing tools.`));
    child.stdout.on("data", (data) => {
      stdout += data.toString();
      let newline;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; } // ignore any non-JSON-RPC output
        if (message.id === 1) {
          if (message.error) return finish(null, `initialize failed: ${message.error.message}`);
          send({ method: "notifications/initialized" });
          send({ id: 2, method: "tools/list", params: {} });
        } else if (message.id === 2) {
          if (message.error || !Array.isArray(message.result?.tools)) {
            return finish(null, `tools/list failed: ${message.error?.message ?? "no tools in response"}`);
          }
          finish(message.result.tools);
        }
      }
    });

    send({ id: 1, method: "initialize", params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "sync-mcp-clients", version: "1.0.0" },
    } });
  });
}

// Read a JSON file, stripping a BOM if present.
function readJsonSafe(filePath) {
  const raw = fs.readFileSync(filePath);
  const text = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? raw.subarray(3).toString("utf8") : raw.toString("utf8");
  return JSON.parse(text);
}

function writeJsonSafe(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), { encoding: "utf8" });
}

// Antigravity, Claude Desktop and Claude Code all use a top-level "mcpServers" map; other keys are preserved.
function registerJsonClient(configPath, label) {
  try {
    const config = fs.existsSync(configPath) ? readJsonSafe(configPath) : {};
    config.mcpServers ??= {};
    config.mcpServers[serverName] = { command: "node", args: [stdioPath], env: { BRIDGE_REPO_ROOT: repoRoot } };
    writeJsonSafe(configPath, config);
    console.log(`🔗 ${label}: ${configPath}`);
    return true;
  } catch (err) {
    console.error(`⚠️ ${label}: failed to update ${configPath}: ${err.message}`);
    return false;
  }
}

// Codex: upsert the [mcp_servers.<name>] table (and its .env subtable) and leave the rest of config.toml untouched.
function registerCodexServer() {
  try {
    const existing = fs.existsSync(codexConfigPath) ? fs.readFileSync(codexConfigPath, "utf8") : "";
    const header = `[mcp_servers.${serverName}]`;
    const ownTables = new RegExp(String.raw`^\[mcp_servers\.${serverName}(\.env)?\]\s*$`);

    // Split into top-level tables, drop ours, and remember a user's `enabled = ...` choice.
    const lines = existing.split(/\r?\n/);
    const kept = [];
    let inOwn = false;
    let enabledLine = null;
    for (const line of lines) {
      if (/^\s*\[/.test(line)) inOwn = ownTables.test(line.trim());
      if (inOwn) {
        if (/^\s*enabled\s*=/.test(line)) enabledLine = line.trim();
        continue;
      }
      kept.push(line);
    }

    // TOML basic strings use JSON-compatible escapes, so JSON.stringify yields a valid quoted path.
    const block = [
      header,
      `command = "node"`,
      `args = [${JSON.stringify(stdioPath)}]`,
      `startup_timeout_sec = 120`,
      ...(enabledLine ? [enabledLine] : []),
      "",
      `[mcp_servers.${serverName}.env]`,
      `BRIDGE_REPO_ROOT = ${JSON.stringify(repoRoot)}`,
      "",
    ].join("\n");

    const rest = kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
    fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
    fs.writeFileSync(codexConfigPath, rest ? `${rest}\n\n${block}` : block, { encoding: "utf8" });
    console.log(`🔗 Codex: ${codexConfigPath}${enabledLine ? ` (kept "${enabledLine}")` : ""}`);
    return true;
  } catch (err) {
    console.error(`⚠️ Codex: failed to update ${codexConfigPath}: ${err.message}`);
    return false;
  }
}

// Antigravity reads one JSON schema per tool from its tool directory.
function writeAntigravitySchemas(tools) {
  try {
    fs.mkdirSync(antigravityToolDir, { recursive: true });
    const active = new Set(tools.map((t) => t.name));
    for (const file of fs.readdirSync(antigravityToolDir)) {
      if (file.endsWith(".json") && !active.has(path.basename(file, ".json"))) {
        fs.rmSync(path.join(antigravityToolDir, file));
        console.log(`🗑️ Removed stale tool schema: ${file}`);
      }
    }
    for (const tool of tools) {
      const schema = {
        name: tool.name,
        description: tool.description,
        parameters: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          properties: tool.inputSchema?.properties ?? {},
          required: tool.inputSchema?.required ?? [],
        },
      };
      fs.writeFileSync(path.join(antigravityToolDir, `${tool.name}.json`), JSON.stringify(schema), "utf8");
    }
    const instructions = path.join(repoRoot, "docs", "mcp-instructions.md");
    if (fs.existsSync(instructions)) fs.copyFileSync(instructions, path.join(antigravityToolDir, "instructions.md"));
    console.log(`📝 Antigravity: ${tools.length} tool schemas${fs.existsSync(instructions) ? " + instructions.md" : ""} in ${antigravityToolDir}`);
    return true;
  } catch (err) {
    console.error(`⚠️ Antigravity: failed to write tool schemas: ${err.message}`);
    return false;
  }
}
