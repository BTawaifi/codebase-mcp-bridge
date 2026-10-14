import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const action = process.argv[2];
if (action !== "install" && action !== "uninstall") {
  console.error("Usage: node scripts/manage-mcp.js [install|uninstall]");
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Plain paths: JSON.stringify escapes backslashes itself, so pre-escaping would store "C:\\\\..." on Windows.
const stdioPath = path.join(repoRoot, "dist", "stdio.js");
const serverName = "codebase-mcp-bridge";

if (action === "install" && !fs.existsSync(stdioPath)) {
  console.warn(`⚠️ ${stdioPath} does not exist yet. Run "npm run build" before starting a client.`);
}

// 1. Claude Desktop Config Path
const getClaudeDesktopPath = () => {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json");
  } else if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  } else {
    return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
  }
};

// 2. Claude Code user config (top-level "mcpServers" in ~/.claude.json)
const getClaudeCLIPath = () => {
  return path.join(os.homedir(), ".claude.json");
};

// 3. Cursor global MCP config (same "mcpServers" shape as Claude)
const getCursorPath = () => {
  return path.join(os.homedir(), ".cursor", "mcp.json");
};

const manageMcpServersConfig = (configPath, label) => {
  if (action === "uninstall" && !fs.existsSync(configPath)) return;

  try {
    let config = { mcpServers: {} };
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
    if (!config.mcpServers) config.mcpServers = {};

    if (action === "install") {
      config.mcpServers[serverName] = {
        command: "node",
        args: [stdioPath],
        env: {
          BRIDGE_REPO_ROOT: repoRoot
        }
      };
      console.log(`✅ Registered in ${label}: ${configPath}`);
    } else {
      delete config.mcpServers[serverName];
      console.log(`❌ Unregistered from ${label}: ${configPath}`);
    }

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  } catch (err) {
    console.error(`⚠️ Failed to update ${label} at ${configPath}: ${err.message}`);
  }
};

// Run the script
console.log(`\n--- Codebase MCP Bridge Registry Setup (${action.toUpperCase()}) ---\n`);

manageMcpServersConfig(getClaudeDesktopPath(), "Claude Desktop");
manageMcpServersConfig(getClaudeCLIPath(), "Claude Code");
manageMcpServersConfig(getCursorPath(), "Cursor");

console.log("\n--- Setup Complete ---\n");
