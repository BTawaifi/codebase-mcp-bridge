import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { COMMAND_IDS } from "../src/config/commands.js";
import { classifyTool } from "../src/services/policy.js";

const expectedTools = [
  "workspace.list",
  "workspace.status",
  "code.search",
  "code.read",
  "code.symbols",
  "code.references",
  "code.patch",
  "code.write",
  "code.delete",
  "code.rollback",
  "git.status",
  "git.diff",
  "git.commit",
  "git.push",
  "validation.run",
  "command.run",
];

test("createBridgeServer exposes only the compact capability surface", async () => {
  const source = await readFile(new URL("../src/createBridgeServer.ts", import.meta.url), "utf8");
  const tools = registrations(source, "registerTool");
  const prompts = registrations(source, "registerPrompt");

  assert.deepEqual(duplicates(tools), []);
  assert.deepEqual([...tools].sort(), [...expectedTools].sort());
  assert.deepEqual(prompts, []);
  assert.equal(tools.length, 16);

  for (const obsolete of [
    "prepare_workspace_for_task",
    "semantic_search",
    "get_semantic_context",
    "pack_context",
    "start_agent_run",
    "approve_operation",
    "get_session_change_summary",
  ]) {
    assert.equal(tools.includes(obsolete), false, `${obsolete} must not re-enter the public surface`);
  }
});

test("public tool risk classification matches side effects", () => {
  for (const tool of [
    "workspace.list", "workspace.status", "code.search", "code.read",
    "code.symbols", "code.references", "git.status", "git.diff",
  ]) assert.equal(classifyTool(tool), "read_only", tool);

  for (const tool of ["code.patch", "code.write", "code.delete", "code.rollback", "git.commit", "validation.run"])
    assert.equal(classifyTool(tool), "reversible_write", tool);

  assert.equal(classifyTool("git.push"), "external_impact");
  assert.equal(classifyTool("command.run"), "high_risk");

  assert.equal(classifyTool("unknown.future.tool"), "high_risk");
});

test("destructive and external-impact public tools request host approval", async () => {
  const source = await readFile(new URL("../src/createBridgeServer.ts", import.meta.url), "utf8");
  for (const tool of ["code.delete", "code.rollback", "git.push", "command.run"]) {
    assert.match(registrationBlock(source, tool), /destructiveHint:\s*true/, tool);
  }
});

test("validation command schema is generated from command config", async () => {
  const source = await readFile(new URL("../src/createBridgeServer.ts", import.meta.url), "utf8");
  assert.match(source, /z\.enum\(COMMAND_IDS\)/);
  assert.ok(COMMAND_IDS.includes("script:ps-parse"));
});

function registrations(source: string, method: "registerTool" | "registerPrompt"): string[] {
  const live = stripComments(source);
  return [...live.matchAll(new RegExp(`server\\.${method}\\(\\s*[\"']([^\"']+)[\"']`, "g"))]
    .map((match) => match[1]);
}

function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let stringDelim: string | null = null;
  let inBlock = false;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1] ?? "";
    if (inBlock) {
      if (c === "*" && next === "/") { inBlock = false; i += 2; continue; }
      i += 1;
      continue;
    }
    if (stringDelim) {
      out += c;
      if (c === "\\") { out += next; i += 2; continue; }
      if (c === stringDelim) stringDelim = null;
      i += 1;
      continue;
    }
    if (c === "/" && next === "*") { inBlock = true; i += 2; continue; }
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") stringDelim = c;
    out += c;
    i += 1;
  }
  return out;
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function registrationBlock(source: string, toolName: string): string {
  const match = source.match(new RegExp(`server\\.registerTool\\(\\s*[\"']${toolName.replace(".", "\\.")}[\"'][\\s\\S]*?\\n\\s*\\);`));
  assert.ok(match, `registration not found for ${toolName}`);
  return match[0];
}
