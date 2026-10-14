import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { GitService } from '../src/services/git.js';
import { RepoService } from '../src/services/repo.js';
import { SecurityService } from '../src/services/security.js';

const execFileAsync = promisify(execFile);

async function createRepo(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  return root;
}

test('read_files_batch returns successful reads and per-file errors', async () => {
  const root = await createRepo('bridge-read-batch-');
  await fs.writeFile(path.join(root, 'src', 'one.ts'), 'alpha\nbeta\ngamma\n', 'utf8');

  const repo = new RepoService(root, new SecurityService(root));
  const result = JSON.parse(await repo.readFilesBatch([
    { path: 'src/one.ts', startLine: 2, endLine: 3 },
    { path: 'src/missing.ts' },
  ]));

  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].status, 'ok');
  assert.equal(result.files[0].path, 'src/one.ts');
  assert.match(result.files[0].content, /2: beta/);
  assert.match(result.files[0].content, /3: gamma/);
  assert.equal(typeof result.files[0].sha256, 'string');
  assert.equal(result.files[1].status, 'error');
  assert.equal(result.files[1].path, 'src/missing.ts');
  assert.match(result.files[1].error, /ENOENT|no such file/i);
});

test('search_code_batch returns independent results for matches and misses', async () => {
  const root = await createRepo('bridge-search-batch-');
  await fs.writeFile(path.join(root, 'src', 'one.ts'), 'export const needle = 42;\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'two.ts'), 'export const hay = true;\n', 'utf8');

  const repo = new RepoService(root, new SecurityService(root));
  const result = JSON.parse(await repo.searchBatch([
    { query: 'needle', glob: 'src/**/*.ts' },
    { query: 'not-present', glob: 'src/**/*.ts' },
  ]));

  assert.equal(result.queries.length, 2);

  if (result.queries[0].status === 'ok') {
    assert.match(result.queries[0].results, /src[/\\]one\.ts/);
    assert.match(result.queries[0].results, /needle/);
    assert.equal(result.queries[1].status, 'ok');
    assert.equal(result.queries[1].results, '(no matches)');
  } else {
    assert.match(result.queries[0].error, /rg|ripgrep|ENOENT|Timed out/i);
  }
});

test('search_code_batch can return structured context for selected queries', async () => {
  const root = await createRepo('bridge-search-batch-context-');
  await fs.writeFile(path.join(root, 'src', 'one.ts'), [
    'const before = true;',
    'export const needle = 42;',
    'const after = true;',
  ].join('\n'), 'utf8');

  const repo = new RepoService(root, new SecurityService(root));
  const result = JSON.parse(await repo.searchBatch([
    { query: 'needle', glob: 'src/**/*.ts', contextLines: 1 },
  ]));

  assert.equal(result.queries.length, 1);
  assert.equal(result.queries[0].status, 'ok');
  assert.equal(result.queries[0].contextLines, 1);
  const structured = JSON.parse(result.queries[0].results);
  assert.equal(structured.contextLines, 1);
  assert.equal(structured.matches[0].path, 'src/one.ts');
  assert.equal(structured.matches[0].context.before[0].text, 'const before = true;');
  assert.equal(structured.matches[0].context.after[0].text, 'const after = true;');
});

test('getMatchContext returns bounded context and import/export metadata', async () => {
  const root = await createRepo('bridge-match-context-');
  await fs.writeFile(path.join(root, 'src', 'one.ts'), [
    "import { helper } from './helper';",
    '',
    'export function run() {',
    "  return helper('needle');",
    '}',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(root, 'src', 'helper.ts'), 'export const helper = (value: string) => value;\n', 'utf8');

  const repo = new RepoService(root, new SecurityService(root));
  const result = JSON.parse(await repo.getMatchContext('needle', 'src/**/*.ts', 1, 5, { textOnly: true }));

  assert.equal(result.query, 'needle');
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].path, 'src/one.ts');
  assert.equal(result.matches[0].context.before.length, 1);
  assert.equal(result.fileMetadata['src/one.ts'].imports[0], "import { helper } from './helper';");
  assert.equal(result.fileMetadata['src/one.ts'].exports[0], 'export function run() {');
});

