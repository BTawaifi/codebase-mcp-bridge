import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PatchService } from '../src/services/patches.js';
import { SecurityService } from '../src/services/security.js';

async function createRepo(prefix = 'bridge-patch-service-'): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  return root;
}

function service(root: string): PatchService {
  return new PatchService(root, new SecurityService(root));
}

function rollbackId(result: string): string {
  const match = /Rollback: ([0-9a-f-]{36})/i.exec(result);
  assert.ok(match, `expected rollback id in: ${result}`);
  return match[1];
}

test('writeFile creates and restores files through rollback snapshots', async () => {
  const root = await createRepo();
  const patches = service(root);
  const file = path.join(root, 'src', 'created.ts');

  const write = await patches.writeFile('src/created.ts', 'export const value = 1;\n');
  assert.equal(await fs.readFile(file, 'utf8'), 'export const value = 1;\n');

  await patches.rollbackOperation(rollbackId(write));
  await assert.rejects(() => fs.readFile(file, 'utf8'), /ENOENT|no such file/i);
});

test('deletePath deletes one file and rollback restores it', async () => {
  const root = await createRepo();
  const patches = service(root);
  const file = path.join(root, 'src', 'delete-me.ts');
  await fs.writeFile(file, 'keep me\n', 'utf8');

  const deletion = await patches.deletePath('src/delete-me.ts');
  await assert.rejects(() => fs.readFile(file, 'utf8'), /ENOENT|no such file/i);

  await patches.rollbackOperation(rollbackId(deletion));
  assert.equal(await fs.readFile(file, 'utf8'), 'keep me\n');
});

test('deletePath refuses directories and missing files', async () => {
  const root = await createRepo();
  const patches = service(root);

  await assert.rejects(() => patches.deletePath('src'), /Refusing to delete a directory/);
  await assert.rejects(() => patches.deletePath('src/missing.ts'), /Cannot delete missing path/);
});

test('applyUnifiedDiff applies multiple hunks and returns rollback metadata', async () => {
  const root = await createRepo();
  const patches = service(root);
  const file = path.join(root, 'src', 'diff.ts');
  await fs.writeFile(file, [
    'export const one = 1;',
    'export const two = 2;',
    'export const three = 3;',
    'export const four = 4;',
  ].join('\n'), 'utf8');

  const diff = [
    '--- a/src/diff.ts',
    '+++ b/src/diff.ts',
    '@@ -1,2 +1,2 @@',
    '-export const one = 1;',
    '+export const one = 10;',
    ' export const two = 2;',
    '@@ -3,2 +3,3 @@',
    ' export const three = 3;',
    '-export const four = 4;',
    '+export const inserted = true;',
    '+export const four = 40;',
  ].join('\n');

  const result = await patches.applyUnifiedDiff(diff);
  assert.match(result, /Applied unified diff/);
  assert.match(result, /Rollback:/);

  const current = await fs.readFile(file, 'utf8');
  assert.match(current, /one = 10/);
  assert.match(current, /inserted = true/);
  assert.match(current, /four = 40/);
});

