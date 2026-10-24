import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.mjs';
import { ProjectSession } from '../session.mjs';

async function connect() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'styk-mcp-'));
  const server = createServer(new ProjectSession({ root }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content[0].text;
    return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
  };
  return { client, call, root, close: async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('lists the animation tools', async () => {
  const { client, close } = await connect();
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const expected of ['new_project', 'open_project', 'save_project', 'describe_scene', 'add_figure', 'pose_joint', 'add_key', 'undo'])
      assert.ok(names.includes(expected), `missing ${expected}`);
  } finally { await close(); }
});

test('an assistant can build and save a two-pose animation over MCP', async () => {
  const { call, root, close } = await connect();
  try {
    await call('new_project', { name: 'wave', fps: 12 });
    const { data: scene } = await call('describe_scene');
    const uid = scene.figures[0].uid;
    await call('add_key', { frame: 8 });
    const posed = await call('pose_joint', { uid, joint: 'Right forearm', x: 410, y: 180 });
    assert.equal(posed.isError, false);
    const saved = await call('save_project', { path: 'wave.styk' });
    assert.equal(saved.data.path, 'wave.styk');
    assert.ok((await fs.stat(path.join(root, 'wave.styk'))).size > 0);
    const info = await call('project_info');
    assert.deepEqual(info.data.keyFrames, [0, 8]);
    assert.equal(info.data.fps, 12);
  } finally { await close(); }
});

test('mistakes are reported as tool errors, not protocol failures', async () => {
  const { call, close } = await connect();
  try {
    const wrongFigure = await call('pose_joint', { uid: 42, joint: 'Head', x: 1, y: 1 });
    assert.equal(wrongFigure.isError, true);
    assert.match(wrongFigure.text, /No figure with uid 42/);
    const escape = await call('save_project', { path: '../outside.styk' });
    assert.equal(escape.isError, true);
  } finally { await close(); }
});
