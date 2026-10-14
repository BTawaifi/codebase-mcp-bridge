import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBridgeServer, createBridgeServices } from "../src/createBridgeServer.js";
import { resetRipgrepPathCache } from "../src/services/ripgrep.js";
import { registeredTool } from "./helpers/mcp.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-upgrades-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"));
  const services = createBridgeServices(root);
  return { root, services, server: createBridgeServer(services) };
}

test("default services honor BRIDGE_REPO_ROOT instead of the launcher cwd", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-repo-root-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = process.env.BRIDGE_REPO_ROOT;
  process.env.BRIDGE_REPO_ROOT = root;
  try {
    assert.equal(createBridgeServices().repoRoot, path.resolve(root));
  } finally {
    if (previous === undefined) delete process.env.BRIDGE_REPO_ROOT;
    else process.env.BRIDGE_REPO_ROOT = previous;
  }
});

test("code.search mixes paginated file discovery with existing text queries", async (t) => {
  const { root, server, services } = await fixture(t);
  for (const name of ["a", "b", "c"]) {
    await fs.writeFile(path.join(root, "src", `${name}.ts`), "export const needle = 1;\n");
  }
  const search = registeredTool(server, "code.search");
  const first = JSON.parse((await search({ queries: [
    { mode: "files", query: "src/**/*.ts", maxMatches: 2 },
    { query: "needle", maxMatches: 1 },
  ] })).content[0].text);
  assert.deepEqual(first.results[0].files.map((file: { path: string }) => file.path), ["src/a.ts", "src/b.ts"]);
  assert.equal(first.results[0].nextOffset, 2);
  assert.equal(first.results[0].truncated, true);
  assert.equal(first.results[1].matches.length, 1);
  const last = JSON.parse((await search({ queries: [{ mode: "files", query: "src/**/*.ts", offset: 2, maxMatches: 2 }] })).content[0].text);
  assert.equal(last.results[0].files[0].path, "src/c.ts");
  assert.equal(last.results[0].nextOffset, null);
  assert.equal(last.results[0].truncated, false);
  for (const pattern of ["../*", "C:/outside/*", "/outside/*"]) {
    await assert.rejects(services.repo.findFiles(pattern), /repository root/);
  }
});

