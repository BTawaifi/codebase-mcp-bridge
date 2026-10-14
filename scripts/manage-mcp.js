import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const action = process.argv[2];
if (action !== "install" && action !== "uninstall") {
  console.error("Usage: node scripts/manage-mcp.js [install|uninstall]");
  process.exit(1);
}

const repoRoot = path.resolve(".");
const stdioPath = path.join(repoRoot, "dist", "stdio.js").replace(/\\/g, "\\\\");
const serverName = "codebase-mcp-bridge";

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

// 2. Claude CLI (Claude Code) Config Path
const getClaudeCLIPath = () => {
  return path.join(os.homedir(), ".claude", "config.json");
};

// 3. Cursor Config Path
const getCursorPath = () => {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || "", "Cursor", "User", "globalStorage", "storage.json");
  } else if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "storage.json");
  } else {
    return path.join(os.homedir(), ".config", "Cursor", "User", "globalStorage", "storage.json");
  }
};

const manageClaudeConfig = (configPath) => {
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
          BRIDGE_REPO_ROOT: repoRoot.replace(/\\/g, "\\\\")
        }
      };
      console.log(`✅ Registered in Claude Config: ${configPath}`);
    } else {
      delete config.mcpServers[serverName];
      console.log(`❌ Unregistered from Claude Config: ${configPath}`);
    }

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  } catch (err) {
    console.error(`⚠️ Failed to update Claude Config at ${configPath}: ${err.message}`);
  }
};

const manageCursorConfig = (configPath) => {
  if (action === "uninstall" && !fs.existsSync(configPath)) return;

  try {
    let config = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    }

    // Cursor stores custom MCP servers under the "mcp.mcpServers" key in globalStorage
    if (action === "install") {
      const currentServers = config["mcp.mcpServers"] || {};
      currentServers[serverName] = {
        name: serverName,
        type: "stdio",
        command: "node",
        args: [stdioPath],
        env: {
          BRIDGE_REPO_ROOT: repoRoot.replace(/\\/g, "\\\\")
        },
        enabled: true
      };
      config["mcp.mcpServers"] = currentServers;
      console.log(`✅ Registered in Cursor Config: ${configPath}`);
    } else {
      if (config["mcp.mcpServers"]) {
        delete config["mcp.mcpServers"][serverName];
        console.log(`❌ Unregistered from Cursor Config: ${configPath}`);
      }
    }

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  } catch (err) {
    console.error(`⚠️ Failed to update Cursor Config at ${configPath}: ${err.message}`);
  }
};

// Run the script
console.log(`\n--- Codebase MCP Bridge Registry Setup (${action.toUpperCase()}) ---\n`);

manageClaudeConfig(getClaudeDesktopPath());
manageClaudeConfig(getClaudeCLIPath());
manageCursorConfig(getCursorPath());

console.log("\n--- Setup Complete ---\n");
