import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const repoRoot = path.resolve(".");
const stdioPath = path.join(repoRoot, "dist", "stdio.js");
const serverName = "codebase-mcp-bridge";

// Config paths
const geminiConfigPath   = path.join(os.homedir(), ".gemini", "config", "mcp_config.json");
const geminiDestDir      = path.join(os.homedir(), ".gemini", "antigravity-cli", "mcp", "codebase-mcp-bridge");
const claudeDesktopPath  = path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "Claude", "claude_desktop_config.json");
const claudeCLIPath      = path.join(os.homedir(), ".claude", "config.json");
const codexConfigPath    = path.join(os.homedir(), ".codex", "config.toml");

console.log(`\n--- Populating Antigravity MCP Tool Schemas ---\n`);
console.log(`Destination: ${geminiDestDir}`);

// 1. Start the compiled stdio server in a child process
const serverProcess = spawn("node", ["dist/stdio.js"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    BRIDGE_REPO_ROOT: repoRoot
  }
});

let buffer = "";

serverProcess.stdout.on("data", (data) => {
  buffer += data.toString();
  // Check if we received the complete JSON-RPC response
  if (buffer.includes("\n")) {
    try {
      const response = JSON.parse(buffer.trim());
      if (response.result && response.result.tools) {
        registerGeminiServer();
        registerClaudeServer(claudeDesktopPath, "Claude Desktop");
        registerClaudeServer(claudeCLIPath, "Claude CLI");
        registerCodexServer();
        writeSchemas(response.result.tools);
      } else {
        console.error("⚠️ Invalid response received:", response);
      }
    } catch (err) {
      console.error("⚠️ Failed to parse response:", err.message);
    } finally {
      serverProcess.kill();
      process.exit(0);
    }
  }
});

serverProcess.stderr.on("data", (data) => {
  // Silence regular warnings or stdout spam from standard server boot logs
});

serverProcess.on("close", () => {
  console.log("\n--- Done ---\n");
});

// 2. Send the JSON-RPC list request to the stdin channel of the server
const request = {
  jsonrpc: "2.0",
  method: "tools/list",
  params: {},
  id: 1
};

serverProcess.stdin.write(JSON.stringify(request) + "\n");

// Helper: read a JSON file, stripping BOM if present
function readJsonSafe(filePath) {
  const raw = fs.readFileSync(filePath);
  const text = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
    ? raw.slice(3).toString("utf8")
    : raw.toString("utf8");
  return JSON.parse(text);
}

// Helper: write JSON without BOM
function writeJsonSafe(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), { encoding: "utf8" });
}

// 3a. Register in Antigravity mcp_config.json (idempotent, BOM-safe)
function registerGeminiServer() {
  try {
    let config = { mcpServers: {} };
    if (fs.existsSync(geminiConfigPath)) config = readJsonSafe(geminiConfigPath);
    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers[serverName] = {
      command: "node",
      args: [stdioPath],
      env: { BRIDGE_REPO_ROOT: repoRoot }
    };
    writeJsonSafe(geminiConfigPath, config);
    console.log(`🔗 Registered server in: ${geminiConfigPath}`);
  } catch (err) {
    console.error(`⚠️ Failed to register in Antigravity config: ${err.message}`);
  }
}

// 3b. Register in Claude Desktop or Claude CLI config (both use identical JSON mcpServers format)
function registerClaudeServer(configPath, label) {
  try {
    let config = { mcpServers: {} };
    if (fs.existsSync(configPath)) config = readJsonSafe(configPath);
    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers[serverName] = {
      command: "node",
      args: [stdioPath],
      env: { BRIDGE_REPO_ROOT: repoRoot }
    };
    writeJsonSafe(configPath, config);
    console.log(`🔗 Registered server in: ${configPath} (${label})`);
  } catch (err) {
    console.error(`⚠️ Failed to register in ${label} config: ${err.message}`);
  }
}

// 3c. Register in Codex config.toml — upserts [mcp_servers.<name>] block, leaves rest untouched
function registerCodexServer() {
  try {
    const header = `[mcp_servers.${serverName}]`;
    const block = [
      header,
      `args = ['${stdioPath.replace(/\\/g, "\\\\").replace(/'/g, "\\'")  }']`,
      `command = "node"`,
      `startup_timeout_sec = 120`,
      `[mcp_servers.${serverName}.env]`,
      `BRIDGE_REPO_ROOT = '${repoRoot.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'
`
    ].join("\n");

    let toml = fs.existsSync(codexConfigPath)
      ? fs.readFileSync(codexConfigPath, "utf8")
      : "";

    // Remove existing block for this server (from header to next top-level section)
    const sectionRe = new RegExp(
      `\\[mcp_servers\\.${serverName}\\][\\s\\S]*?(?=\\n\\[(?!mcp_servers\\.${serverName})|$)`,
      "g"
    );
    toml = toml.replace(sectionRe, "").replace(/\n{3,}/g, "\n\n").trimEnd();

    toml = toml ? toml + "\n\n" + block : block;

    fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
    fs.writeFileSync(codexConfigPath, toml, { encoding: "utf8" });
    console.log(`🔗 Registered server in: ${codexConfigPath} (Codex)`);
  } catch (err) {
    console.error(`⚠️ Failed to register in Codex config: ${err.message}`);
  }
}

// 4. Write each schema to a separate JSON file in the Antigravity directory
function writeSchemas(tools) {
  try {
    if (!fs.existsSync(geminiDestDir)) {
      fs.mkdirSync(geminiDestDir, { recursive: true });
    }

    // Keep track of current tool names to remove any deleted ones
    const activeToolNames = new Set(tools.map(t => t.name));

    // Remove deleted schemas
    const existingFiles = fs.readdirSync(geminiDestDir);
    for (const file of existingFiles) {
      if (file.endsWith(".json")) {
        const toolName = path.basename(file, ".json");
        if (!activeToolNames.has(toolName)) {
          fs.rmSync(path.join(geminiDestDir, file));
          console.log(`🗑️ Removed stale tool: ${file}`);
        }
      }
    }

    // Write active schemas
    for (const tool of tools) {
      const filePath = path.join(geminiDestDir, `${tool.name}.json`);
      const schema = {
        name: tool.name,
        description: tool.description,
        parameters: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          properties: tool.inputSchema.properties || {},
          required: tool.inputSchema.required || []
        }
      };

      fs.writeFileSync(filePath, JSON.stringify(schema), "utf8");
      console.log(`📝 Generated schema: ${tool.name}.json`);
    }

    // Write instructions.md if it exists in docs/
    const srcInstructions = path.join(repoRoot, "docs", "mcp-instructions.md");
    if (fs.existsSync(srcInstructions)) {
      const destInstructions = path.join(geminiDestDir, "instructions.md");
      fs.copyFileSync(srcInstructions, destInstructions);
      console.log(`📝 Copied instructions.md to Gemini destination`);
    }

    console.log(`\n✅ Successfully populated ${tools.length} tool schemas in Antigravity configuration!`);
  } catch (err) {
    console.error("⚠️ Failed to write tool schemas:", err.message);
  }
}
