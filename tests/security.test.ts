import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createBridgeServer, createBridgeServices } from "../src/createBridgeServer.js";
import { RepoService } from "../src/services/repo.js";
import { SecurityService } from "../src/services/security.js";
import { WorkspaceService } from "../src/services/workspaces.js";
import { registeredTool } from "./helpers/mcp.js";
import { withEnv } from "./helpers/env.js";

async function createRepo(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "safe.ts"), "export const safe = true;\n", "utf8");
  return root;
}

test("repository reads cannot escape the trusted root", async () => {
  const root = await createRepo("bridge-security-read-");
  const repo = new RepoService(root, new SecurityService(root));
  await assert.rejects(() => repo.readFile("../outside.txt"), /outside|escape|root/i);
  assert.match(await repo.readFile("src/safe.ts"), /safe = true/);
});

test("repository paths cannot escape through symlinked directories", async () => {
  const root = await createRepo("bridge-security-symlink-");
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-security-outside-"));
  await fs.writeFile(path.join(outside, "outside.ts"), "export const outside = true;\n", "utf8");
  const link = path.join(root, "src", "linked");
  await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");

  const repo = new RepoService(root, new SecurityService(root));
  await assert.rejects(() => repo.readFile("src/linked/outside.ts"), /symbolic link|escape/i);

  const patches = createBridgeServices(root).patches;
  await assert.rejects(() => patches.writeFile("src/linked/new.ts", "export const nope = true;\n"), /symbolic link|escape/i);
});

test("excluded operational and secret-bearing paths are not readable as source", async () => {
  const root = await createRepo("bridge-security-excluded-");
  await fs.writeFile(path.join(root, ".env"), "SECRET_VALUE=hidden\n", "utf8");
  const repo = new RepoService(root, new SecurityService(root));
  await assert.rejects(() => repo.readFile(".env"), /excluded|refusing|read/i);
});

test("test files do not bypass secret detection", async () => {
  const root = await createRepo("bridge-security-test-secret-");
  const security = new SecurityService(root);
  const fakeSecret = ['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
  assert.deepEqual(security.scanForSecrets(fakeSecret, "tests/example.test.ts"), ["OpenAI-style API key"]);
});

test("command.run is disabled unless the server operator opts in", async () => withEnv({
  BRIDGE_ENABLE_COMMAND_RUN: undefined,
}, async () => {
  const root = await createRepo("bridge-security-command-");
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-security-state-"));
  const workspaces = new WorkspaceService(stateRoot);
  await workspaces.trustWorkspace({ id: "repo", path: root });
  const server = createBridgeServer(createBridgeServices(root, workspaces));

  const result = await registeredTool(server, "command.run")({
    workspaceId: "repo",
    command: "echo should-not-run",
  }) as unknown as { content: { text: string }[]; isError?: boolean };

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /disabled by server configuration/);
}));
