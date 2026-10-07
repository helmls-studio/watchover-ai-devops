import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { startViewServer } from '../tools/lib/server.mjs';
import { REFRESH_BOUND_MS } from '../app/web-ui/freshness.mjs';
import { REPO, FIXTURES, subdirs, readWorkspace, tempDir } from './helpers/fixtures.mjs';
import { browserPython } from './helpers/python.mjs';

const SCRIPT = join(REPO, 'tests', 'browser', 'view_check.py');
const FOOTER = 'This page shows what the AI has recorded. Items marked verified cite evidence and a time. Nothing here is a live cloud reading.';
const SECTION_IDS = ['q-what', 'q-where', 'q-why', 'q-decision', 'q-trust', 'q-next'];
const STATUS_KINDS = ['verified-local', 'verified-remote', 'stale', 'unknown', 'blocked', 'assumed', 'user-confirmed'];

// Asynchronous on purpose: the view servers run in this process and must keep serving
// while the browser works.
function runBrowser(job) {
  return new Promise((resolve, reject) => {
    const child = spawn(browserPython(), [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`browser check failed (${code}): ${out}${err}`));
      resolve(JSON.parse(out));
    });
    child.stdin.end(JSON.stringify(job));
  });
}

const afterUpdate = (state, minutes) => new Date(Date.parse(state.identity.updated_at) + minutes * 60000).toISOString();
const rgb = (css) => (/rgba?\((\d+), (\d+), (\d+)/.exec(css) ?? []).slice(1).map(Number);
const isGreen = (css) => { const [r, g, b] = rgb(css); return g > r + 25 && g > b + 25; };
const exists = (p) => stat(p).then((s) => s.size > 0, () => false);

async function servePages(entries) {
  const views = [];
  const pages = [];
  for (const { name, dir, minutes } of entries) {
    const { state } = await readWorkspace(dir);
    const view = await startViewServer({ workspace: dir, port: 0 });
    views.push(view);
    pages.push({ name, url: view.url, fixed_time: afterUpdate(state, minutes), pending: state.pending_decision !== null });
  }
  return { pages, close: () => Promise.all(views.map((v) => v.close())) };
}

test('every valid fixture answers the six questions in a real browser', async () => {
  const entries = [];
  for (const group of ['lifecycle', 'status']) {
    for (const name of await subdirs(join(FIXTURES, 'valid', group))) entries.push({ name: `${group}-${name}`, dir: join(FIXTURES, 'valid', group, name), minutes: 2 });
  }
  const shots = process.env.WATCHOVER_SCREENSHOT_DIR ?? await tempDir('watchover-shots-');
  const served = await servePages(entries);
  try {
    const { pages } = await runBrowser({ mode: 'observe', pages: served.pages, screenshot_dir: shots });
    assert.equal(pages.length, entries.length);
    pages.forEach((p, i) => {
      const expected = served.pages[i];
      assert.equal(p.state, 'ready', `${p.name}: ${p.errorText}`);
      assert.deepEqual(p.sections.map((s) => s.id).sort(), [...SECTION_IDS].sort(), p.name);
      for (const s of p.sections) assert.ok(s.text.length > 40, `${p.name} ${s.id} is nearly empty`);
      assert.equal(p.footerText, FOOTER, p.name);
      assert.equal(p.footerVisible, true, `${p.name}: footer not visible`);
      assert.match(p.stateAge, /State updated 2 min ago/, p.name);
      assert.equal(p.decisionCard !== null, expected.pending, `${p.name}: approval card`);
      if (expected.pending) assert.match(p.decisionCard, /Reply in the AI session/);
      assert.equal(p.noRecentUpdate, false, p.name);
      assert.equal(p.progressBars, 0, p.name);
      assert.deepEqual(p.storage, { local: 0, session: 0, idb: 0, cookie: '' }, `${p.name}: browser storage used`);
      const origin = new URL(expected.url).origin;
      assert.ok(p.requests.length > 0 && p.requests.every((u) => u.startsWith(`${origin}/`)), `${p.name}: non-local request ${p.requests.join(' ')}`);
    });
    for (const p of pages) assert.ok(await exists(p.screenshot), `${p.name}: screenshot`);
  } finally {
    await served.close();
    if (!process.env.WATCHOVER_SCREENSHOT_DIR) await rm(shots, { recursive: true, force: true });
  }
});

test('the seven statuses are visually distinct, and only fresh verified facts are green', async () => {
  const served = await servePages([
    { name: 'all-statuses', dir: join(FIXTURES, 'valid', 'lifecycle', '05-incident'), minutes: 2 },
    { name: 'all-expired', dir: join(FIXTURES, 'valid', 'lifecycle', '07-verified'), minutes: 3 * 24 * 60 },
    { name: 'clock-behind', dir: join(FIXTURES, 'valid', 'lifecycle', '07-verified'), minutes: -120 },
  ]);
  try {
    const { pages: [all, expired, behind] } = await runBrowser({ mode: 'observe', pages: served.pages });
    assert.ok(behind.badges.some((b) => b.kind === 'verified-future'));
    for (const b of behind.badges) assert.equal(isGreen(b.background), false, `${b.kind} is green before its check time`);
    const styleOf = new Map(all.badges.map((b) => [b.kind, b]));
    for (const kind of STATUS_KINDS) assert.ok(styleOf.has(kind), `missing ${kind}`);
    const looks = STATUS_KINDS.map((k) => { const b = styleOf.get(k); return `${b.background}|${b.border}|${b.text}`; });
    assert.equal(new Set(looks).size, STATUS_KINDS.length, `not distinct: ${looks.join(' / ')}`);
    for (const b of all.badges) {
      assert.ok(b.text.length > 1, `${b.kind} relies on colour alone`);
      const fresh = !b.problem && (b.kind === 'verified-local' || b.kind === 'verified-remote');
      assert.equal(isGreen(b.background), fresh, `${b.kind} background ${b.background}`);
    }
    assert.ok(expired.badges.some((b) => b.kind === 'verified-expired'));
    for (const b of expired.badges) assert.equal(isGreen(b.background), false, `${b.kind} is green after expiry`);
  } finally {
    await served.close();
  }
});

test('an old state shows "No recent update" in the browser', async () => {
  const served = await servePages([{ name: 'old', dir: join(FIXTURES, 'valid', 'lifecycle', '03-long-operation'), minutes: 120 }]);
  try {
    const { pages: [p] } = await runBrowser({ mode: 'observe', pages: served.pages });
    assert.equal(p.noRecentUpdate, true);
  } finally {
    await served.close();
  }
});

test('five generic facts show actual values and a primary non-green problem in the browser', async () => {
  const dir = await tempDir('watchover-fact-cases-');
  await cp(join(FIXTURES, 'valid', 'lifecycle', '07-verified'), dir, { recursive: true });
  const { state } = await readWorkspace(dir);
  const base = { ...state.facts[0], checked_at: state.identity.updated_at, fresh_for_minutes: 60 };
  state.facts = [
    { ...base, key: 'case.positive', label: 'Positive subject', value: true, problem: false },
    { ...base, key: 'case.negative', label: 'Unexpected objects present', value: false, problem: false },
    { ...base, key: 'case.problem', label: 'Service response', value: false, problem: true },
    { ...base, key: 'case.stale', label: 'Stale subject', value: false, status: 'STALE', problem: false },
    { ...base, key: 'case.unknown', label: 'Unknown subject', value: null, status: 'UNKNOWN', checked_at: null, problem: false },
  ];
  await (await import('node:fs/promises')).writeFile(join(dir, 'state.json'), JSON.stringify(state));
  const served = await servePages([{ name: 'five-facts', dir, minutes: 2 }]);
  try {
    const { pages: [page] } = await runBrowser({ mode: 'observe', pages: served.pages });
    const facts = new Map(page.facts.map((f) => [f.label, f]));
    assert.equal(facts.get('Positive subject').value, 'Value: true');
    assert.equal(facts.get('Unexpected objects present').value, 'Value: false');
    assert.equal(facts.get('Unexpected objects present').problem, false);
    assert.equal(isGreen(facts.get('Unexpected objects present').background), true);
    const problem = facts.get('Service response');
    assert.equal(problem.value, 'Value: false');
    assert.equal(problem.indicator.toLowerCase(), 'problem found');
    assert.equal(isGreen(problem.background), false);
    assert.ok(problem.indicatorFont > problem.badgeFont);
    const indicatorAt = problem.text.toLowerCase().indexOf('problem found');
    assert.ok(indicatorAt >= 0 && indicatorAt < problem.text.indexOf('Verification:'));
    assert.equal(facts.get('Stale subject').kind, 'stale');
    assert.equal(facts.get('Unknown subject').value, 'Value: no value');
    assert.equal(facts.get('Unknown subject').kind, 'unknown');
    console.log(JSON.stringify({ case: 'five-browser-facts', facts: page.facts }));
  } finally { await served.close(); }
});

test('an on-disk state change appears without a reload, within the declared bound', async () => {
  const dir = await tempDir();
  await cp(join(FIXTURES, 'valid', 'lifecycle', '03-long-operation'), dir, { recursive: true });
  const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  const token = 'Pushing the web image to the VM now';
  state.activity.summary = token;
  const view = await startViewServer({ workspace: dir, port: 0 });
  try {
    const r = await runBrowser({ mode: 'refresh', url: view.url, workspace: dir, new_state: JSON.stringify(state, null, 2), token, bound_ms: REFRESH_BOUND_MS, fixed_time: afterUpdate(state, 2) });
    assert.equal(r.appeared, true, `not shown within ${REFRESH_BOUND_MS} ms`);
    assert.ok(r.elapsed_ms <= REFRESH_BOUND_MS);
    assert.equal(r.marker, 'kept', 'the page reloaded (a reload would clear the marker)');
  } finally {
    await view.close();
  }
});

test('a malformed state.json replaces the view with a visible error', async () => {
  const dir = await tempDir();
  await cp(join(FIXTURES, 'valid', 'lifecycle', '03-long-operation'), dir, { recursive: true });
  const view = await startViewServer({ workspace: dir, port: 0 });
  try {
    const r = await runBrowser({ mode: 'break', url: view.url, workspace: dir, broken_text: '{ "stage": ', bound_ms: REFRESH_BOUND_MS });
    assert.equal(r.before, 'ready');
    assert.equal(r.shown, true);
    assert.match(r.errorText, /state\.json/);
    assert.equal(r.sectionsLeft, 0, 'nothing is shown rather than a guess');
  } finally {
    await view.close();
  }
});

test('a missing events.jsonl shows a visible error', async () => {
  const dir = await tempDir();
  await cp(join(FIXTURES, 'valid', 'lifecycle', '03-long-operation'), dir, { recursive: true });
  await rm(join(dir, 'events.jsonl'));
  const view = await startViewServer({ workspace: dir, port: 0 });
  try {
    const { pages: [p] } = await runBrowser({ mode: 'observe', pages: [{ name: 'no-events', url: view.url }] });
    assert.equal(p.state, 'error');
    assert.match(p.errorText, /events\.jsonl/);
  } finally {
    await view.close();
  }
});