test('searchStructured reports opt-in text and asset skips in native mode', async () => {
  const root = await createRepo('bridge-search-filters-');
  await fs.mkdir(path.join(root, 'public', 'assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'one.ts'), 'const needle = true;\n', 'utf8');
  await fs.writeFile(path.join(root, 'public', 'assets', 'sound.ogg'), 'needle\u0000binary-ish\n', 'utf8');

  const repo = new RepoService(root, new SecurityService(root));
  const result = JSON.parse(await repo.searchStructured('needle', undefined, 0, undefined, undefined, {
    textOnly: true,
    includeAssets: false,
  }));

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].path, 'src/one.ts');
  assert.equal(typeof result.skipped.assetLike, 'number');
  if (result.backend === 'native') {
    assert.equal(result.skipped.assetLike, 1);
  }
});

test('git path operations validate paths before staging', async () => {
  const root = await createRepo('bridge-git-path-validation-');
  await execFileAsync('git', ['init'], { cwd: root });
  await fs.writeFile(path.join(root, 'src', 'one.ts'), 'one\n', 'utf8');
  await fs.writeFile(path.join(root, '.env'), 'SECRET=value\n', 'utf8');

  const git = new GitService(root);

  await assert.rejects(
    () => git.stagePaths(['../outside.ts']),
    /escapes repository root/,
  );
  await assert.rejects(
    () => git.stagePaths(['.env']),
    /blocked from mutation by bridge security policy/,
  );
  await assert.rejects(
    () => git.stagePaths([':(exclude)src/one.ts']),
    /pathspec magic/,
  );

  await git.stagePaths(['src/one.ts']);
  const { stdout } = await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: root });
  assert.match(stdout, /src\/one\.ts/);
});

test('readFile slices file content by line range', async () => {
  const root = await createRepo('bridge-read-slice-');
  await fs.writeFile(path.join(root, 'src', 'lines.txt'), 'one\ntwo\nthree\nfour\nfive\n', 'utf8');

  const repo = new RepoService(root, new SecurityService(root));
  
  // Entire file
  const all = await repo.readFile('src/lines.txt');
  assert.equal(all, 'one\ntwo\nthree\nfour\nfive\n');

  // Slice start/end
  const sliced = await repo.readFile('src/lines.txt', 2, 4);
  assert.equal(sliced, '2: two\n3: three\n4: four');

  // Slice start only
  const slicedStart = await repo.readFile('src/lines.txt', 3);
  assert.equal(slicedStart, '3: three\n4: four\n5: five');

  // Slice end only
  const slicedEnd = await repo.readFile('src/lines.txt', undefined, 3);
  assert.equal(slicedEnd, '1: one\n2: two\n3: three');
});

test('search supports matchPerLine to return exact matching lines or unique paths', async () => {
  const root = await createRepo('bridge-search-mpl-');
  await fs.writeFile(path.join(root, 'src', 'file1.ts'), 'needle line 1\nother line\nneedle line 2\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'file2.ts'), 'other line\nneedle line 3\n', 'utf8');

  const repo = new RepoService(root, new SecurityService(root));

  // matchPerLine true: returns path:line:text
  const linesResult = await repo.search('needle', undefined, undefined, undefined, { matchPerLine: true });
  const lines = linesResult.split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines.some(l => l.includes('file1.ts:1:needle line 1')));
  assert.ok(lines.some(l => l.includes('file1.ts:3:needle line 2')));
  assert.ok(lines.some(l => l.includes('file2.ts:2:needle line 3')));

  // matchPerLine false/undefined: returns unique paths
  const pathsResult = await repo.search('needle', undefined, undefined, undefined, { matchPerLine: false });
  const paths = pathsResult.split('\n').sort();
  assert.equal(paths.length, 2);
  assert.match(paths[0], /file1\.ts/);
  assert.match(paths[1], /file2\.ts/);
  
  const defaultResult = await repo.search('needle', undefined, undefined, undefined);
  const defaultPaths = defaultResult.split('\n').sort();
  assert.equal(defaultPaths.length, 2);
  assert.match(defaultPaths[0], /file1\.ts/);
  assert.match(defaultPaths[1], /file2\.ts/);
});
