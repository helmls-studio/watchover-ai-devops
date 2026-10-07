import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { initWorkspace, appendEvent, ROUTER_SKILL, POINTER_FILE } from '../tools/lib/workspace.mjs';
import { validateWorkspace } from '../tools/lib/validate.mjs';
import { tempDir } from './helpers/fixtures.mjs';

const CANARY = ['AK', 'IA', 'WATCHOVERCANARY1'].join('');
const OPTIONS = { project: 'demo-app', environment: 'trial on GCP', provider: 'gcp', session: 'session-a' };
const AI = { role: 'ai', name: 'ai-deployer' };

async function freshWorkspace() {
  const dir = join(await tempDir(), 'watchover');
  const result = await initWorkspace(dir, OPTIONS);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return dir;
}
const eventsText = (dir) => readFile(join(dir, 'events.jsonl'), 'utf8');
const exists = (p) => stat(p).then(() => true, () => false);

// ---- Initialize ----

test('init creates a valid workspace with state, one stage event, evidence/ and a pointer file', async () => {
  const dir = await freshWorkspace();
  assert.deepEqual((await readdir(dir)).sort(), [POINTER_FILE, '.gitignore', 'events.jsonl', 'evidence', 'state.json'].sort());
  assert.ok((await stat(join(dir, 'evidence'))).isDirectory());
  const result = await validateWorkspace(dir);
  assert.deepEqual(result.errors, []);
});

test('init records the first stage change and a recon state built from the options', async () => {
  const dir = await freshWorkspace();
  const lines = (await eventsText(dir)).trimEnd().split('\n');
  assert.equal(lines.length, 1);
  const first = JSON.parse(lines[0]);
  assert.equal(first.id, 'evt-0001');
  assert.deepEqual(first.stage, { from: null, to: 'recon' });
  const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  assert.equal(state.stage, 'recon');
  assert.equal(state.pending_decision, null);
  assert.deepEqual(
    [state.identity.project_alias, state.identity.target_environment, state.identity.provider_profile, state.identity.mode, state.identity.session_id],
    ['demo-app', 'trial on GCP', 'gcp', 'basic', 'session-a'],
  );
  assert.equal(state.identity.updated_at, first.at);
  assert.equal(state.handoff.read_first[0], ROUTER_SKILL);
});

test('the pointer file tells a fresh AI where to start, without relying on auto-loading', async () => {
  const dir = await freshWorkspace();
  const text = await readFile(join(dir, POINTER_FILE), 'utf8');
  assert.ok(text.includes(ROUTER_SKILL), 'names the router skill by absolute path');
  assert.ok(text.includes('state.json') && text.includes('events.jsonl') && text.includes('evidence/'));
  assert.ok(ROUTER_SKILL.endsWith(join('skills', 'router.md')));
});

test('init refuses a folder that already has content and changes nothing', async () => {
  const dir = await tempDir();
  await writeFile(join(dir, 'notes.txt'), 'keep me\n');
  const result = await initWorkspace(dir, OPTIONS);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.check === 'init'));
  assert.deepEqual(await readdir(dir), ['notes.txt']);
});

test('init refuses options that would make an invalid state, before writing anything', async () => {
  const dir = join(await tempDir(), 'watchover');
  const result = await initWorkspace(dir, { ...OPTIONS, project: 'Demo App' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.check === 'schema' && e.pointer === '/identity/project_alias'));
  assert.equal(await exists(dir), false);
});

test('init refuses a secret in its options and never repeats it', async () => {
  const dir = join(await tempDir(), 'watchover');
  const result = await initWorkspace(dir, { ...OPTIONS, environment: `trial ${CANARY}` });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.check === 'secret'));
  assert.ok(!JSON.stringify(result).includes(CANARY));
  assert.equal(await exists(dir), false);
});

test('init requires the identity options', async () => {
  const dir = join(await tempDir(), 'watchover');
  const result = await initWorkspace(dir, { project: 'demo-app' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => e.check), ['init']);
  assert.equal(await exists(dir), false);
});

test('new workspace ignore guard excludes actual runtime files from normal containing-repo staging', async () => {
  const repo = await tempDir('watchover-git-');
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  git('init', '-q');
  const hostIgnore = '# business rules\n*.business-cache\n';
  await writeFile(join(repo, '.gitignore'), hostIgnore);
  await writeFile(join(repo, 'known-present.txt'), 'normal tracked control\n');
  git('add', '.');
  const ws = join(repo, 'watchover');
  assert.equal((await initWorkspace(ws, OPTIONS)).ok, true);
  await writeFile(join(ws, 'evidence', 'actual-control.txt'), 'synthetic private evidence\n');
  for (const path of ['state.json', 'events.jsonl', 'evidence/actual-control.txt']) {
    assert.ok((await readFile(join(ws, path))).length > 0, `${path} known present`);
    assert.ok(git('check-ignore', `watchover/${path}`).includes(path));
  }
  assert.equal(await readFile(join(repo, '.gitignore'), 'utf8'), hostIgnore);
  git('add', '.');
  const staged = git('diff', '--cached', '--name-only');
  assert.ok(staged.includes('known-present.txt'), 'same index instrument sees positive control');
  assert.ok(!staged.includes('watchover/'));
  const status = git('status', '--short');
  assert.ok(status.includes('known-present.txt'));
  assert.ok(!status.includes('watchover/'));
});

// ---- Append ----

