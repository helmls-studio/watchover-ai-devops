import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, FIXTURES, readWorkspace, mutatedWorkspace } from './helpers/fixtures.mjs';
import { buildBrief, MAX_LINES } from '../tools/lib/brief.mjs';
import { renderView } from '../app/web-ui/render.mjs';
import { factDisplay, freshnessText, humanAction, remainingMinutes } from '../app/web-ui/freshness.mjs';

const CLI = join(REPO, 'tools', 'watchover.mjs');
const CANARY = ['AK', 'IA', 'WATCHOVERCANARY1'].join('');
const brief = (dir, now) => spawnSync(process.execPath, [CLI, 'brief', dir, ...(now ? ['--now', now] : [])], { encoding: 'utf8' });
const LIFE = (n) => join(FIXTURES, 'valid', 'lifecycle', n);
const NOW = Date.parse('2026-09-01T12:00:00Z');
const iso = (min) => new Date(NOW + min * 60000).toISOString();

async function snapshot(dir) {
  const out = {};
  const walk = async (d, rel) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p, `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = createHash('sha256').update(await readFile(p)).digest('hex');
    }
  };
  await walk(dir, '');
  return out;
}

const fact = (key, status, checked, window, extra = {}) => ({
  key, label: key, value: `${key} value`, status, source: status === 'USER_CONFIRMED' ? 'human' : 'remote_observation',
  class: 'resource', scope: 'synthetic', checked_at: checked, fresh_for_minutes: window, evidence: checked ? ['evidence/x.txt'] : [], ...extra,
});

test('CLI brief and the view classify the same facts the same way at a fixed time', async () => {
  const { state, events } = await readWorkspace(LIFE('07-verified'));
  state.facts = [
    fact('t.fresh', 'VERIFIED_REMOTE', iso(-10), 60),
    fact('t.at_expiry', 'VERIFIED_REMOTE', iso(-60), 60),
    fact('t.stale', 'STALE', iso(-300), 60),
    fact('t.unknown', 'UNKNOWN', null, null),
    fact('t.future', 'VERIFIED_LOCAL', iso(5), 60),
    fact('t.user', 'USER_CONFIRMED', null, null),
  ];
  const lines = buildBrief(state, events, NOW);
  const html = renderView(state, events, NOW);
  assert.equal(remainingMinutes(state.facts[0], NOW), 50);
  assert.equal(remainingMinutes(state.facts[1], NOW), 0);
  assert.equal(factDisplay(state.facts[1], NOW).kind, 'verified-expired', 'exactly at the end of the window is no longer current');
  for (const f of state.facts) {
    const d = factDisplay(f, NOW);
    const line = lines.find((l) => l.includes(` ${f.key}:`));
    assert.ok(line, f.key);
    assert.ok(line.includes(freshnessText(f, NOW)), `${f.key}: ${line}`);
    assert.match(html, new RegExp(`data-kind="${d.kind}"`), f.key);
    if (d.current) assert.ok(html.includes(freshnessText(f, NOW)), `${f.key} minutes shown in the view`);
    else assert.doesNotMatch(line, /fresh for/, `${f.key} must not read as current`);
  }
  assert.match(lines.find((l) => l.includes('t.fresh:')), /fresh for 50 more min/);
  assert.match(lines.find((l) => l.includes('t.user:')), /USER_CONFIRMED, not a current verified fact/);
});

test('200 facts: at most 30 lines, exact totals and an exact omitted count with its location', async () => {
  const { state, events } = await readWorkspace(LIFE('07-verified'));
  state.facts = Array.from({ length: 200 }, (_, i) => fact(`many.f${String(i).padStart(3, '0')}`, i % 10 === 0 ? 'BLOCKED' : 'UNKNOWN', null, null, i % 10 === 0 ? { blocked_by: 'synthetic' } : {}));
  const lines = buildBrief(state, events, NOW);
  assert.ok(lines.length <= MAX_LINES, `${lines.length} lines`);
  assert.match(lines.join('\n'), /Facts: 200 total .* unknown 180 · blocked 20/);
  const listed = lines.filter((l) => l.startsWith('  ')).length;
  assert.match(lines.at(-1), new RegExp(`^${200 - listed} more facts not shown; see state\\.json /facts\\.$`));
  assert.ok(lines.filter((l) => l.startsWith('  ')).slice(0, 20).every((l) => l.includes('BLOCKED')), 'blocked facts are listed first');
});

test('pending, working, terminal and approved records: the human action matches the view banner', async () => {
  for (const [name, expectHuman] of [['02-approval-pending', true], ['03-long-operation', false], ['10-closed', null], ['08-handoff', null]]) {
    const { state, events } = await readWorkspace(LIFE(name));
    const lines = buildBrief(state, events, NOW);
    const html = renderView(state, events, NOW);
    const action = humanAction(state);
    if (expectHuman !== null) assert.equal(Boolean(action), expectHuman, name);
    if (action) {
      assert.ok(lines.some((l) => l.startsWith('Human action now: ')) && !lines.join('\n').includes('nothing needs the human'), name);
      assert.match(html, /<strong>Your next action:<\/strong>/, name);
    } else {
      assert.ok(lines.includes('Human action now: nothing needs the human right now'), name);
      assert.match(html, /Nothing needs you right now\./, name);
    }
    assert.ok(lines.length <= MAX_LINES, name);
    const approvals = lines.find((l) => l.startsWith('Recorded approvals'));
    assert.match(approvals, /history, not new authority/);
    const approved = events.filter((e) => e.type === 'decision' && e.decision.outcome === 'approved');
    for (const e of approved.slice(-3)) assert.ok(approvals.includes(e.id), `${name}: ${e.id}`);
  }
});

test('the CLI brief is read-only: workspace bytes and file set are unchanged', async () => {
  for (const name of ['02-approval-pending', '05-incident', '10-closed']) {
    const before = await snapshot(LIFE(name));
    const r = brief(LIFE(name), '2026-09-01T12:00:00Z');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.trimEnd().split('\n').length <= MAX_LINES, name);
    assert.deepEqual(await snapshot(LIFE(name)), before, name);
  }
});

test('an invalid record is refused with no summary, no secret, and nothing written', async () => {
  const cases = {
    malformed: join(FIXTURES, 'invalid', 'malformed-state-json'),
    schema: await mutatedWorkspace(LIFE('07-verified'), (ws) => { ws.state.facts[0].value = 'x'.repeat(301); }),
    inconsistent: await mutatedWorkspace(LIFE('07-verified'), (ws) => {
      ws.state.pending_decision = {
        id: 'dec-unrequested', categories: ['billable'], action: 'Create a server', targets: ['server'], why: 'needed',
        cost_or_blast_radius: 'small', reversibility: 'yes', rollback: 'delete it', success_check: 'answers',
        reply_options: [{ reply: 'approve', meaning: 'go' }], requested_at: ws.state.identity.updated_at,
      };
    }),
    secret: await mutatedWorkspace(LIFE('07-verified'), () => {}),
  };
  await mkdir(join(cases.secret, 'evidence'), { recursive: true });
  await writeFile(join(cases.secret, 'evidence', 'out.txt'), `key=${CANARY}\n`);
  for (const [name, dir] of Object.entries(cases)) {
    const before = await snapshot(dir);
    const r = brief(dir, '2026-09-01T12:00:00Z');
    assert.equal(r.status, 1, name);
    assert.match(r.stdout, /^refused: the record is not valid; no summary is shown/, name);
    assert.doesNotMatch(r.stdout, /WatchOver brief|Human action now|Facts: /, name);
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(CANARY), name);
    assert.deepEqual(await snapshot(dir), before, name);
  }
  // Positive control: the same instrument summarizes a valid record.
  assert.equal(brief(LIFE('07-verified'), '2026-09-01T12:00:00Z').status, 0);
});

test('brief rejects an unparsable --now as a usage error', () => {
  assert.equal(brief(LIFE('07-verified'), 'not-a-time').status, 64);
});

test('brief honestly counts many open intents and points to the complete retrievable log listing', async () => {
  const { state, events } = await readWorkspace(LIFE('07-verified'));
  for (let i = 0; i < 45; i++) events.push({ type: 'intent', id: `evt-${9000 + i}` });
  events.push({ type: 'result', related: ['evt-9000'] });
  const lines = buildBrief(state, events, NOW);
  const open = lines.find((l) => l.startsWith('Open intents:'));
  assert.match(open, /44 \(evt-9001, evt-9002, evt-9003; 41 more\)/);
  assert.match(open, /complete listing: events\.jsonl, every type=intent id with no type=result related reference/);
  const resultIds = new Set(events.filter((e) => e.type === 'result').flatMap((e) => e.related));
  const retrieved = events.filter((e) => e.type === 'intent' && !resultIds.has(e.id)).map((e) => e.id);
  assert.equal(retrieved.length, 44);
  assert.ok(retrieved.includes('evt-9044'), 'the last omitted ID is discoverable');
  assert.ok(lines.length <= MAX_LINES);
  assert.match(lines.join('\n'), /snapshot missing|without snapshot locators/);
});
