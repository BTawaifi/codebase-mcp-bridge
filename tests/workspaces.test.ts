import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceService } from "../src/services/workspaces.js";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("workspace reads do not create registry state", async () => {
  const stateRoot = await tempDir("bridge-workspace-readonly-state-");
  const service = new WorkspaceService(stateRoot);

  const listed = JSON.parse(await service.listWorkspaces());
  assert.deepEqual(listed.workspaces, []);
  await assert.rejects(fs.stat(path.join(stateRoot, ".ai-bridge", "workspaces.json")), /ENOENT/);
});

test("workspace registry stores trust facts without active/open state", async () => {
  const stateRoot = await tempDir("bridge-workspace-state-");
  const repoRoot = await tempDir("bridge-workspace-repo-");
  await fs.mkdir(path.join(repoRoot, ".git"));

  const service = new WorkspaceService(stateRoot);
  const trusted = JSON.parse(await service.trustWorkspace({ path: repoRoot, name: "Example Repo" }));
  assert.equal(trusted.workspace.name, "Example Repo");
  assert.equal(trusted.workspace.path, repoRoot);
  assert.equal(trusted.workspace.kind, "git");
  assert.equal(typeof trusted.workspace.trustedAt, "string");
  assert.equal("lastOpenedAt" in trusted.workspace, false);

  const listed = JSON.parse(await service.listWorkspaces());
  assert.equal(listed.workspaces.length, 1);
  assert.equal(listed.workspaces[0].id, trusted.workspace.id);
  assert.equal("activeWorkspaceId" in listed, false);
  assert.ok(listed.instance.id);

  const untrusted = JSON.parse(await service.untrustWorkspace(trusted.workspace.id));
  assert.equal(untrusted.removed, true);
  assert.deepEqual(await service.getWorkspaceEntries(), []);
});

test("trusting the same path is idempotent and updates metadata", async () => {
  const stateRoot = await tempDir("bridge-workspace-state-");
  const dirRoot = await tempDir("bridge-workspace-directory-");
  const service = new WorkspaceService(stateRoot);

  const first = JSON.parse(await service.trustWorkspace({ path: dirRoot, name: "Notes" }));
  const second = JSON.parse(await service.trustWorkspace({ path: dirRoot, name: "Renamed Notes" }));

  assert.equal(second.alreadyTrusted, true);
  assert.equal(second.workspace.id, first.workspace.id);
  assert.equal(second.workspace.name, "Renamed Notes");
  assert.equal(second.workspace.kind, "directory");
  assert.equal((await service.getWorkspaceEntries()).length, 1);
});

test("legacy active-workspace fields are normalized in memory without mutating on read", async () => {
  const stateRoot = await tempDir("bridge-workspace-legacy-state-");
  const repoRoot = await tempDir("bridge-workspace-legacy-repo-");
  const bridgeDir = path.join(stateRoot, ".ai-bridge");
  await fs.mkdir(bridgeDir, { recursive: true });
  const legacyRegistry = JSON.stringify({
    instance: { id: "instance", name: "test", createdAt: new Date().toISOString(), hostname: "test" },
    activeWorkspaceId: "legacy",
    workspaces: [{
      id: "legacy",
      name: "Legacy",
      path: repoRoot,
      trustedAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
      kind: "directory",
    }],
  });
  await fs.writeFile(path.join(bridgeDir, "workspaces.json"), legacyRegistry, "utf8");

  const service = new WorkspaceService(stateRoot);
  const listed = JSON.parse(await service.listWorkspaces());
  assert.equal("activeWorkspaceId" in listed, false);
  assert.equal("lastOpenedAt" in listed.workspaces[0], false);

  assert.equal(await fs.readFile(path.join(bridgeDir, "workspaces.json"), "utf8"), legacyRegistry);
});
