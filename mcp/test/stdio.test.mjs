import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('the server speaks MCP over stdio, the way Claude launches it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'styk-mcp-'));
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../server.mjs', import.meta.url))],
    env: { ...process.env, STYK_MCP_DIR: root },
  });
  try {
    await client.connect(transport);
    const scene = JSON.parse((await client.callTool({ name: 'describe_scene', arguments: {} })).content[0].text);
    assert.equal(scene.figures.length, 1);
    await client.callTool({ name: 'save_project', arguments: { path: 'hello.styk' } });
    assert.ok((await fs.stat(path.join(root, 'hello.styk'))).size > 0, 'project written inside STYK_MCP_DIR');
  } finally {
    await client.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
