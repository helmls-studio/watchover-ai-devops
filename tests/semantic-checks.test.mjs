import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CHECK_IDS, FRESHNESS_CAPS, runSemanticChecks } from '../tools/lib/semantic-checks.mjs';
import { validateTexts } from '../tools/lib/validate.mjs';
import { FIXTURES, subdirs, readWorkspace } from './helpers/fixtures.mjs';

const lifecycle = async (step) => readWorkspace(join(FIXTURES, 'valid', 'lifecycle', step));
const fact = (state, key) => state.facts.find((f) => f.key === key);
const event = (events, id) => events.find((e) => e.id === id);

// Mutate one fixture in memory and require that exactly the named check fires.
// A check list names every check that must fire, when one mutation rightly breaks two rules.
const expectOnly = (step, check, mutate) => expectOnlyIn(join('lifecycle', step), check, mutate);

async function expectOnlyIn(fixture, check, mutate) {
  const { state, events } = await readWorkspace(join(FIXTURES, 'valid', fixture));
  mutate(state, events);
  const errors = runSemanticChecks(state, events);
  const expected = [check].flat().sort();
  assert.deepEqual([...new Set(errors.map((e) => e.check))].sort(), expected, JSON.stringify(errors, null, 2));
  for (const e of errors) assert.ok(e.file && e.message, 'errors carry a file and a message');
  return errors;
}

test('the named checks are the documented set', () => {
  assert.deepEqual(CHECK_IDS, [
    'unique-ids', 'trust-by-source', 'verified-needs-evidence', 'freshness-within-class-cap',
    'stale-was-observed', 'blocked-names-prerequisite', 'assumed-holds-value',
    'negative-result-needs-control', 'resource-tree', 'references-resolve', 'ranges-ordered',
    'coalesced-plan-explanation', 'problem-is-observed', 'event-sequence', 'stage-chain',
    'event-type-fields', 'event-links', 'one-decision-per-request', 'gated-intent-approved',
    'terminal-intents-have-results', 'state-stage-matches-events', 'pending-decision-has-request', 'requests-answered-or-pending',
    'verified-facts-have-promotion-event', 'first-billable-carries-plan',
  ]);
});

test('freshness caps exist for every fact class and are finite', () => {
  assert.deepEqual(Object.keys(FRESHNESS_CAPS).sort(), ['health', 'identity', 'network', 'other', 'permission', 'price', 'resource', 'source']);
  for (const cap of Object.values(FRESHNESS_CAPS)) assert.ok(Number.isInteger(cap) && cap > 0 && cap <= 43200);
});

