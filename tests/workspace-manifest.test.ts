import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  resolveValidationCommands,
  verifyCommandsAgainstPackageJson,
  clearManifestCache,
} from '../src/config/workspace-manifest.js';
import { COMMANDS } from '../src/config/commands.js';
import { withEnv } from './helpers/env.js';

async function writeManifest(repoRoot: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-manifest-'));
  const manifestPath = path.join(dir, 'workspace.json');
  const manifest = {
    repos: [
      {
        id: 'demo-repo',
        path: repoRoot,
        commands: {
          lint: 'npm run lint',
          lintCheck: 'npm run lint:check',
          typecheck: 'npx tsc --noEmit',
          build: 'npm run build-production',
          test: 'npm test',
        },
      },
      {
        id: 'bare-repo',
        path: path.join(repoRoot, '..', 'bare-repo'),
        commands: { lint: 'npm run lint', typecheck: '' },
      },
    ],
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
  return manifestPath;
}

test('resolveValidationCommands overlays manifest commands and prefers lintCheck', async () => {
  const repoRoot = path.join(os.tmpdir(), 'bridge-demo-repo');
  const manifestPath = await writeManifest(repoRoot);
  await withEnv({ CODEBASE_MCP_WORKSPACE_MANIFEST: manifestPath }, async () => {
    clearManifestCache();
    const res = resolveValidationCommands(repoRoot);
    assert.equal(res.source, 'workspace-manifest');
    assert.equal(res.repoId, 'demo-repo');
    // Safety: 'lint' must resolve to the non-mutating lintCheck command.
    assert.equal(res.commands.lint, 'npm run lint:check');
    assert.equal(res.commands.typecheck, 'npx tsc --noEmit');
    assert.equal(res.commands.build, 'npm run build-production');
    assert.equal(res.commands['test:unit'], 'npm test');
    assert.equal(res.unavailableCommands?.some((entry) => entry.id === 'lint') ?? false, false);
  });
  clearManifestCache();
});

test('resolveValidationCommands matches paths case-insensitively, ignoring trailing slash', async () => {
  const repoRoot = path.join(os.tmpdir(), 'bridge-demo-repo');
  const manifestPath = await writeManifest(repoRoot);
  await withEnv({ CODEBASE_MCP_WORKSPACE_MANIFEST: manifestPath }, async () => {
    clearManifestCache();
    const res = resolveValidationCommands(repoRoot.toUpperCase() + path.sep);
    assert.equal(res.source, 'workspace-manifest');
    assert.equal(res.repoId, 'demo-repo');
  });
  clearManifestCache();
});

test('resolveValidationCommands keeps static defaults when a manifest command is empty', async () => {
  const repoRoot = path.join(os.tmpdir(), 'bridge-demo-repo');
  const bareRoot = path.join(repoRoot, '..', 'bare-repo');
  const manifestPath = await writeManifest(repoRoot);
  await withEnv({ CODEBASE_MCP_WORKSPACE_MANIFEST: manifestPath }, async () => {
    clearManifestCache();
    const res = resolveValidationCommands(bareRoot);
    assert.equal(res.source, 'workspace-manifest');
    assert.equal(res.repoId, 'bare-repo');
    // Empty typecheck in manifest -> static default preserved.
    assert.equal(res.commands.typecheck, 'npm run typecheck');
    // No lintCheck declared -> the static command remains visible but is not executable as validation.
    assert.equal(res.commands.lint, 'npm run lint');
    assert.ok(res.unavailableCommands?.some((entry) => entry.id === 'lint' && entry.reason.includes('lintCheck')));
  });
  clearManifestCache();
});

test('resolveValidationCommands falls back to static defaults for an unlisted root', async () => {
  const manifestPath = await writeManifest(path.join(os.tmpdir(), 'bridge-demo-repo'));
  await withEnv({ CODEBASE_MCP_WORKSPACE_MANIFEST: manifestPath }, async () => {
    clearManifestCache();
    const res = resolveValidationCommands(path.join(os.tmpdir(), 'totally-unlisted'));
    assert.equal(res.source, 'static-default');
    assert.equal(res.repoId, undefined);
    assert.equal(res.commands.lint, 'npm run lint');
    assert.ok(res.unavailableCommands?.some((entry) => entry.id === 'lint' && entry.reason.includes('lintCheck')));
  });
  clearManifestCache();
});

test('resolveValidationCommands falls back to static defaults when no root is active', async () => {
  clearManifestCache();
  const res = resolveValidationCommands(undefined);
  assert.equal(res.source, 'static-default');
  assert.equal(res.commands.typecheck, 'npm run typecheck');
  // No root => no package.json could be read, so verification did not run.
  assert.equal(res.verifiedAgainstPackageJson, false);
  assert.ok(res.unavailableCommands?.some((entry) => entry.id === 'lint' && entry.reason.includes('lintCheck')));
});

test('verifyCommandsAgainstPackageJson flags commands whose npm script is missing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-pkg-'));
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test', build: 'tsc' } }),
    'utf8',
  );
  const res = verifyCommandsAgainstPackageJson(dir, { ...COMMANDS });
  assert.equal(res.verifiedAgainstPackageJson, true);
  const flagged = res.unavailableCommands.map((entry) => entry.id).sort();
  // typecheck and lint have no matching script; build and test:unit do; the
  // powershell script:ps-parse is not an npm command and is never flagged.
  assert.deepEqual(flagged, ['lint', 'typecheck']);
});

test('verifyCommandsAgainstPackageJson reports unverified when no package.json exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-nopkg-'));
  const res = verifyCommandsAgainstPackageJson(dir, { ...COMMANDS });
  assert.equal(res.verifiedAgainstPackageJson, false);
  assert.deepEqual(res.unavailableCommands, []);
});

test('resolveValidationCommands surfaces missing-script commands for an unlisted root', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-static-pkg-'));
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test', build: 'tsc' } }),
    'utf8',
  );
  clearManifestCache();
  const res = resolveValidationCommands(dir);
  assert.equal(res.source, 'static-default');
  assert.equal(res.verifiedAgainstPackageJson, true);
  assert.ok(res.unavailableCommands && res.unavailableCommands.some((entry) => entry.id === 'typecheck'));
  assert.ok(res.notes.some((note) => note.includes('no matching package.json script')));
});