test("MCP transport publishes and validates both search modes", async (t) => {
  const { root, server } = await fixture(t);
  await fs.writeFile(path.join(root, "src", "a.ts"), "needle\n");
  const client = new Client({ name: "upgrade-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listing = await client.listTools();
    assert.equal(listing.tools.length, 16);
    assert.match(JSON.stringify(listing.tools.find((tool) => tool.name === "code.search")?.inputSchema), /files/);
    assert.match(listing.tools.find((tool) => tool.name === "code.patch")?.description ?? "", /--- a\/<path>.*\+\+\+ b\/<path>/s);
    const response = await client.callTool({ name: "code.search", arguments: { queries: [
      { mode: "files", query: "src/*.ts" }, { query: "needle" },
    ] } });
    assert.notEqual(response.isError, true);
    const content = response.content as Array<{ text: string }>;
    assert.equal(JSON.parse(content[0].text).results[0].files[0].path, "src/a.ts");
    const largeSearch = await client.callTool({ name: "code.search", arguments: {
      queries: [{ query: "needle", maxMatches: 500 }],
    } });
    assert.notEqual(largeSearch.isError, true);
    const references = await client.callTool({ name: "code.references", arguments: {
      symbolName: "needle", direction: "incoming", maxDepth: 2,
    } });
    assert.notEqual(references.isError, true);
    await fs.writeFile(path.join(root, "print-args.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n", "utf8");
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node print-args.mjs" } }), "utf8");
    const validation = await client.callTool({ name: "validation.run", arguments: {
      commandIds: ["test:unit"], args: ["--test-name-pattern", "MCP transport"], failuresOnly: false,
    } });
    assert.notEqual(validation.isError, true);
    const invalid = await client.callTool({ name: "code.search", arguments: { queries: [{ mode: "files", query: "*", offset: -1 }] } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("code.search bounds combined context while retaining sibling result records", async (t) => {
  const { server, services } = await fixture(t);
  t.mock.method(services.repo, "searchStructured", async (query: string) => JSON.stringify({
    query, truncated: false,
    matches: Array.from({ length: 50 }, (_, line) => ({
      path: "src/a.ts", line: line + 1, column: 1, text: "x".repeat(1000),
      context: { before: Array.from({ length: 20 }, (_, i) => ({ line: i + 1, text: "y".repeat(1000) })), after: [] },
    })),
  }));
  const response = await registeredTool(server, "code.search")({ queries: Array.from({ length: 10 }, (_, i) => ({ query: String(i) })) });
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.outputLimited, true);
  assert.equal(payload.results.length, 10);
  assert.ok(response.content[0].text.length < 350_000);
  assert.equal(payload.results[9].truncated, true);
  assert.equal(payload.results[9].matches.length, 0);
});

test("deletion and rollback reject sensitive paths before changing files", async (t) => {
  const { root, services } = await fixture(t);
  await fs.writeFile(path.join(root, ".env"), "UNCHANGED=true\n");
  await assert.rejects(services.patches.deletePath(".env"), /blocked from mutation/);
  await assert.rejects(services.patches.rollbackOperation("../outside"), /Invalid ID/);
  const rollbackDir = path.join(root, ".ai-bridge", "rollback");
  await fs.mkdir(rollbackDir, { recursive: true });
  await fs.writeFile(path.join(rollbackDir, "unsafe.json"), JSON.stringify({ files: [{ path: ".env", existed: false }] }));
  await assert.rejects(services.patches.rollbackOperation("unsafe"), /blocked from mutation/);
  assert.equal(await fs.readFile(path.join(root, ".env"), "utf8"), "UNCHANGED=true\n");
});

test("index invalidation during a build is not overwritten by the freshness window", async (t) => {
  const { services } = await fixture(t);
  await services.indexer.buildIndex();
  let finish!: (value: []) => void;
  let builds = 0;
  t.mock.method(services.indexer, "buildIndex", async () => {
    builds += 1;
    if (builds === 1) return new Promise<[]>((resolve) => { finish = resolve; });
    return [];
  });
  const pending = services.indexer.ensureFreshIndex(60_000);
  services.indexer.markStale();
  finish([]);
  await pending;
  await services.indexer.ensureFreshIndex(60_000);
  assert.equal(builds, 2);
});

test("impact traversal preserves breadth-first depths and visits each reference list once", async (t) => {
  const { services } = await fixture(t);
  let reads = 0;
  const symbols = Array.from({ length: 100 }, (_, i) => ({
    filePath: "src/chain.ts", name: `f${i}`, kind: "function" as const,
    startLine: i + 1, endLine: i + 1, signature: "", code: "",
    get references() { reads += 1; return [`f${i - 1}`]; },
  }));
  t.mock.method(services.indexer, "loadSymbols", async () => symbols);
  const result = JSON.parse(await services.indexer.getImpactRadius("f0", 10));
  assert.deepEqual(result.matches.map((match: { name: string; depth: number }) => [match.name, match.depth]),
    Array.from({ length: 10 }, (_, i) => [`f${i + 1}`, i + 1]));
  assert.equal(reads, 100);
});

test("symbol search explicitly reports omitted matches", async (t) => {
  const { root, services } = await fixture(t);
  await fs.writeFile(path.join(root, "src", "symbols.ts"), "export function helperA() {}\nexport function helperB() {}\n");
  await services.indexer.ensureFreshIndex();
  assert.equal(JSON.parse(await services.indexer.searchSymbols("helper", undefined, 1)).truncated, true);
  assert.equal(JSON.parse(await services.indexer.searchSymbols("helper", undefined, 2)).truncated, false);
});

test("ripgrep buffer exhaustion reports partial results even below the match cap", async (t) => {
  const { root, services } = await fixture(t);
  for (let i = 0; i < 12; i += 1) {
    await fs.writeFile(path.join(root, "src", `${i}.txt`), `needle ${"x".repeat(240_000)}\n`);
  }
  const result = JSON.parse(await services.repo.searchStructured("needle", "src/*.txt"));
  assert.equal(result.backend, "rg");
  assert.ok(result.matches.length > 0 && result.matches.length < 12);
  assert.equal(result.truncated, true);
});

test("file discovery keeps dotfiles, prunes excluded directories and honours tree depth", async (t) => {
  const { root, services } = await fixture(t);
  await fs.mkdir(path.join(root, "src", ".config", "deep"), { recursive: true });
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "src", ".config", "a.ts"), "x\n");
  await fs.writeFile(path.join(root, "src", ".config", "deep", "b.ts"), "x\n");
  await fs.writeFile(path.join(root, "src", "c.js"), "x\n");
  await fs.writeFile(path.join(root, "dist", "out.ts"), "x\n");
  await fs.writeFile(path.join(root, ".gitignore"), "ignored-dir/\n");
  await fs.mkdir(path.join(root, "ignored-dir"));
  await fs.writeFile(path.join(root, "ignored-dir", "d.ts"), "x\n");

  const files = (pattern: string) => services.repo.findFiles(pattern).then((r) => JSON.parse(r).files.map((f: { path: string }) => f.path));
  assert.deepEqual(await files("**/*.ts"), ["src/.config/a.ts", "src/.config/deep/b.ts"]);
  assert.deepEqual(await files("src/*.{js,ts}"), ["src/c.js"]);
  assert.deepEqual((await services.repo.tree(2)).split("\n"), [".gitignore", "src", "src/.config", "src/c.js"]);
});

test("native search and discovery cannot follow a directory outside the repository", async (t) => {
  const { root, services } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "outside.ts"), "externalNeedle\n");
  await fs.symlink(outside, path.join(root, "src", "linked"), process.platform === "win32" ? "junction" : "dir");
  const fake = path.join(root, "unusable-rg.exe");
  await fs.writeFile(fake, "");
  const previous = process.env.BRIDGE_RG_PATH;
  process.env.BRIDGE_RG_PATH = fake;
  resetRipgrepPathCache();
  t.after(async () => {
    if (previous === undefined) delete process.env.BRIDGE_RG_PATH;
    else process.env.BRIDGE_RG_PATH = previous;
    resetRipgrepPathCache();
  });
  const result = JSON.parse(await services.repo.searchStructured("externalNeedle", "src/**/*.ts"));
  assert.equal(result.backend, "native");
  assert.deepEqual(result.matches, []);
  assert.deepEqual(JSON.parse(await services.repo.findFiles("src/**/*.ts")).files, []);
});
