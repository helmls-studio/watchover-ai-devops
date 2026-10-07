import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderView } from '../app/web-ui/render.mjs';
import { FIXTURES, subdirs, readWorkspace } from './helpers/fixtures.mjs';

const SECTIONS = [
  ['q-what', 'What are we doing?'],
  ['q-where', 'Where are we now?'],
  ['q-why', 'Why this plan?'],
  ['q-decision', 'What needs my decision?'],
  ['q-trust', 'What can I trust?'],
  ['q-next', 'What happens next?'],
];
const lifecycle = (step) => readWorkspace(join(FIXTURES, 'valid', 'lifecycle', step));
const after = (iso, minutes) => Date.parse(iso) + minutes * 60000;
const render = async (step, minutesAfterUpdate = 2) => {
  const { state, events } = await lifecycle(step);
  return renderView(state, events, after(state.identity.updated_at, minutesAfterUpdate));
};
const kinds = (html) => new Set([...html.matchAll(/data-kind="([a-z-]+)"/g)].map((m) => m[1]));

test('fact values, problem priority and verification are separate for five generic cases', async () => {
  const { state, events } = await lifecycle('07-verified');
  const base = { ...state.facts[0], label: 'Checked subject', checked_at: state.identity.updated_at, fresh_for_minutes: 60 };
  state.facts = [
    { ...base, key: 'case.positive', label: 'Positive subject', value: true, problem: false },
    { ...base, key: 'case.healthy-negative', label: 'Unexpected objects present', value: false, problem: false },
    { ...base, key: 'health.problem', label: 'Service response', value: false, problem: true, scope: `${state.resources[0].id} synthetic` },
    { ...base, key: 'case.stale', label: 'Stale subject', value: false, status: 'STALE', problem: false },
    { ...base, key: 'case.unknown', label: 'Unknown subject', value: null, status: 'UNKNOWN', checked_at: null, problem: false },
  ];
  const html = renderView(state, events, after(state.identity.updated_at, 2));
  const facts = html.slice(html.indexOf('<ul class="facts">'), html.indexOf('<h3>Resources'));
  const items = [...facts.matchAll(/<li class="fact[^"]*">[\s\S]*?<\/li>/g)].map((m) => m[0]);
  assert.equal(items.length, 5);
  const problem = items.find((x) => x.includes('Service response'));
  assert.equal(items[0], problem);
  assert.match(problem, /class="fact fact-problem"/);
  assert.ok(problem.indexOf('Problem found') < problem.indexOf('Verification:'));
  assert.match(problem, /Value: false/);
  assert.match(problem, /Verification:.*data-kind="verified-/);
  assert.match(items.find((x) => x.includes('Positive subject')), /Value: true/);
  assert.doesNotMatch(items.find((x) => x.includes('Unexpected objects present')), /Problem found|fact-problem/);
  assert.match(items.find((x) => x.includes('Stale subject')), /data-kind="stale"/);
  assert.match(items.find((x) => x.includes('Unknown subject')), /Value:.*no value/);
  const service = /<li class="service fact-problem"[\s\S]*?<\/li>/.exec(html)?.[0];
  assert.ok(service?.includes('Problem found'));
  const css = await readFile(new URL('../app/web-ui/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.problem-indicator\s*\{[^}]*background: var\(--urgent\)/);
  assert.match(css, /\.fact-problem \.badge\[data-kind="verified-remote"\]\s*\{[^}]*background: transparent/);
});

test('every valid fixture answers the six questions', async () => {
  for (const group of ['lifecycle', 'status']) {
    for (const name of await subdirs(join(FIXTURES, 'valid', group))) {
      const { state, events } = await readWorkspace(join(FIXTURES, 'valid', group, name));
      const html = renderView(state, events, after(state.identity.updated_at, 2));
      for (const [id, question] of SECTIONS) {
        assert.match(html, new RegExp(`<section[^>]*id="${id}"`), `${group}/${name} ${id}`);
        assert.ok(html.includes(question), `${group}/${name} ${question}`);
      }
    }
  }
});

test('a pending decision gets a prominent card saying what to reply and where', async () => {
  const html = await render('02-approval-pending');
  assert.match(html, /id="decision-card"/);
  assert.ok(html.indexOf('id="decision-card"') < html.indexOf('id="q-what"'), 'the card comes first');
  for (const text of ['Plan acceptance', 'Billable', 'approve B', 'About 28–36 USD per month', 'Reversible', 'Reply in the AI session']) {
    assert.ok(html.includes(text), text);
  }
});

test('without a pending decision the view says so plainly', async () => {
  const html = await render('03-long-operation');
  assert.doesNotMatch(html, /id="decision-card"/);
  assert.ok(html.includes('Nothing needs your decision right now'));
});

test('all seven statuses appear with their own display kind', async () => {
  const found = kinds(await render('05-incident'));
  for (const kind of ['verified-local', 'verified-remote', 'stale', 'unknown', 'blocked', 'assumed', 'user-confirmed']) {
    assert.ok(found.has(kind), kind);
  }
});

test('verified facts past their freshness window are never shown as fresh', async () => {
  const found = kinds(await render('07-verified', 3 * 24 * 60));
  assert.ok(found.has('verified-expired'));
  assert.ok(!found.has('verified-local') && !found.has('verified-remote'));
});

test('state age is always visible', async () => {
  assert.ok((await render('07-verified', 2)).includes('State updated 2 min ago'));
});

test('an old state shows "No recent update" instead of implying progress', async () => {
  assert.ok((await render('03-long-operation', 120)).includes('No recent update'));
  assert.ok(!(await render('03-long-operation', 2)).includes('No recent update'));
});

test('a long operation past its expected range is called out without a progress bar', async () => {
  const { state, events } = await lifecycle('03-long-operation');
  const at = (m) => after(state.activity.started_at, m);
  assert.ok(renderView(state, events, at(20)).includes('longer than the expected 8–15 min'));
  assert.ok(!renderView(state, events, at(10)).includes('longer than the expected'));
  assert.doesNotMatch(renderView(state, events, at(10)), /<progress|role="progressbar"/);
});

test('resources render as a tree with billable flags', async () => {
  const html = await render('07-verified');
  assert.match(html, /data-resource="vm-demo-app"[\s\S]*?<ul[\s\S]*?data-resource="disk-demo-app-boot"/);
  const vm = html.slice(html.indexOf('data-resource="vm-demo-app"'));
  assert.ok(vm.slice(0, vm.indexOf('<ul')).includes('billable'));
});

test('a verified problem is marked in words', async () => {
  assert.ok((await render('04-verification-failed')).includes('Problem found'));
});

test('evidence locators are shown as text, never as links', async () => {
  const html = await render('07-verified');
  assert.ok(html.includes('evidence/0030-web-health.txt'));
  assert.doesNotMatch(html, /<a [^>]*href="[^"]*evidence/);
});

test('handoff readiness and next step are shown', async () => {
  const html = await render('08-handoff');
  for (const text of ['All three containers running', 'No backup of the database volume exists', 'Decision owner', 'human']) {
    assert.ok(html.includes(text), text);
  }
});

test('recent events are listed newest first', async () => {
  const html = await render('03-long-operation');
  assert.ok(html.indexOf('Build the images') < html.indexOf('Create the tier B VM'));
});

test('every recorded value is escaped', async () => {
  const { state, events } = await lifecycle('07-verified');
  state.facts[0].label = '<img src=x onerror=alert(1)>';
  const html = renderView(state, events, after(state.identity.updated_at, 2));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<img'));
});

test('a state without the expected shape is refused rather than guessed at', () => {
  assert.throws(() => renderView({}, [], Date.now()), /expected shape/);
});

test('a fact marked stale before its window ended is not described as having expired', async () => {
  const html = await render('05-incident');
  assert.ok(!html.includes('in the future'), 'no clock-mismatch wording for an early STALE mark');
  assert.ok(!/window ended in/.test(html));
});

// ---- R3 ----

test('facts checked after the viewing clock are never shown as fresh', async () => {
  const found = kinds(await render('07-verified', -120));
  assert.ok(found.has('verified-future'));
  assert.ok(!found.has('verified-local') && !found.has('verified-remote'));
});

test('a future-dated state shows a clock problem instead of implying progress', async () => {
  const html = await render('07-verified', -10);
  assert.match(html, /id="clock-problem"/);
  assert.match(html, /Clock problem/);
  assert.match(html, /Nothing on this page shows current progress/);
});

test('the initial stage event reads as a start, not an unrecognised stage', async () => {
  const html = await render('01-recon');
  assert.ok(!html.includes('Unrecognised stage'), 'no unrecognised stage for a valid record');
  assert.ok(html.includes('(Start → Recon / preflight (read-only))'));
});

test('facts with a future check time are listed after the fresh ones, never among them', async () => {
  const { state, events } = await lifecycle('07-verified');
  const future = state.facts.find((f) => f.key === 'app.web_health');
  future.checked_at = new Date(after(state.identity.updated_at, 60)).toISOString();
  const html = renderView(state, events, after(state.identity.updated_at, 2));
  const factsList = html.slice(html.indexOf('<ul class="facts">'), html.indexOf('<h3>Resources'));
  const order = [...factsList.matchAll(/class="badge" data-kind="([a-z-]+)"/g)].map((m) => m[1]).filter((k) => k.startsWith('verified'));
  const first = order.indexOf('verified-future');
  assert.ok(first > 0 && order.slice(first).every((k) => k === 'verified-future' || k === 'verified-expired' || !k.startsWith('verified-')), order.join(' '));
});
