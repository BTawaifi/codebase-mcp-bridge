import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createBridgeServer, createBridgeServices } from "../src/createBridgeServer.js";
import { WorkspaceService } from "../src/services/workspaces.js";
import { registeredTool } from "./helpers/mcp.js";

const execFileAsync = promisify(execFile);

async function createGitRepo(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await execFileAsync("git", ["init"], { cwd: root });
  await fs.writeFile(path.join(root, "README.md"), `# ${prefix}\n`, "utf8");
  return root;
}

async function setupTwoWorkspaces() {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-workspace-state-"));
  const firstRoot = await createGitRepo("bridge-workspace-first-");
  const secondRoot = await createGitRepo("bridge-workspace-second-");
  const workspaces = new WorkspaceService(stateRoot);
  await workspaces.trustWorkspace({ id: "first", name: "first", path: firstRoot });
  await workspaces.trustWorkspace({ id: "second", name: "second", path: secondRoot });
  const services = createBridgeServices(firstRoot, workspaces);
  return { stateRoot, firstRoot, secondRoot, workspaces, server: createBridgeServer(services) };
}

test("workspaceId routes writes without any active-workspace state", async () => {
  const { server, firstRoot, secondRoot } = await setupTwoWorkspaces();

  const result = await registeredTool(server, "code.write")({
    workspaceId: "second",
    path: "src/created.txt",
    content: "second-only\n",
  });
  assert.match(result.content[0].text, /Wrote src[/\\]created\.txt/);
  await assert.rejects(fs.readFile(path.join(firstRoot, "src", "created.txt"), "utf8"), /ENOENT/);
  assert.equal(await fs.readFile(path.join(secondRoot, "src", "created.txt"), "utf8"), "second-only\n");

  const list = JSON.parse((await registeredTool(server, "workspace.list")({})).content[0].text);
  assert.equal("activeWorkspaceId" in list, false);
});

test("omitting workspaceId deterministically targets the startup repository", async () => {
  const { server, firstRoot } = await setupTwoWorkspaces();
  await fs.mkdir(path.join(firstRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(firstRoot, "src", "default.txt"), "startup-default\n", "utf8");

  const read = await registeredTool(server, "code.read")({ files: [{ path: "src/default.txt" }] });
  const payload = JSON.parse(read.content[0].text);
  assert.equal(payload.files[0].content, "startup-default\n");

  const status = JSON.parse((await registeredTool(server, "workspace.status")({})).content[0].text);
  assert.equal(path.resolve(status.path), path.resolve(firstRoot));
  assert.equal(status.defaultWorkspace, true);
});

test("unknown workspaceId is a real MCP tool error", async () => {
  const { server } = await setupTwoWorkspaces();
  const result = await registeredTool(server, "code.read")({
    workspaceId: "missing",
    files: [{ path: "README.md" }],
  }) as unknown as { content: { text: string }[]; isError?: boolean };

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown or untrusted workspaceId: missing/);
});

test("symbol caches are refreshed and isolated by workspaceId", async () => {
  const { server, firstRoot, secondRoot } = await setupTwoWorkspaces();
  await fs.mkdir(path.join(firstRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(secondRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(firstRoot, "src", "math.ts"), "export function firstOnlyHelper() { return 1; }\n", "utf8");
  await fs.writeFile(path.join(secondRoot, "src", "math.ts"), "export function secondOnlyHelper() { return 2; }\n", "utf8");

  const second = await registeredTool(server, "code.symbols")({ workspaceId: "second", query: "secondOnlyHelper" });
  const secondPayload = JSON.parse(second.content[0].text);
  assert.equal(secondPayload.matches[0].name, "secondOnlyHelper");

  const first = await registeredTool(server, "code.symbols")({ workspaceId: "first", query: "secondOnlyHelper" });
  const firstPayload = JSON.parse(first.content[0].text);
  assert.deepEqual(firstPayload.matches, []);
});

test("workspace.status and git.status expose separate fact domains", async () => {
  const { server, secondRoot } = await setupTwoWorkspaces();

  const workspace = JSON.parse((await registeredTool(server, "workspace.status")({ workspaceId: "second" })).content[0].text);
  assert.equal(path.resolve(workspace.path), path.resolve(secondRoot));
  assert.equal(workspace.kind, "git");
  assert.equal("branch" in workspace, false);
  assert.equal("staged" in workspace, false);

  const git = JSON.parse((await registeredTool(server, "git.status")({ workspaceId: "second" })).content[0].text);
  assert.equal(typeof git.branch, "string");
  assert.equal(Array.isArray(git.untracked), true);
});
