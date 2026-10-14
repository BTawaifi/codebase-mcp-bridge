import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IndexerService, parseFileSymbols } from "../src/services/indexer.js";
import { RepoService } from "../src/services/repo.js";
import { SecurityService } from "../src/services/security.js";

async function createRepo(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("parseFileSymbols extracts TS classes, methods, functions, and lexical references", () => {
  const symbols = parseFileSymbols("src/user.ts", `
// User service
class UserService {
  // Lookup
  async getUser(id) {
    return await db.query(id);
  }
}
function helper() { return getUser(1); }
`);

  const userService = symbols.find((symbol) => symbol.name === "UserService");
  const getUser = symbols.find((symbol) => symbol.name === "getUser");
  const helper = symbols.find((symbol) => symbol.name === "helper");
  assert.ok(userService && getUser && helper);
  assert.equal(userService.kind, "class");
  assert.equal(getUser.kind, "method");
  assert.ok(getUser.references.includes("db"));
  assert.ok(getUser.references.includes("query"));
  assert.ok(helper.references.includes("getUser"));
});

test("parseFileSymbols extracts Python definitions", () => {
  const symbols = parseFileSymbols("src/user.py", `
class UserService:
    def getUser(self, id):
        return db.query(id)

def helper():
    return getUser(1)
`);
  assert.equal(symbols.some((symbol) => symbol.name === "UserService" && symbol.kind === "class"), true);
  assert.equal(symbols.some((symbol) => symbol.name === "getUser" && symbol.kind === "method"), true);
  assert.equal(symbols.some((symbol) => symbol.name === "helper" && symbol.kind === "function"), true);
});

test("IndexerService maintains only an incremental symbol cache", async () => {
  const root = await createRepo("bridge-symbol-cache-");
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    const file = path.join(root, "src", "service.ts");
    await fs.writeFile(file, "export function firstHelper() { return 1; }\n", "utf8");

    const repo = new RepoService(root, new SecurityService(root));
    const indexer = new IndexerService(root, repo);
    await indexer.buildIndex();

    assert.equal(JSON.parse(await indexer.searchSymbols("firstHelper")).matches[0].name, "firstHelper");
    const firstStatus = JSON.parse(await indexer.getIndexerStatus());
    assert.equal(firstStatus.kind, "lexical-symbol-cache");
    assert.ok(firstStatus.files >= 1);
    assert.ok(firstStatus.symbols >= 1);

    await assert.rejects(fs.stat(path.join(root, ".ai-bridge", "index.json")), /ENOENT/);
    await fs.stat(path.join(root, ".ai-bridge", "symbols.json"));
    await fs.stat(path.join(root, ".ai-bridge", "symbol-manifest.json"));

    await fs.writeFile(file, "export function secondHelper() { return 2; }\n", "utf8");
    await indexer.buildIndex();
    assert.equal(JSON.parse(await indexer.searchSymbols("secondHelper")).matches[0].name, "secondHelper");
    assert.deepEqual(JSON.parse(await indexer.searchSymbols("firstHelper")).matches, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("IndexerService excludes secret-bearing source files from the symbol cache", async () => {
  const root = await createRepo("bridge-secret-symbol-cache-");
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    const fakeSecret = ['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
    await fs.writeFile(
      path.join(root, "src", "leaky.ts"),
      `export function hiddenHelper() { return "${fakeSecret}"; }\n`,
      "utf8",
    );
    await fs.writeFile(path.join(root, "src", "safe.ts"), "export function safeHelper() { return 1; }\n", "utf8");

    const indexer = new IndexerService(root, new RepoService(root, new SecurityService(root)));
    await indexer.buildIndex();

    assert.deepEqual(JSON.parse(await indexer.searchSymbols("hiddenHelper")).matches, []);
    assert.equal(JSON.parse(await indexer.searchSymbols("safeHelper")).matches[0].name, "safeHelper");
    const manifest = JSON.parse(await fs.readFile(path.join(root, ".ai-bridge", "symbol-manifest.json"), "utf8"));
    assert.equal(manifest["src/leaky.ts"].blocked, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("reference queries are explicitly lexical approximations", async () => {
  const root = await createRepo("bridge-reference-cache-");
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "db.ts"), "export function query(id) { return id; }\n", "utf8");
    await fs.writeFile(path.join(root, "src", "user.ts"), `
import { query } from './db.js';
export function getUser(id) { return query(id); }
export function handler(id) { return getUser(id); }
`, "utf8");

    const indexer = new IndexerService(root, new RepoService(root, new SecurityService(root)));
    await indexer.buildIndex();

    const callers = JSON.parse(await indexer.getCallers("query"));
    assert.ok(callers.matches.some((match: { name: string }) => match.name === "getUser"));
    assert.equal(callers.matches.some((match: { kind: string }) => match.kind === "other"), false);

    const callees = JSON.parse(await indexer.getCallees("handler"));
    assert.ok(callees.matches.some((match: { name: string }) => match.name === "getUser"));

    const impact = JSON.parse(await indexer.getImpactRadius("query", 3));
    assert.ok(impact.matches.some((match: { name: string }) => match.name === "getUser"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Go symbols participate in the same symbol cache and lexical references", async () => {
  const root = await createRepo("bridge-go-symbol-cache-");
  try {
    await fs.mkdir(path.join(root, "src", "live"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "live", "processor.go"), `package live

type Processor struct{}

func Calculate(event Event) Event { return event }

func (p *Processor) Handle(event Event) Event {
  return Calculate(event)
}
`, "utf8");

    const parsed = parseFileSymbols("src/live/processor.go", await fs.readFile(path.join(root, "src", "live", "processor.go"), "utf8"));
    assert.equal(parsed.some((symbol) => symbol.name === "Processor"), true);
    assert.equal(parsed.some((symbol) => symbol.name === "Handle" && symbol.kind === "method"), true);

    const indexer = new IndexerService(root, new RepoService(root, new SecurityService(root)));
    await indexer.buildIndex();
    assert.equal(JSON.parse(await indexer.searchSymbols("Handle")).matches[0].name, "Handle");
    assert.ok(JSON.parse(await indexer.getCallers("Calculate")).matches.some((match: { name: string }) => match.name === "Handle"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
