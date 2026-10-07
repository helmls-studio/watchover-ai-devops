import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, FIXTURES, readWorkspace, tempDir } from './helpers/fixtures.mjs';
import { initWorkspace } from '../tools/lib/workspace.mjs';
import { startViewServer } from '../tools/lib/server.mjs';
import { validateWorkspace } from '../tools/lib/validate.mjs';

const read = (p) => readFile(join(REPO, p), 'utf8');
const SCENARIOS = join(FIXTURES, 'valid', 'scenarios');

test('continuation stops and restores the same synthetic workspace using the real show command', async () => {
  const ws = join(await tempDir(), 'watchover');
  assert.equal((await initWorkspace(ws, { project: 'continuation-control', environment: 'synthetic', provider: 'local', session: 'resume-a' })).ok, true);
  const expected = await readWorkspace(ws);
  async function show(port) {
    const child = spawn(process.execPath, [join(REPO, 'tools', 'watchover.mjs'), 'show', ws, '--port', String(port)]);
    const url = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`show exited ${code}`)));
      child.stdout.once('data', (d) => resolve(/http:\/\/127\.0\.0\.1:\d+\//.exec(String(d))?.[0]));
    });
    assert.ok(url);
    return { child, url, stop: () => new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); }) };
  }
  const first = await show(0);
  try {
    assert.deepEqual(await (await fetch(`${first.url}state.json`)).json(), expected.state);
  } finally { await first.stop(); }
  await assert.rejects(fetch(`${first.url}state.json`), 'remembered URL is unreachable after stop');
  const restored = await show(Number(new URL(first.url).port));
  try {
    assert.equal(restored.url, first.url);
    assert.deepEqual(await (await fetch(`${restored.url}state.json`)).json(), expected.state);
    assert.equal(await (await fetch(`${restored.url}events.jsonl`)).text(), expected.eventsText);
    assert.match(await (await fetch(restored.url)).text(), /WatchOver/);
  } finally { await restored.stop(); }
  await assert.rejects(fetch(restored.url));
  console.log(JSON.stringify({ case: 'same-workspace-view-restoration', workspace: ws, project: expected.state.identity.project_alias, first_url: first.url, restored_url: restored.url, stopped_urls_unreachable: true, restored_state_and_events_equal: true }));
});

test('show --port 0 binds a real port and serves this workspace', async () => {
  const ws = join(SCENARIOS, 'view-handoff-confirmed');
  const view = await startViewServer({ workspace: ws, port: 0 });
  try {
    const port = Number(new URL(view.url).port);
    assert.ok(port > 0, view.url);
    const served = await (await fetch(new URL('/state.json', view.url))).json();
    assert.equal(served.identity.project_alias, (await readWorkspace(ws)).state.identity.project_alias);
  } finally {
    await view.close();
  }
});

test('the CLI prints the actual URL it serves', async () => {
  const ws = join(SCENARIOS, 'view-handoff-confirmed');
  const child = spawn(process.execPath, [join(REPO, 'tools', 'watchover.mjs'), 'show', ws, '--port', '0']);
  try {
    const line = await new Promise((resolve, reject) => {
      child.stdout.once('data', (d) => resolve(String(d)));
      child.once('error', reject);
    });
    const url = /at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(line)?.[1];
    assert.ok(url, line);
    assert.equal((await fetch(new URL('/state.json', url))).status, 200);
  } finally {
    child.kill('SIGTERM');
  }
});

test('the handoff fixtures validate and keep page confirmation, the exception and approval apart', async () => {
  const confirmed = await readWorkspace(join(SCENARIOS, 'view-handoff-confirmed'));
  const exception = await readWorkspace(join(SCENARIOS, 'view-handoff-exception'));
  for (const name of ['view-handoff-confirmed', 'view-handoff-exception']) {
    assert.equal((await validateWorkspace(join(SCENARIOS, name))).ok, true, name);
  }
  const fact = (ws, key) => ws.state.facts.find((f) => f.key === key);
  assert.equal(fact(confirmed, 'view.page_confirmed').status, 'USER_CONFIRMED');
  assert.equal(fact(exception, 'view.page_unreachable').status, 'BLOCKED');
  assert.ok(fact(exception, 'view.page_unreachable').blocked_by);
  assert.equal(fact(exception, 'view.continue_with_disclosure').value, 'continue with disclosure');
  for (const ws of [confirmed, exception]) {
    // The page reply is not a gate decision; the action approval is still pending.
    assert.equal(ws.events.filter((e) => e.type === 'decision').length, 0);
    assert.deepEqual(ws.state.pending_decision.categories, ['plan_acceptance']);
    assert.equal(ws.state.next.decision_owner, 'human');
    assert.doesNotMatch(ws.state.pending_decision.reversibility, /fully reversible/i);
    assert.match(ws.state.pending_decision.reversibility, /Can stop and remove the containers/);
    assert.match(ws.state.pending_decision.reversibility, /requests already served cannot be undone/);
    assert.match(ws.state.pending_decision.reversibility, /Unsaved container data may be lost/);
  }
});

test('the skills and README require the early handoff and the narrow exception, consistently', async () => {
  const router = await read('skills/router.md');
  const plan = await read('skills/stages/plan.md');
  const readme = await read('README.md');
  assert.match(router, /show <workspace>.*yourself|yourself.*show/s);
  assert.match(router, /--port 0/);
  assert.match(router, /Silence, a running server or an ambiguous "continue" is not that reply/);
  assert.match(router, /genuinely unreachable/);
  assert.match(router, /Neither the page reply nor that choice approves cost, DNS or\s+deletion/);
  assert.match(plan, /continue with disclosure/);
  assert.match(plan, /view\.page_unreachable/);
  assert.match(plan, /not a gate, so it is not a `decision` event/);
  assert.match(plan, /Refusing a page that does work is\s+not this case/);
  assert.match(readme, /explicitly\s+choose to continue with that limitation disclosed/);
  for (const text of [router, plan, readme]) {
    assert.doesNotMatch(text, /Never depend on the view running/i);
    assert.doesNotMatch(text, /start the view (service )?yourself, human|ask (them|the human) to start/i);
  }
});
