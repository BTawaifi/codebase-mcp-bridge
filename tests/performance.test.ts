import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { IndexerService } from "../src/services/indexer.js";
import { RepoService } from "../src/services/repo.js";
import { SecurityService } from "../src/services/security.js";

type Measurement = { operation: string; durationMs: number; maxMs: number };
const STRICT_PERF_BUDGETS = process.env.BRIDGE_PERF_STRICT === "1";

async function createPerfRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-performance-"));
  await fs.mkdir(path.join(root, "src", "extended-live"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\ndist/\n", "utf8");
  await fs.writeFile(path.join(root, "src", "extended-live", "cache.ts"), [
    "export type LiveEvent = { occurrenceId: string; matchSecond: number };",
    "export function dedupeByOccurrenceId(events: LiveEvent[]) {",
    "  const seen = new Set<string>();",
    "  return events.filter((event) => !seen.has(event.occurrenceId) && Boolean(seen.add(event.occurrenceId)));",
    "}",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(root, "src", "extended-live", "consumer.ts"), [
    "import { dedupeByOccurrenceId } from './cache.js';",
    "export function reconnectCatchup(events) { return dedupeByOccurrenceId(events); }",
  ].join("\n"), "utf8");
  for (let i = 0; i < 80; i++) {
    await fs.writeFile(path.join(root, "src", `module-${i}.ts`), `export function helper${i}(value: number) { return value * 2; }\n`, "utf8");
  }
  return root;
}

async function measure<T>(measurements: Measurement[], operation: string, maxMs: number, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await fn();
  measurements.push({ operation, durationMs: Math.round((performance.now() - started) * 10) / 10, maxMs });
  return result;
}

test("core bridge services stay within broad performance budgets", async () => {
  const root = await createPerfRepo();
  const measurements: Measurement[] = [];
  try {
    const repo = new RepoService(root, new SecurityService(root));
    const indexer = new IndexerService(root, repo);

    const symbols = await measure(measurements, "indexer.buildIndex", 2_500, () => indexer.buildIndex());
    assert.ok(symbols.length > 0);

    const status = JSON.parse(await measure(measurements, "indexer.getIndexerStatus", 100, () => indexer.getIndexerStatus()));
    assert.equal(status.kind, "lexical-symbol-cache");
    assert.ok(status.files >= 1);
    assert.ok(status.symbols >= 1);

    const symbolSearch = JSON.parse(await measure(measurements, "indexer.searchSymbols", 150, () => indexer.searchSymbols("reconnect")));
    assert.ok(symbolSearch.matches.some((match: { name: string }) => match.name === "reconnectCatchup"));

    const callers = JSON.parse(await measure(measurements, "indexer.getCallers", 150, () => indexer.getCallers("dedupeByOccurrenceId")));
    assert.ok(callers.matches.some((match: { name: string }) => match.name === "reconnectCatchup"));

    const structured = JSON.parse(await measure(
      measurements,
      "repo.searchStructured",
      1_500,
      () => repo.searchStructured("dedupeByOccurrenceId", "src/**/*.ts", 1, undefined, undefined, { textOnly: true }),
    ));
    assert.ok(structured.matches.length >= 1);

    const batch = JSON.parse(await measure(measurements, "repo.searchBatch", 2_000, () => repo.searchBatch([
      { query: "dedupeByOccurrenceId", glob: "src/**/*.ts", contextLines: 1, textOnly: true },
      { query: "helper42", glob: "src/**/*.ts", contextLines: 1, textOnly: true },
    ])));
    assert.equal(batch.queries.length, 2);
    assert.equal(batch.queries[0].status, "ok");
    assert.equal(batch.queries[1].status, "ok");

    if (STRICT_PERF_BUDGETS) {
      assert.deepEqual(measurements.filter((item) => item.durationMs > item.maxMs), []);
    }
    console.log(`\nCodebase MCP performance profile:\n${JSON.stringify(measurements, null, 2)}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
