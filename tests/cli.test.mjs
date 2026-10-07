import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, FIXTURES, tempDir } from './helpers/fixtures.mjs';

const CLI = join(REPO, 'tools', 'watchover.mjs');
const CANARY = ['AK', 'IA', 'WATCHOVERCANARY1'].join('');
const run = (args, input) => spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8' });
const INIT = ['--project', 'demo-app', '--environment', 'trial on GCP', '--provider', 'gcp', '--session', 'session-a'];
const readOnlyIntent = JSON.stringify({ actor: { role: 'ai', name: 'ai-deployer' }, session_id: 'session-a', type: 'intent', summary: 'List instances (read-only)', target: 'demo-cloud-project', action: 'gcloud compute instances list --project=demo-cloud-project', action_kinds: ['read_only'] });

async function initialized() {
  const dir = join(await tempDir(), 'watchover');
  const r = run(['init', dir, ...INIT]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return dir;
}

test('without a command the CLI prints usage and exits 64', () => {
  const r = run([]);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /usage: .*watchover\.mjs <init\|append\|commit-state\|validate\|brief\|show>/i);
  assert.equal(run(['teleport']).status, 64);
});

test('root help exits 0 while malformed invocations remain usage errors', () => {
  for (const flag of ['--help', '-h']) {
    const r = run([flag]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^usage:/);
  }
  for (const args of [['--help', 'extra'], ['append'], ['show', 'ws', '--port', 'broken'], ['validate', 'ws', '--unexpected']]) {
    assert.equal(run(args).status, 64, args.join(' '));
  }
});

test('earlier explicit at refuses before append; equal and omitted times work without rewriting', async () => {
  const dir = await initialized();
  const path = join(dir, 'events.jsonl');
  const initial = await readFile(path, 'utf8');
  const previous = JSON.parse(initial);
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  const r = run(['append', dir], JSON.stringify({ ...JSON.parse(readOnlyIntent), at: new Date(Date.parse(previous.at) - 1000).toISOString() }));
  assert.equal(r.status, 1);
  assert.equal(sha(await readFile(path, 'utf8')), sha(initial));
  assert.ok(r.stdout.includes(previous.at));
  assert.match(r.stdout, /events\.jsonl line 2/);
  assert.match(r.stdout, /\/at.*omit at/);
  console.log(JSON.stringify({ case: 'earlier-explicit-time', exit: r.status, before_sha256: sha(initial), after_sha256: sha(await readFile(path, 'utf8')), output: r.stdout.trim() }));
  const equal = run(['append', dir], JSON.stringify({ ...JSON.parse(readOnlyIntent), at: previous.at }));
  assert.equal(equal.status, 0);
  assert.equal(JSON.parse((await readFile(path, 'utf8')).trim().split('\n').at(-1)).at, previous.at);
  const future = new Date(Date.now() + 5000).toISOString();
  assert.equal(run(['append', dir], JSON.stringify({ ...JSON.parse(readOnlyIntent), at: future })).status, 0);
  const omitted = run(['append', dir], readOnlyIntent);
  assert.equal(omitted.status, 0);
  const after = await readFile(path, 'utf8');
  assert.ok(after.startsWith(initial));
  assert.equal(JSON.parse(after.trim().split('\n').at(-1)).at, future, 'default remains max(now, predecessor), without adding 1ms');
});

test('init then validate succeeds with exit 0', async () => {
  const dir = await initialized();
  const r = run(['validate', dir]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^valid:/);
});

test('validate --json prints the full result', async () => {
  const r = run(['validate', join(FIXTURES, 'valid', 'lifecycle', '07-verified'), '--json']);
  assert.equal(r.status, 0);
  const result = JSON.parse(r.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.secret_scan.self_test, 'passed');
});

test('validate lists problems, exits 1 and never prints a secret', async () => {
  const r = run(['validate', join(FIXTURES, 'invalid', 'planted-secret-canary')]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^invalid: 1 problem/);
  assert.match(r.stdout, /\[secret\] events\.jsonl line 15/);
  assert.ok(!(r.stdout + r.stderr).includes(CANARY));
});

test('append reads one event from stdin and prints its id', async () => {
  const dir = await initialized();
  const r = run(['append', dir], readOnlyIntent);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^appended evt-0002/);
});

test('append exits 2 when the event is written but state.json still needs updating', async () => {
  const dir = await initialized();
  const stage = JSON.stringify({ actor: { role: 'ai', name: 'ai-deployer' }, session_id: 'session-a', type: 'stage_change', summary: 'Moving to plan', stage: { from: 'recon', to: 'plan' } });
  const r = run(['append', dir], stage);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /^appended evt-0002/);
  assert.match(r.stdout, /state-stage-matches-events/);
});

test('a refused append exits 1, writes nothing and never prints a secret', async () => {
  const dir = await initialized();
  const before = await readFile(join(dir, 'events.jsonl'), 'utf8');
  const r = run(['append', dir], readOnlyIntent.replace('read-only)', `read-only) ${CANARY}`));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^refused:/);
  assert.equal(await readFile(join(dir, 'events.jsonl'), 'utf8'), before);
  assert.ok(!(r.stdout + r.stderr).includes(CANARY));
});

test('init with missing options exits 64 and names what is missing', async () => {
  const dir = join(await tempDir(), 'watchover');
  const r = run(['init', dir, '--project', 'demo-app']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /--environment/);
});

test('append --file reads the event from a file', async () => {
  const dir = await initialized();
  const tmp = await tempDir();
  await writeFile(join(tmp, 'event.json'), readOnlyIntent);
  const r = run(['append', dir, '--file', join(tmp, 'event.json')]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('show serves the workspace on loopback until stopped', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [CLI, 'show', join(FIXTURES, 'valid', 'lifecycle', '07-verified'), '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const line = await new Promise((resolve, reject) => {
      child.stdout.once('data', (d) => resolve(String(d)));
      child.once('exit', (code) => reject(new Error(`show exited early with ${code}`)));
    });
    const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(line)?.[0];
    assert.ok(url, line);
    assert.match(line, /read-only/);
    const res = await fetch(`${url}state.json`);
    assert.equal(res.status, 200);
  } finally {
    child.kill('SIGTERM');
  }
});

test('show refuses a folder that does not exist', async () => {
  const r = run(['show', join(await tempDir(), 'missing')]);
  assert.equal(r.status, 1);
});
