import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createBridgeServer, createBridgeServices } from '../src/createBridgeServer.js';
import { WorkspaceService } from '../src/services/workspaces.js';
import { registeredTool } from './helpers/mcp.js';

async function createServer(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-state-`));
  const workspaces = new WorkspaceService(stateRoot);
  await workspaces.trustWorkspace({ id: 'repo', path: root });
  return { root, server: createBridgeServer(createBridgeServices(root, workspaces)) };
}

test('code.search defaults to bounded matches and truncates pathological single lines explicitly', async () => {
  const { root, server } = await createServer('bridge-public-search-bounds-');
  const lines = Array.from({ length: 230 }, (_, index) => `needle ${index} ${'x'.repeat(index === 0 ? 2_000 : 10)}`);
  await fs.writeFile(path.join(root, 'src', 'many.ts'), lines.join('\n'), 'utf8');

  const response = await registeredTool(server, 'code.search')({
    queries: [{ query: 'needle', glob: 'src/**/*.ts' }],
  });
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.results[0].matches.length, 200);
  assert.equal(payload.results[0].truncated, true);
  assert.equal(payload.results[0].matches[0].textTruncated, true);
  assert.ok(payload.results[0].matches[0].text.length <= 1_001);
});

test('code.search reports one invalid regex without discarding valid sibling queries', async () => {
  const { root, server } = await createServer('bridge-public-search-errors-');
  await fs.writeFile(path.join(root, 'src', 'one.ts'), 'export const needle = true;\n', 'utf8');

  const response = await registeredTool(server, 'code.search')({
    queries: [
      { query: 'needle', glob: 'src/**/*.ts' },
      { query: '[', glob: 'src/**/*.ts', isRegex: true },
    ],
  });
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.results[0].matches.length, 1);
  assert.match(payload.results[1].error, /regular expression|regex|pattern/i);
});

test('code.read refuses batch output beyond the public response budget instead of dumping megabytes', async () => {
  const { root, server } = await createServer('bridge-public-read-bounds-');
  await fs.writeFile(path.join(root, 'src', 'one.txt'), 'a'.repeat(170_000), 'utf8');
  await fs.writeFile(path.join(root, 'src', 'two.txt'), 'b'.repeat(170_000), 'utf8');

  const response = await registeredTool(server, 'code.read')({
    files: [{ path: 'src/one.txt' }, { path: 'src/two.txt' }],
  });
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.outputLimited, true);
  assert.equal(payload.files[0].status, 'ok');
  assert.equal(payload.files[1].status, 'error');
  assert.match(payload.files[1].error, /output limit.*line range/i);
});

test('code.references exposes lexical incoming/outgoing semantics rather than caller/callee claims', async () => {
  const { root, server } = await createServer('bridge-public-references-');
  await fs.writeFile(path.join(root, 'src', 'refs.ts'), [
    'export function target() { return 1; }',
    'export function consumer() { return target(); }',
  ].join('\n'), 'utf8');

  const incoming = await registeredTool(server, 'code.references')({
    symbolName: 'target',
    direction: 'incoming',
  });
  const incomingPayload = JSON.parse(incoming.content[0].text);
  assert.equal(incomingPayload.direction, 'incoming');
  assert.equal(incomingPayload.basis, 'lexical-identifier-matching');
  assert.ok(incomingPayload.matches.some((match: { name: string }) => match.name === 'consumer'));

  const outgoing = await registeredTool(server, 'code.references')({
    symbolName: 'consumer',
    direction: 'outgoing',
  });
  const outgoingPayload = JSON.parse(outgoing.content[0].text);
  assert.ok(outgoingPayload.matches.some((match: { name: string }) => match.name === 'target'));
});
