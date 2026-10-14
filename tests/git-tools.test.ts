import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { GitService } from '../src/services/git.js';

const execFileAsync = promisify(execFile);

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-git-tools-'));
  await execFileAsync('git', ['init'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'bridge@example.com'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Bridge Test'], { cwd: root });
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  return root;
}

async function commitBaseline(root: string): Promise<void> {
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
}

test('git.stagePaths stages only requested files', async () => {
  const root = await createRepo();
  await fs.writeFile(path.join(root, 'src', 'one.ts'), 'one\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'two.ts'), 'two\n', 'utf8');

  const git = new GitService(root);
  const result = JSON.parse(await git.stagePaths(['src/one.ts']));

  assert.deepEqual(result.staged, ['src/one.ts']);
  assert.match(result.status.join('\n'), /src\/one.ts/);
  assert.doesNotMatch(result.status.join('\n'), /src\/two.ts/);
});

test('git.commitPaths does not sweep unrelated staged changes into the commit', async () => {
  const root = await createRepo();
  await fs.writeFile(path.join(root, 'src', 'one.ts'), 'one\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'two.ts'), 'two\n', 'utf8');
  await commitBaseline(root);

  await fs.writeFile(path.join(root, 'src', 'one.ts'), 'one changed\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'two.ts'), 'two changed\n', 'utf8');
  await execFileAsync('git', ['add', 'src/two.ts'], { cwd: root });

  const git = new GitService(root);
  await git.commitPaths(['src/one.ts'], 'commit one');

  const { stdout: committed } = await execFileAsync('git', ['show', '--name-only', '--pretty=format:'], { cwd: root });
  assert.match(committed, /src\/one.ts/);
  assert.doesNotMatch(committed, /src\/two.ts/);

  const { stdout: stillStaged } = await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: root });
  assert.match(stillStaged, /src\/two.ts/);
});

test('git.diff supports compact summaries and exclusions', async () => {
  const root = await createRepo();
  await fs.writeFile(path.join(root, 'src', 'one.ts'), 'one\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'two.ts'), 'two\n', 'utf8');
  await commitBaseline(root);
  await fs.writeFile(path.join(root, 'src', 'one.ts'), 'one modified\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'two.ts'), 'two modified\n', 'utf8');

  const git = new GitService(root);
  const summary = await git.diff(undefined, undefined, true, ['src/two.ts']);
  assert.match(summary, /M\s+src\/one\.ts/);
  assert.doesNotMatch(summary, /two\.ts/);
  assert.doesNotMatch(summary, /one modified/);
});

test('git.diff defaults to unstaged changes and stagedOnly reads the index', async () => {
  const root = await createRepo();
  await fs.writeFile(path.join(root, 'src', 'one.ts'), 'one\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'two.ts'), 'two\n', 'utf8');
  await commitBaseline(root);

  await fs.writeFile(path.join(root, 'src', 'one.ts'), 'one staged\n', 'utf8');
  await execFileAsync('git', ['add', 'src/one.ts'], { cwd: root });
  await fs.writeFile(path.join(root, 'src', 'two.ts'), 'two unstaged\n', 'utf8');

  const git = new GitService(root);
  const staged = await git.diff(undefined, undefined, false, undefined, true);
  const unstaged = await git.diff();
  assert.match(staged, /one staged/);
  assert.doesNotMatch(staged, /two unstaged/);
  assert.match(unstaged, /two unstaged/);
  assert.doesNotMatch(unstaged, /one staged/);
});

test('git.diff fails on an invalid explicit base instead of silently substituting another branch', async () => {
  const root = await createRepo();
  await fs.writeFile(path.join(root, 'src', 'one.ts'), 'one\n', 'utf8');
  await commitBaseline(root);

  const git = new GitService(root);
  await assert.rejects(() => git.diff('definitely-not-a-real-ref'), /Git diff failed/);
});

test('git.status returns only core Git state', async () => {
  const root = await createRepo();
  await fs.writeFile(path.join(root, 'src', 'one.ts'), 'one\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'two.ts'), 'two\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'three.ts'), 'three\n', 'utf8');
  await commitBaseline(root);

  await fs.writeFile(path.join(root, 'src', 'one.ts'), 'one staged\n', 'utf8');
  await execFileAsync('git', ['add', 'src/one.ts'], { cwd: root });
  await fs.writeFile(path.join(root, 'src', 'two.ts'), 'two unstaged\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'three.ts'), 'three staged\n', 'utf8');
  await execFileAsync('git', ['add', 'src/three.ts'], { cwd: root });
  await fs.writeFile(path.join(root, 'src', 'three.ts'), 'three mixed\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'new.ts'), 'new\n', 'utf8');

  const status = await new GitService(root).status();
  assert.equal(typeof status.branch, 'string');
  assert.ok(status.staged.includes('src/one.ts'));
  assert.ok(status.unstaged.includes('src/two.ts'));
  assert.ok(status.mixed.includes('src/three.ts'));
  assert.ok(status.untracked.includes('src/new.ts'));
  assert.deepEqual(Object.keys(status).sort(), ['branch', 'mixed', 'staged', 'unstaged', 'untracked']);
});

test('git path operations allow explicit non-sensitive generated files', async () => {
  const root = await createRepo();
  await fs.writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion": 3}\n', 'utf8');
  const git = new GitService(root);
  await git.stagePaths(['package-lock.json']);
  const { stdout } = await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: root });
  assert.match(stdout, /package-lock\.json/);
});

test('git.commit refuses already-staged sensitive files', async () => {
  const root = await createRepo();
  await fs.writeFile(path.join(root, '.env'), 'TOKEN=secret\n', 'utf8');
  await execFileAsync('git', ['add', '-f', '.env'], { cwd: root });
  const git = new GitService(root);
  await assert.rejects(() => git.commit('should not commit env'), /blocked from mutation by bridge security policy/);
});

test('git.commitPaths validates sensitive files discovered under selected directories', async () => {
  const root = await createRepo();
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  await fs.writeFile(path.join(root, 'config', 'app.json'), '{}\n', 'utf8');
  await fs.writeFile(path.join(root, 'config', '.env'), 'TOKEN=secret\n', 'utf8');
  const git = new GitService(root);

  await assert.rejects(
    () => git.commitPaths(['config'], 'should not commit nested env'),
    /blocked from mutation by bridge security policy/,
  );
});

test('git.diff bounds large output and marks truncation explicitly', async () => {
  const root = await createRepo();
  await fs.writeFile(path.join(root, 'src', 'one.ts'), 'export const value = 1;\n', 'utf8');
  await commitBaseline(root);
  await fs.writeFile(path.join(root, 'src', 'one.ts'), `export const value = "${'x'.repeat(2_000)}";\n`, 'utf8');

  const git = new GitService(root);
  const diff = await git.diff(undefined, ['src/one.ts'], false, undefined, false, 200);
  assert.match(diff, /diff truncated to 200 characters/);
  assert.ok(diff.length < 300);
});

test('git rejects option-injection through refs and remotes', async () => {
  const root = await createRepo();
  const git = new GitService(root);
  await assert.rejects(() => git.diff('--output=/tmp/x'), /Invalid base ref/);
  await assert.rejects(() => git.push('--force'), /Invalid remote/);
  await assert.rejects(() => git.push('origin', '--force'), /Invalid branch\/refspec/);
});