test('open intents are valid in execution/interruption; terminal states require actual related results', async () => {
  for (const stage of ['executing', 'incident', 'handoff', 'closed']) {
    const { state, events } = await lifecycle('07-verified');
    const prev = events.at(-1);
    const intentId = 'evt-9000';
    events.push({ schema_version: '0.1', id: intentId, at: prev.at, actor: { role: 'ai', name: 'operator' }, session_id: 'synthetic', type: 'intent', summary: 'Synthetic action awaiting reconciliation', target: 'local-fixture', action: 'synthetic action', action_kinds: ['local'] });
    events.push({ schema_version: '0.1', id: 'evt-9001', at: prev.at, actor: { role: 'ai', name: 'operator' }, session_id: 'synthetic', type: 'stage_change', summary: 'Record the next stage', stage: { from: state.stage, to: stage } });
    state.stage = stage;
    const terminal = ['handoff', 'closed'].includes(stage);
    const errors = runSemanticChecks(state, events);
    const validate = () => validateTexts(JSON.stringify(state), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    assert.equal((await validate()).ok, !terminal);
    if (!terminal) assert.deepEqual(errors, []);
    else {
      assert.equal(errors.length, 1);
      assert.equal(errors[0].check, 'terminal-intents-have-results');
      assert.ok(errors[0].message.includes(intentId));
    }
    events.push({ schema_version: '0.1', id: 'evt-9002', at: prev.at, actor: { role: 'ai', name: 'operator' }, session_id: 'synthetic', type: 'result', summary: stage === 'closed' ? 'Cancelled; not executed. No runtime success or failure asserted.' : 'Execution result unknown after interruption; no result inferred.', outcome: 'unknown', related: [intentId] });
    assert.deepEqual(runSemanticChecks(state, events), []);
    assert.equal((await validate()).ok, true, 'existing schema accepts truthful unknown/nonexecution result');
    // Referencing another event does not silently account for this intent.
    events.at(-1).related = [events.find((e) => e.type === 'intent').id];
    if (terminal) assert.ok(runSemanticChecks(state, events).some((e) => e.message.includes(intentId)));
  }
});

test('every valid fixture passes every named check', async () => {
  for (const group of ['lifecycle', 'status']) {
    for (const name of await subdirs(join(FIXTURES, 'valid', group))) {
      const { state, events } = await readWorkspace(join(FIXTURES, 'valid', group, name));
      assert.deepEqual(runSemanticChecks(state, events), [], `${group}/${name}`);
    }
  }
});

test('unique-ids: duplicate fact keys or resource ids are rejected', async () => {
  await expectOnly('07-verified', 'unique-ids', (s) => s.facts.push(structuredClone(s.facts[0])));
  await expectOnly('03-long-operation', 'unique-ids', (s) => { s.resources[1].id = s.resources[0].id; s.resources.forEach((r) => { if (r.parent_id === 'vm-demo-app') r.parent_id = 'net-default'; }); });
});

test('trust-by-source: a status must match where the fact came from', async () => {
  await expectOnly('01-recon', 'trust-by-source', (s) => { fact(s, 'gcp.project').source = 'human'; });
  await expectOnly('01-recon', 'trust-by-source', (s) => { fact(s, 'gcp.billing_enabled').source = 'reasoning'; });
  await expectOnly('01-recon', 'trust-by-source', (s) => { fact(s, 'source.local_changes').source = 'remote_observation'; });
});

test('verified-needs-evidence: a verified fact needs evidence, a check time and a freshness rule', async () => {
  // Emptying the evidence also breaks agreement with the latest promotion event.
  const errors = await expectOnly('01-recon', ['verified-needs-evidence', 'verified-facts-have-promotion-event'], (s) => { fact(s, 'gcp.project').evidence = []; });
  assert.ok(errors.every((e) => e.pointer === '/facts/0'));
  await expectOnly('01-recon', 'verified-needs-evidence', (s) => { fact(s, 'gcp.project').fresh_for_minutes = null; });
});

test('freshness-within-class-cap: a freshness rule cannot exceed its class cap', async () => {
  await expectOnly('07-verified', 'freshness-within-class-cap', (s) => { fact(s, 'app.web_health').fresh_for_minutes = FRESHNESS_CAPS.health + 1; });
});

test('stale-was-observed: a stale fact must have been checked once', async () => {
  // Dropping checked_at also breaks agreement with the latest promotion event.
  await expectOnly('05-incident', ['stale-was-observed', 'verified-facts-have-promotion-event'], (s) => { fact(s, 'app.web_health').checked_at = null; });
});

test('blocked-names-prerequisite: a blocked fact names what is unavailable', async () => {
  await expectOnly('01-recon', 'blocked-names-prerequisite', (s) => { delete fact(s, 'gcp.cpu_quota').blocked_by; });
});

test('assumed-holds-value: an assumed fact holds a value', async () => {
  await expectOnly('01-recon', 'assumed-holds-value', (s) => { fact(s, 'app.expected_load').value = null; });
});

test('negative-result-needs-control: a verified "none found" states its control', async () => {
  await expectOnly('01-recon', 'negative-result-needs-control', (s) => { delete fact(s, 'source.local_changes').control; });
});

test('resource-tree: parents must exist and must not form a cycle', async () => {
  await expectOnly('03-long-operation', 'resource-tree', (s) => { s.resources.find((r) => r.id === 'disk-demo-app-boot').parent_id = 'vm-missing'; });
  await expectOnly('03-long-operation', 'resource-tree', (s) => { s.resources.find((r) => r.id === 'vm-demo-app').parent_id = 'disk-demo-app-boot'; });
});

test('references-resolve: fact and tier references must exist', async () => {
  await expectOnly('03-long-operation', 'references-resolve', (s) => { s.resources[1].evidence_fact = 'compute.missing'; });
  await expectOnly('03-long-operation', 'references-resolve', (s) => { s.sources[0].deployed_ref_fact = 'source.missing'; });
  await expectOnly('03-long-operation', 'references-resolve', (s) => { s.plan.selected_tier = 'z'; });
});

test('ranges-ordered: duration and cost ranges run low to high', async () => {
  await expectOnly('03-long-operation', 'ranges-ordered', (s) => { s.activity.expected_duration = { min_minutes: 20, max_minutes: 5 }; });
  await expectOnly('03-long-operation', 'ranges-ordered', (s) => { s.plan.tiers[0].cost_range.low = 99; });
});

test('coalesced-plan-explanation: a plan-acceptance request carries the plan explanation', async () => {
  await expectOnly('02-approval-pending', 'coalesced-plan-explanation', (s) => { s.brief.resource_rationale = null; });
  await expectOnly('02-approval-pending', 'coalesced-plan-explanation', (s) => { s.plan.default_tier = null; });
});

test('event-sequence: ids strictly increase and time never runs backwards', async () => {
  await expectOnly('03-long-operation', 'event-sequence', (_, e) => { event(e, 'evt-0007').at = '2026-09-01T08:00:00Z'; });
  await expectOnly('03-long-operation', 'event-sequence', (_, e) => { e.push({ ...structuredClone(e.at(-1)) }); });
});

test('stage-chain: stages chain from the initial stage event', async () => {
  await expectOnly('03-long-operation', 'stage-chain', (_, e) => { event(e, 'evt-0011').stage.from = 'plan'; });
  await expectOnly('03-long-operation', 'stage-chain', (_, e) => { e[0].stage.from = 'recon'; });
});

test('event-type-fields: each event type carries its own fields', async () => {
  await expectOnly('03-long-operation', 'event-type-fields', (_, e) => { delete event(e, 'evt-0015').action_kinds; });
  await expectOnly('03-long-operation', 'event-type-fields', (_, e) => { delete event(e, 'evt-0013').outcome; });
  await expectOnly('03-long-operation', 'event-type-fields', (_, e) => { event(e, 'evt-0010').actor = { role: 'ai', name: 'deployer-ai' }; });
  await expectOnly('03-long-operation', 'event-type-fields', (_, e) => { event(e, 'evt-0012').stage = { from: null, to: 'recon' }; });
});

test('event-links: related events exist earlier; results follow intents; decisions answer requests', async () => {
  await expectOnly('03-long-operation', 'event-links', (_, e) => { event(e, 'evt-0013').related = ['evt-0011']; });
  await expectOnly('03-long-operation', 'event-links', (_, e) => { event(e, 'evt-0015').related = ['evt-0099']; });
  await expectOnly('03-long-operation', 'event-links', (_, e) => { event(e, 'evt-0010').related = ['evt-0008']; });
});

test('state-stage-matches-events: the state stage equals the last recorded stage change', async () => {
  await expectOnly('03-long-operation', 'state-stage-matches-events', (s) => { s.stage = 'verifying'; });
});

test('pending-decision-has-request: a pending decision was requested and is still unanswered', async () => {
  // The real request dec-01 is then left unanswered and not pending, which is also caught.
  await expectOnly('02-approval-pending', ['pending-decision-has-request', 'requests-answered-or-pending'], (s) => { s.pending_decision.id = 'dec-99'; });
  // Only the pending state's categories change; the recorded request event stays as it was.
  await expectOnly('02-approval-pending', 'pending-decision-has-request', (s) => { s.pending_decision.categories = ['plan_acceptance']; });
  await expectOnly('02-approval-pending', 'pending-decision-has-request', (s) => { s.pending_decision.categories = ['plan_acceptance', 'billable', 'dns']; });
  const { state: answered } = await lifecycle('02-approval-pending');
  // dec-01 was already answered by evt-0010 in step 03, so it cannot still be pending there.
  await expectOnly('03-long-operation', 'pending-decision-has-request', (s) => {
    s.pending_decision = { ...answered.pending_decision, categories: ['delete'] };
  });
});

test('pending-decision-has-request: category order alone is not a mismatch', async () => {
  const { state, events } = await lifecycle('02-approval-pending');
  state.pending_decision.categories = ['billable', 'plan_acceptance'];
  assert.deepEqual(runSemanticChecks(state, events), []);
});

test('verified-facts-have-promotion-event: every verified fact has a promotion event', async () => {
  await expectOnly('01-recon', 'verified-facts-have-promotion-event', (_, e) => { e.splice(1, 1); });
});

test('verified-facts-have-promotion-event: a STALE fact needs the promotion event of its earlier observation', async () => {
  const errors = await expectOnlyIn('status/stale', 'verified-facts-have-promotion-event', (s, e) => {
    assert.equal(s.facts[0].status, 'STALE');
    assert.equal(e[1].type, 'fact_verified');
    e.splice(1, 1);
  });
  assert.deepEqual(errors.map((x) => x.pointer), ['/facts/0']);
});

test('verified-facts-have-promotion-event: the earlier promotion must match the STALE fact\'s source', async () => {
  await expectOnlyIn('status/stale', 'verified-facts-have-promotion-event', (_, e) => { e[1].fact.status = 'VERIFIED_LOCAL'; });
  await expectOnlyIn('status/stale', 'verified-facts-have-promotion-event', (s) => { s.facts[0].source = 'human'; });
});

// Append a billable-only request after step 07 and make it the pending decision.
async function laterBillableRequest() {
  const { state, events } = await lifecycle('07-verified');
  const { state: step02 } = await lifecycle('02-approval-pending');
  events.push({
    schema_version: '0.1', id: 'evt-0033', at: '2026-09-01T10:15:00Z', actor: { role: 'ai', name: 'deployer-ai' },
    session_id: 'session-a', type: 'decision_request', summary: 'Asked to approve a second, larger disk',
    request: { id: 'dec-03', categories: ['billable'] },
  });
  state.pending_decision = { ...step02.pending_decision, id: 'dec-03', categories: ['billable'], requested_at: '2026-09-01T10:15:00Z' };
  return { state, events };
}

test('first-billable-carries-plan: a pending first billable request must include plan acceptance', async () => {
  await expectOnly('02-approval-pending', 'first-billable-carries-plan', (s, e) => {
    s.pending_decision.categories = ['billable'];
    event(e, 'evt-0009').request.categories = ['billable'];
  });
});

test('first-billable-carries-plan: the recorded history is checked after the decision is cleared', async () => {
  const errors = await expectOnly('07-verified', 'first-billable-carries-plan', (s, e) => {
    assert.equal(s.pending_decision, null);
    event(e, 'evt-0009').request.categories = ['billable'];
  });
  assert.deepEqual(errors.map((x) => [x.file, x.line]), [['events.jsonl', 9]]);
});

test('first-billable-carries-plan: a later billable request after plan acceptance was approved is fine', async () => {
  const { state, events } = await laterBillableRequest();
  assert.deepEqual(runSemanticChecks(state, events), []);
});

test('first-billable-carries-plan: plan acceptance must have been approved, not just requested', async () => {
  const { state, events } = await laterBillableRequest();
  event(events, 'evt-0010').decision.outcome = 'rejected';
  const errors = runSemanticChecks(state, events);
  // The rejected decision also stops authorizing the gated VM creation (gated-intent-approved).
  assert.ok(errors.some((x) => x.check === 'first-billable-carries-plan' && x.file === 'events.jsonl' && x.line === 33));
});

// ---- approval lifecycle ----

function append(events, fields, actor = { role: 'ai', name: 'deployer-ai' }) {
  const last = events.at(-1);
  const id = `evt-${String(Number(last.id.slice(4)) + 1).padStart(4, '0')}`;
  const at = new Date(Date.parse(last.at) + 60000).toISOString().replace('.000Z', 'Z');
  events.push({ schema_version: '0.1', id, at, actor, session_id: last.session_id, ...fields });
}
const HUMAN = { role: 'human', name: 'operator' };

test('requests-answered-or-pending: an unanswered request must be the pending decision', async () => {
  await expectOnly('03-long-operation', 'requests-answered-or-pending', (_, e) => {
    append(e, { type: 'decision_request', summary: 'Asked about a DNS record', request: { id: 'dec-09', categories: ['dns'] } });
  });
  await expectOnly('02-approval-pending', 'requests-answered-or-pending', (_, e) => {
    append(e, { type: 'decision_request', summary: 'Asked about a DNS record', request: { id: 'dec-09', categories: ['dns'] } });
  });
});

test('one-decision-per-request: request ids are unique', async () => {
  await expectOnly('03-long-operation', 'one-decision-per-request', (_, e) => {
    append(e, { type: 'decision_request', summary: 'Asked again under a reused id', request: { id: 'dec-01', categories: ['dns'] } });
  });
});

test('one-decision-per-request: a request receives at most one decision', async () => {
  await expectOnly('03-long-operation', 'one-decision-per-request', (_, e) => {
    append(e, { type: 'decision', summary: 'Contradictory second answer', decision: { request_id: 'dec-01', reply: 'no, stop', redacted: false, outcome: 'rejected' }, related: ['evt-0009'] }, HUMAN);
  });
});

test('gated-intent-approved: a gated intent relates to an earlier approved decision', async () => {
  await expectOnly('03-long-operation', 'gated-intent-approved', (_, e) => { event(e, 'evt-0010').decision.outcome = 'rejected'; });
  await expectOnly('03-long-operation', 'gated-intent-approved', (_, e) => { event(e, 'evt-0010').decision.outcome = 'deferred'; });
  await expectOnly('03-long-operation', 'gated-intent-approved', (_, e) => { event(e, 'evt-0012').related = []; });
});

test('pending-decision-has-request: the pending request time matches the recorded request', async () => {
  await expectOnly('02-approval-pending', 'pending-decision-has-request', (s) => { s.pending_decision.requested_at = '2026-09-01T09:23:00Z'; });
});

// ---- current fact versus promotion history ----

test('verified-facts-have-promotion-event: the latest promotion, not any promotion, must match', async () => {
  const { state: step04 } = await lifecycle('04-verification-failed');
  const olderChain = fact(step04, 'app.chain');
  await expectOnly('06-recovered', 'verified-facts-have-promotion-event', (s) => {
    s.facts[s.facts.findIndex((f) => f.key === 'app.chain')] = olderChain;
  });
});

test('verified-facts-have-promotion-event: check time and evidence must agree with the latest promotion', async () => {
  await expectOnly('07-verified', 'verified-facts-have-promotion-event', (s) => { fact(s, 'app.web_health').checked_at = '2026-09-01T09:53:00Z'; });
  await expectOnly('07-verified', 'verified-facts-have-promotion-event', (s) => { fact(s, 'app.web_health').evidence = ['evidence/0021-web-health.txt']; });
});

test('verified-facts-have-promotion-event: a STALE fact must match its latest promotion', async () => {
  await expectOnlyIn('status/stale', 'verified-facts-have-promotion-event', (s, e) => {
    append(e, { type: 'fact_verified', summary: 'Checked again later', fact: { key: s.facts[0].key, status: 'VERIFIED_REMOTE' }, evidence: ['evidence/0003-web-health.txt'] });
  });
});

test('trust-by-source: an ASSUMED fact comes from reasoning', async () => {
  await expectOnly('01-recon', 'trust-by-source', (s) => { fact(s, 'app.expected_load').source = 'human'; });
});

test('problem-is-observed: only a verified or previously verified observation can flag a problem', async () => {
  await expectOnly('01-recon', 'problem-is-observed', (s) => { fact(s, 'app.expected_load').problem = true; });
  await expectOnly('01-recon', 'problem-is-observed', (s) => { fact(s, 'gcp.permissions').problem = true; });
});
