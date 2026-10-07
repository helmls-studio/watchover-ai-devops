import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { checkSchema, compileSchema } from '../tools/lib/schema-subset.mjs';
import { FIXTURES, SCHEMA_DIR, subdirs, readWorkspace, loadJson } from './helpers/fixtures.mjs';

const STATUSES = ['ASSUMED', 'USER_CONFIRMED', 'VERIFIED_LOCAL', 'VERIFIED_REMOTE', 'STALE', 'UNKNOWN', 'BLOCKED'];
const LIFECYCLE = [
  ['01-recon', 'recon'],
  ['02-approval-pending', 'awaiting_decision'],
  ['03-long-operation', 'executing'],
  ['04-verification-failed', 'verifying'],
  ['05-incident', 'incident'],
  ['06-recovered', 'recovered'],
  ['07-verified', 'verifying'],
  ['08-handoff', 'handoff'],
  ['09-teardown', 'teardown'],
  ['10-closed', 'closed'],
];

const stateSchema = () => loadJson(join(SCHEMA_DIR, 'state.schema.json'));
const eventSchema = () => loadJson(join(SCHEMA_DIR, 'event.schema.json'));

async function validDirs() {
  const dirs = [];
  for (const group of ['lifecycle', 'status']) {
    for (const name of await subdirs(join(FIXTURES, 'valid', group))) dirs.push(join(FIXTURES, 'valid', group, name));
  }
  return dirs;
}

test('every product schema uses only the supported keyword subset', async () => {
  const files = (await readdir(SCHEMA_DIR)).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(files, ['event.schema.json', 'state.schema.json']);
  for (const f of files) {
    const schema = await loadJson(join(SCHEMA_DIR, f));
    assert.doesNotThrow(() => checkSchema(schema), f);
  }
});

test('both schemas use exactly the seven FT-7 status strings', async () => {
  const s = await stateSchema();
  const e = await eventSchema();
  assert.deepEqual(s.$defs.status.enum, STATUSES);
  assert.deepEqual(e.$defs.status.enum, STATUSES);
});

test('both schemas share the same stage values, covering every Annex E stage', async () => {
  const s = await stateSchema();
  const e = await eventSchema();
  assert.deepEqual(s.$defs.stage.enum, e.$defs.stage.enum);
  assert.deepEqual(s.$defs.stage.enum, [
    'recon', 'plan', 'awaiting_decision', 'executing', 'verifying',
    'handoff', 'incident', 'recovered', 'teardown', 'closed',
  ]);
});

test('every valid fixture state and event is schema-valid', async () => {
  const validateState = compileSchema(await stateSchema());
  const validateEvent = compileSchema(await eventSchema());
  const dirs = await validDirs();
  assert.ok(dirs.length >= 17);
  for (const dir of dirs) {
    const { state, events } = await readWorkspace(dir);
    assert.deepEqual(validateState(state), [], `${dir}/state.json`);
    events.forEach((ev, i) => assert.deepEqual(validateEvent(ev), [], `${dir}/events.jsonl line ${i + 1}`));
  }
});

test('the lifecycle fixture covers the ten required steps in order', async () => {
  assert.deepEqual(await subdirs(join(FIXTURES, 'valid', 'lifecycle')), LIFECYCLE.map(([d]) => d));
  for (const [dir, stage] of LIFECYCLE) {
    const { state } = await readWorkspace(join(FIXTURES, 'valid', 'lifecycle', dir));
    assert.equal(state.stage, stage, dir);
  }
});

test('lifecycle steps carry the situations the verification standard names', async () => {
  const step = async (d) => (await readWorkspace(join(FIXTURES, 'valid', 'lifecycle', d))).state;
  const pending = (await step('02-approval-pending')).pending_decision;
  assert.deepEqual(pending.categories, ['plan_acceptance', 'billable']);
  const longOp = (await step('03-long-operation')).activity;
  assert.ok(longOp.expected_duration && longOp.slow_reason && longOp.started_at);
  assert.ok((await step('04-verification-failed')).facts.some((f) => f.problem === true && f.status === 'VERIFIED_REMOTE'));
  assert.ok((await step('05-incident')).facts.some((f) => f.status === 'STALE'));
  const verified = await step('07-verified');
  assert.ok(verified.facts.filter((f) => f.class === 'health').every((f) => f.status === 'VERIFIED_REMOTE' && !f.problem));
  const handoff = (await step('08-handoff')).handoff;
  assert.ok(handoff.read_first.length > 0 && handoff.last_safe_state && handoff.known_unverified.length > 0);
  assert.ok((await step('10-closed')).resources.filter((r) => r.origin !== 'pre_existing').every((r) => r.lifecycle === 'deleted'));
});

test('each lifecycle step only appends to the previous step\'s events', async () => {
  let previous = '';
  for (const [dir] of LIFECYCLE) {
    const { eventsText } = await readWorkspace(join(FIXTURES, 'valid', 'lifecycle', dir));
    assert.ok(eventsText.startsWith(previous), `${dir} rewrites earlier events`);
    assert.ok(eventsText.length > previous.length, `${dir} appends nothing`);
    previous = eventsText;
  }
});

test('there is one status fixture per FT-7 status, each holding a fact with that status', async () => {
  const names = await subdirs(join(FIXTURES, 'valid', 'status'));
  assert.deepEqual(names, STATUSES.map((s) => s.toLowerCase()).sort());
  for (const name of names) {
    const { state } = await readWorkspace(join(FIXTURES, 'valid', 'status', name));
    assert.ok(state.facts.some((f) => f.status === name.toUpperCase()), name);
  }
});