const stageEvent = (from, to) => JSON.stringify({ actor: AI, session_id: 'session-a', type: 'stage_change', summary: `Moving to ${to}`, stage: { from, to } });

test('append adds exactly one line and never rewrites earlier bytes', async () => {
  const dir = await freshWorkspace();
  const before = await eventsText(dir);
  const result = await appendEvent(dir, stageEvent('recon', 'plan'));
  assert.equal(result.appended, true, JSON.stringify(result.errors));
  assert.equal(result.id, 'evt-0002');
  const after = await eventsText(dir);
  assert.ok(after.startsWith(before));
  const added = after.slice(before.length);
  assert.equal(added.split('\n').length, 2, 'one line plus its newline');
  const ev = JSON.parse(added);
  assert.equal(ev.schema_version, '0.1');
  assert.ok(Date.parse(ev.at) >= Date.parse(JSON.parse(before).at));
});

test('an appended stage change needs a matching state write before the workspace is consistent', async () => {
  const dir = await freshWorkspace();
  const result = await appendEvent(dir, stageEvent('recon', 'plan'));
  assert.equal(result.appended, true);
  assert.equal(result.workspace.ok, false);
  assert.deepEqual(result.workspace.errors.map((e) => e.check), ['state-stage-matches-events']);
  const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  state.stage = 'plan';
  await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2));
  assert.deepEqual((await validateWorkspace(dir)).errors, []);
});

test('append keeps an explicit id and time when they are valid', async () => {
  const dir = await freshWorkspace();
  const first = JSON.parse(await eventsText(dir));
  const at = new Date(Date.parse(first.at) + 60000).toISOString();
  const result = await appendEvent(dir, JSON.stringify({ ...JSON.parse(stageEvent('recon', 'plan')), id: 'evt-0005', at }));
  assert.equal(result.appended, true, JSON.stringify(result.errors));
  assert.equal(result.id, 'evt-0005');
  assert.equal(JSON.parse((await eventsText(dir)).trimEnd().split('\n')[1]).at, at);
});

async function expectRefused(dir, input, check) {
  const before = await eventsText(dir);
  const result = await appendEvent(dir, input);
  assert.equal(result.appended, false);
  assert.ok(result.errors.some((e) => e.check === check), JSON.stringify(result.errors));
  assert.equal(await eventsText(dir), before, 'events.jsonl is byte-identical');
  return result;
}

test('append refuses a schema-invalid event', async () => {
  const dir = await freshWorkspace();
  await expectRefused(dir, JSON.stringify({ actor: AI, session_id: 'session-a', type: 'teleport', summary: 'x' }), 'schema');
});

test('append refuses an event that breaks an event rule', async () => {
  const dir = await freshWorkspace();
  await expectRefused(dir, stageEvent('plan', 'executing'), 'stage-chain');
  await expectRefused(dir, JSON.stringify({ actor: AI, session_id: 'session-a', type: 'result', summary: 'done', outcome: 'succeeded', related: ['evt-0001'] }), 'event-links');
});

test('append refuses an event carrying a secret and never repeats it', async () => {
  const dir = await freshWorkspace();
  const input = JSON.stringify({ actor: AI, session_id: 'session-a', type: 'intent', summary: 'Create the VM', target: 'demo-cloud-project', action: `gcloud compute instances create demo-app-vm --metadata=key=${CANARY}`, action_kinds: ['remote_mutating'] });
  const result = await expectRefused(dir, input, 'secret');
  assert.ok(!JSON.stringify(result).includes(CANARY));
});

test('append takes exactly one JSON object', async () => {
  const dir = await freshWorkspace();
  await expectRefused(dir, `[${stageEvent('recon', 'plan')}]`, 'append');
  await expectRefused(dir, `${stageEvent('recon', 'plan')}\n${stageEvent('plan', 'recon')}`, 'append');
  await expectRefused(dir, '{ "type": ', 'append');
});

test('append refuses when the existing log is damaged', async () => {
  const dir = await freshWorkspace();
  await writeFile(join(dir, 'events.jsonl'), (await eventsText(dir)).trimEnd());
  await expectRefused(dir, stageEvent('recon', 'plan'), 'append');
  const tampered = await freshWorkspace();
  await writeFile(join(tampered, 'events.jsonl'), (await eventsText(tampered)).replace('"recon"', '"closed"'));
  await expectRefused(tampered, stageEvent('recon', 'plan'), 'stage-chain');
});

test('append refuses a folder that is not a workspace', async () => {
  const dir = await tempDir();
  await mkdir(join(dir, 'evidence'));
  const result = await appendEvent(dir, stageEvent('recon', 'plan'));
  assert.equal(result.appended, false);
  assert.ok(result.errors.some((e) => e.check === 'append'));
  assert.equal(await exists(join(dir, 'events.jsonl')), false);
});

test('a filled-in time never runs earlier than the last recorded event', async () => {
  const dir = await freshWorkspace();
  const ahead = new Date(Date.now() + 5000).toISOString();
  const first = await appendEvent(dir, JSON.stringify({ ...JSON.parse(stageEvent('recon', 'plan')), at: ahead }));
  assert.equal(first.appended, true, JSON.stringify(first.errors));
  const second = await appendEvent(dir, stageEvent('plan', 'awaiting_decision'));
  assert.equal(second.appended, true, JSON.stringify(second.errors));
  const last = JSON.parse((await eventsText(dir)).trimEnd().split('\n').at(-1));
  assert.ok(Date.parse(last.at) >= Date.parse(ahead));
});
