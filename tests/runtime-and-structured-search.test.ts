import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RepoService } from '../src/services/repo.js';
import { SecurityService } from '../src/services/security.js';
import { resolveRipgrepPath, resetRipgrepPathCache } from '../src/services/ripgrep.js';

async function createRepo(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  return root;
}

test('find_files returns metadata and respects glob patterns', async () => {
  const root = await createRepo('bridge-find-files-');
  await fs.writeFile(path.join(root, 'src', 'one.ts'), 'export const one = 1;\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'two.js'), 'export const two = 2;\n', 'utf8');

  const repo = new RepoService(root, new SecurityService(root));
  const result = JSON.parse(await repo.findFiles('src/**/*.ts'));

  assert.equal(result.count, 1);
  assert.equal(result.files[0].path, 'src/one.ts');
  assert.equal(typeof result.files[0].sizeBytes, 'number');
});

test('searchStructured returns backend, structured matches, and context lines', async () => {
  const root = await createRepo('bridge-structured-search-');
  await fs.writeFile(path.join(root, 'src', 'one.ts'), [
    'const before = true;',
    'export const needle = 42;',
    'const after = true;',
  ].join('\n'), 'utf8');

  const repo = new RepoService(root, new SecurityService(root));
  const result = JSON.parse(await repo.searchStructured('needle', 'src/**/*.ts', 1));

  assert.equal(result.query, 'needle');
  assert.equal(result.contextLines, 1);
  assert.equal(typeof result.backend, 'string');
  assert.equal(typeof result.durationMs, 'number');
  assert.equal(Array.isArray(result.matches), true);
  assert.equal(result.matches[0].path, 'src/one.ts');
  assert.equal(result.matches[0].line, 2);
  assert.equal(result.matches[0].context.before[0].text, 'const before = true;');
  assert.equal(result.matches[0].context.after[0].text, 'const after = true;');
});

test('searchStructured excludes ai bridge operational logs', async () => {
  const root = await createRepo('bridge-search-excludes-');
  await fs.mkdir(path.join(root, '.ai-bridge', 'execution-graph'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'one.ts'), 'export const needle = 42;\n', 'utf8');
  await fs.writeFile(path.join(root, '.ai-bridge', 'execution-graph', 'timeline.jsonl'), 'needle from logs\n', 'utf8');

  const repo = new RepoService(root, new SecurityService(root));
  const result = JSON.parse(await repo.searchStructured('needle'));

  assert.deepEqual(result.matches.map((match: { path: string }) => match.path), ['src/one.ts']);
});

test('searchStructured supports caseInsensitive and isRegex search', async () => {
  const root = await createRepo('bridge-search-flags-');
  await fs.writeFile(path.join(root, 'src', 'one.ts'), [
    'export const MyNeedle = 42;',
    'export const otherThing = 100;',
  ].join('\n'), 'utf8');

  const repo = new RepoService(root, new SecurityService(root));

  // 1. Literal match (case-sensitive by default) - should NOT find lowercase "myneedle"
  const res1 = JSON.parse(await repo.searchStructured('myneedle', 'src/**/*.ts'));
  assert.equal(res1.matches.length, 0);

  // 2. Case-insensitive match - should find "MyNeedle"
  const res2 = JSON.parse(await repo.searchStructured('myneedle', 'src/**/*.ts', 0, true));
  assert.equal(res2.matches.length, 1);
  assert.equal(res2.matches[0].text, 'export const MyNeedle = 42;');

  // 3. Regex match - should match regex "MyN[e]+dle"
  const res3 = JSON.parse(await repo.searchStructured('MyN[e]+dle', 'src/**/*.ts', 0, false, true));
  assert.equal(res3.matches.length, 1);
  assert.equal(res3.matches[0].text, 'export const MyNeedle = 42;');
});

test('searchStructured never returns matches from secret-bearing source files', async () => {
  const root = await createRepo('bridge-search-secret-filter-');
  await fs.writeFile(path.join(root, 'src', 'safe.ts'), 'export const needle = 1;\n', 'utf8');
  const fakeSecret = ['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
  await fs.writeFile(
    path.join(root, 'src', 'leaky.ts'),
    `export const needle = "${fakeSecret}";\n`,
    'utf8',
  );

  const repo = new RepoService(root, new SecurityService(root));
  const result = JSON.parse(await repo.searchStructured('needle', 'src/**/*.ts'));
  assert.deepEqual(result.matches.map((match: { path: string }) => match.path), ['src/safe.ts']);
  assert.equal(result.skipped.secretBearing, 1);
});

test('resolveRipgrepPath honors BRIDGE_RG_PATH override when the file exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-rg-override-'));
  const fake = path.join(dir, process.platform === 'win32' ? 'rg.exe' : 'rg');
  await fs.writeFile(fake, '', 'utf8');

  const prev = process.env.BRIDGE_RG_PATH;
  process.env.BRIDGE_RG_PATH = fake;
  resetRipgrepPathCache();
  try {
    assert.equal(resolveRipgrepPath(), fake);
  } finally {
    if (prev === undefined) delete process.env.BRIDGE_RG_PATH;
    else process.env.BRIDGE_RG_PATH = prev;
    resetRipgrepPathCache();
  }
});

test('resolveRipgrepPath ignores a non-existent override and still returns a command', async () => {
  const bogus = path.join(os.tmpdir(), 'bridge-rg-does-not-exist', 'rg.exe');
  const prev = process.env.BRIDGE_RG_PATH;
  process.env.BRIDGE_RG_PATH = bogus;
  resetRipgrepPathCache();
  try {
    const resolved = resolveRipgrepPath();
    assert.equal(typeof resolved, 'string');
    assert.notEqual(resolved, bogus);
  } finally {
    if (prev === undefined) delete process.env.BRIDGE_RG_PATH;
    else process.env.BRIDGE_RG_PATH = prev;
    resetRipgrepPathCache();
  }
});