test('applyUnifiedDiff restores earlier writes if a later file write fails', async () => {
  const root = await createRepo();
  const patches = service(root);
  const first = path.join(root, 'src', 'first.ts');
  await fs.writeFile(first, 'export const first = 1;\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'blocker'), 'not a directory\n', 'utf8');

  const diff = [
    '--- a/src/first.ts',
    '+++ b/src/first.ts',
    '@@ -1,1 +1,1 @@',
    '-export const first = 1;',
    '+export const first = 2;',
    '--- /dev/null',
    '+++ b/src/blocker/new.ts',
    '@@ -0,0 +1,1 @@',
    '+export const newFile = true;',
  ].join('\n');

  await assert.rejects(() => patches.applyUnifiedDiff(diff), /prior writes were restored/);
  assert.equal(await fs.readFile(first, 'utf8'), 'export const first = 1;\n');
});

test('applyUnifiedDiff rejects duplicate file sections instead of overwriting an earlier section', async () => {
  const root = await createRepo();
  const patches = service(root);
  await fs.writeFile(path.join(root, 'src', 'one.ts'), 'export const value = 1;\n', 'utf8');

  const diff = [
    '--- a/src/one.ts',
    '+++ b/src/one.ts',
    '@@ -1,1 +1,1 @@',
    '-export const value = 1;',
    '+export const value = 2;',
    '--- a/src/one.ts',
    '+++ b/src/one.ts',
    '@@ -1,1 +1,1 @@',
    '-export const value = 1;',
    '+export const value = 3;',
  ].join('\n');

  await assert.rejects(() => patches.applyUnifiedDiff(diff), /duplicate file sections/);
  assert.equal(await fs.readFile(path.join(root, 'src', 'one.ts'), 'utf8'), 'export const value = 1;\n');
});

test('applyUnifiedDiff tolerates shifted hunks when context still uniquely matches', async () => {
  const root = await createRepo();
  const patches = service(root);
  const file = path.join(root, 'src', 'shifted.ts');
  await fs.writeFile(file, ['// inserted header', 'alpha', 'beta', 'gamma'].join('\n'), 'utf8');

  const diff = [
    '--- a/src/shifted.ts',
    '+++ b/src/shifted.ts',
    '@@ -1,3 +1,3 @@',
    ' alpha',
    '-beta',
    '+beta-updated',
    ' gamma',
  ].join('\n');

  await patches.applyUnifiedDiff(diff);
  assert.match(await fs.readFile(file, 'utf8'), /beta-updated/);
});

test('applyUnifiedDiff supports new files and rollback removes them', async () => {
  const root = await createRepo();
  const patches = service(root);
  const file = path.join(root, 'src', 'created.ts');
  const diff = [
    '--- /dev/null',
    '+++ b/src/created.ts',
    '@@ -0,0 +1,2 @@',
    '+export const created = true;',
    '+export const count = 1;',
  ].join('\n');

  const result = await patches.applyUnifiedDiff(diff);
  assert.match(await fs.readFile(file, 'utf8'), /created = true/);

  await patches.rollbackOperation(rollbackId(result));
  await assert.rejects(() => fs.readFile(file, 'utf8'), /ENOENT|no such file/i);
});

test('applyUnifiedDiff preserves CRLF and reports stale context clearly', async () => {
  const root = await createRepo();
  const patches = service(root);
  const file = path.join(root, 'src', 'crlf.ts');
  await fs.writeFile(file, 'alpha\r\nbeta\r\ngamma\r\n', 'utf8');

  const diff = [
    '--- a/src/crlf.ts',
    '+++ b/src/crlf.ts',
    '@@ -1,3 +1,3 @@',
    ' alpha',
    '-beta',
    '+beta-updated',
    ' gamma',
  ].join('\n');
  await patches.applyUnifiedDiff(diff);
  const current = await fs.readFile(file, 'utf8');
  assert.match(current, /beta-updated/);
  assert.match(current, /\r\n/);

  const stale = [
    '--- a/src/crlf.ts',
    '+++ b/src/crlf.ts',
    '@@ -1,3 +1,3 @@',
    ' alpha',
    '-non-existent',
    '+updated',
    ' gamma',
  ].join('\n');
  await assert.rejects(
    () => patches.applyUnifiedDiff(stale),
    /source no longer matches this diff.*refresh.*regenerate the patch/i,
  );
});

test('applyUnifiedDiff uses whitespace-tolerant matching without rewriting source indentation', async () => {
  const root = await createRepo();
  const patches = service(root);
  const file = path.join(root, 'src', 'fuzzy.ts');
  await fs.writeFile(file, [
    'export const f = () => {',
    '  // keep',
    "  if (status === 'F') {",
    '    return finished;',
    '  }',
    '  return upcoming;',
    '};',
  ].join('\r\n') + '\r\n', 'utf8');

  const diff = [
    '--- a/src/fuzzy.ts',
    '+++ b/src/fuzzy.ts',
    '@@ -3,3 +3,1 @@',
    "  if (status === 'F') {",
    '-    return finished;',
    '  }',
  ].join('\n');

  await patches.applyUnifiedDiff(diff);
  const current = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(current, /return finished/);
  assert.match(current, /\r\n {2}if \(status === 'F'\) \{\r\n {2}\}\r\n/);
});

test('applyUnifiedDiff prefers exact matches and rejects ambiguous whitespace-only matches', async () => {
  const exactRoot = await createRepo();
  const exactPatches = service(exactRoot);
  const exactFile = path.join(exactRoot, 'src', 'exact.ts');
  await fs.writeFile(exactFile, ['value', '  value', 'tail'].join('\n'), 'utf8');

  await exactPatches.applyUnifiedDiff([
    '--- a/src/exact.ts',
    '+++ b/src/exact.ts',
    '@@ -2,2 +2,2 @@',
    '-  value',
    '+  value-updated',
    ' tail',
  ].join('\n'));
  assert.equal(await fs.readFile(exactFile, 'utf8'), ['value', '  value-updated', 'tail'].join('\n'));

  const ambiguousRoot = await createRepo();
  const ambiguousPatches = service(ambiguousRoot);
  await fs.writeFile(path.join(ambiguousRoot, 'src', 'ambiguous.ts'), ['  value', 'spacer', '    value'].join('\n'), 'utf8');
  await assert.rejects(
    () => ambiguousPatches.applyUnifiedDiff([
      '--- a/src/ambiguous.ts',
      '+++ b/src/ambiguous.ts',
      '@@ -1,1 +1,1 @@',
      '-value',
      '+value-updated',
    ].join('\n')),
    /ambiguous/,
  );
});

test('raw command execution preserves quoted && instead of splitting it', async () => {
  const root = await createRepo();
  const patches = service(root);

  const result = JSON.parse(await patches.runArbitraryCommand(`node -e "console.log('left && right')"`, 30_000)) as {
    status: string; exitCode: number | string | null; durationMs: number; timedOut: boolean; output: string; error: string | null;
  };
  assert.equal(result.status, 'passed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.output, /left && right/);
  assert.equal(result.error, null);
});

test('raw command failures return structured execution facts instead of throwing away exit metadata', async () => {
  const root = await createRepo();
  const patches = service(root);
  const result = JSON.parse(await patches.runArbitraryCommand(`node -e "console.error('boom'); process.exit(7)"`, 30_000)) as {
    status: string; exitCode: number | string | null; durationMs: number; timedOut: boolean; output: string; error: string | null;
  };

  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
  assert.match(result.output, /boom/);
  assert.equal(typeof result.durationMs, 'number');
  assert.equal(typeof result.error, 'string');
});

test('validation accepts safe targeted arguments for one command and passes them through npm', async () => {
  const root = await createRepo();
  const patches = service(root);
  await fs.writeFile(path.join(root, 'print-args.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));\n', 'utf8');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node print-args.mjs' } }), 'utf8');

  const result = JSON.parse(await patches.runValidationSuite(['test:unit'], true, { failuresOnly: false }, ['tests/foo.test.ts', '--watch=false', 'foo bar'])) as {
    summary: { total: number; passed: number; failed: number };
    results: Array<{ output?: string }>;
  };

  assert.deepEqual(result.summary, { total: 1, passed: 1, failed: 0 });
  assert.match(result.results[0].output ?? '', /tests\/foo\.test\.ts/);
  assert.match(result.results[0].output ?? '', /--watch=false/);
  assert.match(result.results[0].output ?? '', /foo bar/);
  await assert.rejects(
    () => patches.runValidationSuite(['test:unit'], true, {}, ['tests/foo.test.ts && echo injected']),
    /Unsafe validation argument/,
  );
  await assert.rejects(
    () => patches.runValidationSuite(['test:unit', 'build'], true, {}, ['tests/foo.test.ts']),
    /exactly one command id/,
  );
});

test('validation suite returns compact status records without duplicate stdout/stderr payloads', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const patches = service(root);
  const result = JSON.parse(await patches.runValidationSuite(['typecheck'], true, {
    failuresOnly: true,
    maxOutputChars: 2_000,
  })) as {
    summary: { total: number; passed: number; failed: number };
    results: Array<Record<string, unknown>>;
  };

  assert.deepEqual(result.summary, { total: 1, passed: 1, failed: 0 });
  assert.equal(result.results[0].status, 'passed');
  assert.equal('stdout' in result.results[0], false);
  assert.equal('stderr' in result.results[0], false);
  assert.equal('command' in result.results[0], false);
});
