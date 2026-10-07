import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startViewServer, VIEW_ASSETS } from '../tools/lib/server.mjs';
import { FIXTURES, tempDir } from './helpers/fixtures.mjs';

const STEP = join(FIXTURES, 'valid', 'lifecycle', '07-verified');

async function served() {
  const dir = await tempDir();
  await cp(STEP, dir, { recursive: true });
  await mkdir(join(dir, 'evidence'), { recursive: true });
  await writeFile(join(dir, 'evidence', '0030-web-health.txt'), 'HTTP/1.1 200 OK\n');
  const view = await startViewServer({ workspace: dir, port: 0 });
  return { dir, view };
}

// Raw request: the path is sent exactly as given, without client-side normalisation.
function raw(view, path, { method = 'GET', host = `127.0.0.1:${view.port}`, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = body ? { host, 'content-length': Buffer.byteLength(body) } : { host };
    const req = request({ host: '127.0.0.1', port: view.port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('the server listens on loopback only', async () => {
  const { view } = await served();
  try {
    assert.equal(view.server.address().address, '127.0.0.1');
    assert.equal(view.url, `http://127.0.0.1:${view.port}/`);
  } finally { await view.close(); }
});

test('the view assets, state.json and events.jsonl are served, fresh on every request', async () => {
  const { dir, view } = await served();
  try {
    for (const path of Object.keys(VIEW_ASSETS)) assert.equal((await raw(view, path)).status, 200, path);
    const state = await raw(view, '/state.json');
    assert.equal(state.body, await readFile(join(dir, 'state.json'), 'utf8'));
    assert.match(state.headers['content-type'], /application\/json/);
    assert.equal((await raw(view, '/events.jsonl')).body, await readFile(join(dir, 'events.jsonl'), 'utf8'));
    await writeFile(join(dir, 'state.json'), '{"changed":true}');
    assert.equal((await raw(view, '/state.json')).body, '{"changed":true}');
  } finally { await view.close(); }
});

test('every response forbids caching and any non-local resource', async () => {
  const { view } = await served();
  try {
    const res = await raw(view, '/');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.doesNotMatch(csp, /https?:|\*/);
  } finally { await view.close(); }
});

test('non-read requests are refused and change nothing', async () => {
  const { dir, view } = await served();
  const before = await readFile(join(dir, 'state.json'), 'utf8');
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const res = await raw(view, '/state.json', { method, body: method === 'OPTIONS' ? undefined : '{"stage":"closed"}' });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.allow, 'GET, HEAD');
    }
    assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), before);
  } finally { await view.close(); }
});

test('HEAD returns headers without a body', async () => {
  const { view } = await served();
  try {
    const res = await raw(view, '/state.json', { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.body, '');
  } finally { await view.close(); }
});

test('evidence, other files and traversal attempts are refused', async () => {
  const { view } = await served();
  try {
    const refused = [
      '/evidence/0030-web-health.txt', '/evidence/', '/evidence', '/../state.json', '/%2e%2e/state.json',
      '/..%2fstate.json', '//state.json', '/state.json/', '/./state.json', '/state.json?x=1', '/STATE.JSON',
      '/app/web-ui/app.js', '/tools/watchover.mjs', '/package.json', '/README.md', '/index.html/../state.json',
    ];
    for (const path of refused) {
      const res = await raw(view, path);
      assert.equal(res.status, 404, path);
      assert.ok(!res.body.includes('200 OK'), `${path} leaked evidence`);
    }
  } finally { await view.close(); }
});

test('requests addressed to another host name are refused', async () => {
  const { view } = await served();
  try {
    assert.equal((await raw(view, '/state.json', { host: 'attacker.example.com' })).status, 421);
    assert.equal((await raw(view, '/state.json', { host: `localhost:${view.port}` })).status, 200);
  } finally { await view.close(); }
});

test('a missing state.json is a 404, which the view shows as an error', async () => {
  const dir = await tempDir();
  const view = await startViewServer({ workspace: dir, port: 0 });
  try {
    assert.equal((await raw(view, '/state.json')).status, 404);
    assert.equal((await raw(view, '/')).status, 200);
  } finally { await view.close(); }
});
