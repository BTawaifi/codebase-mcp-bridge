import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBridgeServer, createBridgeServices } from "../src/createBridgeServer.js";
import { RepoService } from "../src/services/repo.js";
import { WorkspaceService } from "../src/services/workspaces.js";
import { registeredTool } from "./helpers/mcp.js";

test("code.search runs batched queries concurrently with a bounded worker pool and preserves order", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-search-concurrency-"));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-search-concurrency-state-"));
  const workspaces = new WorkspaceService(stateRoot);
  await workspaces.trustWorkspace({ id: "repo", path: root });

  const originalSearch = RepoService.prototype.searchStructured;
  let active = 0;
  let maxActive = 0;

  RepoService.prototype.searchStructured = async function searchStructured(query: string) {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return JSON.stringify({ query });
    } finally {
      active -= 1;
    }
  } as RepoService["searchStructured"];

  try {
    const server = createBridgeServer(createBridgeServices(root, workspaces));
    const queries = Array.from({ length: 10 }, (_, index) => ({ query: `needle-${index}` }));
    const response = await registeredTool(server, "code.search")({
      workspaceId: "repo",
      queries,
    }) as unknown as { content: Array<{ text: string }>; isError?: boolean };

    assert.equal(response.isError, undefined);
    assert.ok(maxActive > 1, `expected parallel search execution, observed max concurrency ${maxActive}`);
    assert.ok(maxActive <= 4, `expected at most 4 concurrent searches, observed ${maxActive}`);

    const payload = JSON.parse(response.content[0].text) as {
      results: Array<{ query: string }>;
    };
    assert.deepEqual(
      payload.results.map((entry) => entry.query),
      queries.map((entry) => entry.query),
    );
  } finally {
    RepoService.prototype.searchStructured = originalSearch;
  }
});
