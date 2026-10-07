// Follows the router's documented procedures with the real tools, so the skills and
// the validator cannot drift apart: a record kept as the skills say must validate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { initWorkspace, appendEvent } from '../tools/lib/workspace.mjs';
import { validateWorkspace } from '../tools/lib/validate.mjs';
import { buildBrief } from '../tools/lib/brief.mjs';
import { createHash } from 'node:crypto';
import { REPO, tempDir } from './helpers/fixtures.mjs';

const AI = { role: 'ai', name: 'ai-deployer' };
const HUMAN = { role: 'human', name: 'operator' };
const later = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();

async function workspace() {
  const dir = join(await tempDir(), 'watchover');
  assert.equal((await initWorkspace(dir, { project: 'demo-app', environment: 'this machine', provider: 'local', session: 'session-a' })).ok, true);
  return dir;
}
const readState = async (dir) => JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
async function writeState(dir, state) {
  state.identity.updated_at = new Date().toISOString();
  await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2));
}
async function append(dir, event) {
  const r = await appendEvent(dir, JSON.stringify({ actor: AI, session_id: 'session-a', ...event }));
  assert.equal(r.appended, true, JSON.stringify(r.errors));
  return r.id;
}
async function assertValid(dir) {
  const r = await validateWorkspace(dir);
  assert.deepEqual(r.errors, []);
}

test('the plan skill tells a local target how to state its single tier honestly', async () => {
  const plan = await readFile(join(REPO, 'skills', 'stages', 'plan.md'), 'utf8');
  assert.match(plan, /local target/i);
  assert.match(plan, /0 to 0/);
});

test('verifying a fact as the router says produces a valid record', async () => {
  const dir = await workspace();
  await mkdir(join(dir, 'evidence'), { recursive: true });
  await writeFile(join(dir, 'evidence', '0002-git-status.txt'), 'nothing to commit, working tree clean\n');
  const at = later(1);
  await append(dir, { at, type: 'fact_verified', summary: 'Checked the checkout for local changes', fact: { key: 'source.local_changes', status: 'VERIFIED_LOCAL' }, evidence: ['evidence/0002-git-status.txt'] });
  const state = await readState(dir);
  state.facts.push({
    key: 'source.local_changes', label: 'Uncommitted local changes', value: 'none found', status: 'VERIFIED_LOCAL',
    source: 'local_check', class: 'source', scope: 'The demo-app checkout, tracked and untracked files',
    checked_at: at, fresh_for_minutes: 60, evidence: ['evidence/0002-git-status.txt'],
    negative_result: true, control: 'The same command reported a file planted in a scratch copy',
  });
  await writeState(dir, state);
  await assertValid(dir);
});

test('the plan-acceptance request for a local target, as the skills describe it, is valid', async () => {
  const dir = await workspace();
  await append(dir, { type: 'stage_change', summary: 'Recon finished; preparing the plan', stage: { from: 'recon', to: 'plan' } });
  await append(dir, { type: 'stage_change', summary: 'Plan ready; asking for plan acceptance', stage: { from: 'plan', to: 'awaiting_decision' } });
  const requestedAt = later(1);
  const requestId = await append(dir, { at: requestedAt, type: 'decision_request', summary: 'Asked to accept the plan', request: { id: 'dec-01', categories: ['plan_acceptance'] } });
  const state = await readState(dir);
  state.stage = 'awaiting_decision';
  state.brief = {
    app_summary: 'demo-app: a web front end and an API, run as local processes.',
    components: [{ name: 'web', role: 'Serves pages and calls the api' }, { name: 'api', role: 'Returns items' }],
    topology: 'Two processes on this machine, bound to 127.0.0.1.',
    resource_rationale: 'Two small processes need nothing more than this machine.',
    heavier_alternatives: [{ alternative: 'Containers', why_unnecessary: 'Two processes run directly.' }],
    assumptions: [],
  };
  state.plan = {
    tiers: [{ id: 'local', name: 'This machine', composition: 'Two local processes', region: 'this machine', cost_range: { low: 0, high: 0, currency: 'USD', period: 'month' }, price_checked_at: null, load_assumption: 'One person trying it', uncertainty: 'Runs on this machine at no cloud cost' }],
    default_tier: 'local',
    selected_tier: null,
  };
  state.pending_decision = {
    id: 'dec-01', categories: ['plan_acceptance'], action: 'Start the web and api processes on this machine.',
    targets: ['this machine'], why: 'The plan above is the smallest shape that runs the app.',
    cost_or_blast_radius: 'No cost. Affects only two new local processes.', reversibility: 'Reversible: stop the processes.',
    rollback: 'Stop both processes.', success_check: 'The web page loads and shows items from the api.',
    reply_options: [{ reply: 'approve', meaning: 'Accept the plan and start the processes' }], requested_at: requestedAt,
  };
  state.activity.waiting_on = 'human';
  state.next = { action: 'Reply in the AI session to accept the plan', decision_owner: 'human' };
  await writeState(dir, state);
  await assertValid(dir);

  const decisionId = await append(dir, { actor: HUMAN, type: 'decision', summary: 'Operator accepted the plan', decision: { request_id: 'dec-01', reply: 'approve', redacted: false, outcome: 'approved' }, related: [requestId] });
  await append(dir, { type: 'stage_change', summary: 'Plan accepted; starting', stage: { from: 'awaiting_decision', to: 'executing' } });
  await append(dir, { type: 'intent', summary: 'Start both processes', target: 'this machine', action: 'node run.mjs up', action_kinds: ['local', 'gated'], related: [decisionId] });
  const after = await readState(dir);
  after.stage = 'executing';
  after.pending_decision = null;
  after.plan.selected_tier = 'local';
  after.activity.waiting_on = 'ai';
  after.next = { action: 'Check that both processes answer', decision_owner: 'ai' };
  await writeState(dir, after);
  await assertValid(dir);
});

// ---- Cloudflare manual-edit order (Annex G authority path) ----

async function dnsRequest(dir) {
  const requestedAt = later(1);
  const requestId = await append(dir, { at: requestedAt, type: 'decision_request', summary: 'Asked to publish app.example.com', request: { id: 'dec-02', categories: ['dns', 'external_release'] } });
  const state = await readState(dir);
  state.pending_decision = {
    id: 'dec-02', categories: ['dns', 'external_release'], action: 'The human adds A record app.example.com -> 203.0.113.10, not proxied, TTL 300, in the dashboard.',
    targets: ['app.example.com'], why: 'Make the app reachable by name.', cost_or_blast_radius: 'Public: anyone can resolve the name.',
    reversibility: 'Reversible: delete the record.', rollback: 'Delete the A record.', success_check: 'dig returns 203.0.113.10 from the zone and a public resolver.',
    reply_options: [{ reply: 'approve dns', meaning: 'I will add the record now' }], requested_at: requestedAt,
  };
  await writeState(dir, state);
  await assertValid(dir);
  return requestId;
}

test('manual-edit DNS follows the authority path: decision, gated intent, human edit, result, own verification', async () => {
  const dir = await workspace();
  const requestId = await dnsRequest(dir);

  const decisionId = await append(dir, { actor: HUMAN, type: 'decision', summary: 'Operator approved the DNS record', decision: { request_id: 'dec-02', reply: 'approve dns', redacted: false, outcome: 'approved' }, related: [requestId] });
  const cleared = await readState(dir);
  cleared.pending_decision = null;
  await writeState(dir, cleared);
  await assertValid(dir);

  const intentId = await append(dir, { type: 'intent', summary: 'The human adds the approved A record in the dashboard', target: 'app.example.com', action: 'manual dashboard edit: A app.example.com 203.0.113.10 TTL 300', action_kinds: ['remote_mutating', 'gated'], related: [decisionId] });
  // The human edits DNS now, then says it is done.
  await append(dir, { type: 'result', summary: 'The human reports the record is added', outcome: 'succeeded', state_change: 'A record reported as added', related: [intentId] });
  const reported = await readState(dir);
  reported.facts.push({ key: 'dns.change_reported', label: 'Human reports the A record is added', value: 'done', status: 'USER_CONFIRMED', source: 'human', class: 'network', scope: 'Stated by the operator; not checked', checked_at: new Date().toISOString(), fresh_for_minutes: null, evidence: [] });
  await writeState(dir, reported);
  await assertValid(dir);

  await mkdir(join(dir, 'evidence'), { recursive: true });
  await writeFile(join(dir, 'evidence', '0007-dig.txt'), '203.0.113.10\n');
  const at = later(2);
  await append(dir, { at, type: 'fact_verified', summary: 'dig confirms the A record', fact: { key: 'dns.app_record', status: 'VERIFIED_REMOTE' }, evidence: ['evidence/0007-dig.txt'] });
  const verified = await readState(dir);
  verified.facts.push({ key: 'dns.app_record', label: 'app.example.com resolves to the VM', value: '203.0.113.10', status: 'VERIFIED_REMOTE', source: 'remote_observation', class: 'network', scope: 'Authoritative name server and one public resolver', checked_at: at, fresh_for_minutes: 5, evidence: ['evidence/0007-dig.txt'] });
  await writeState(dir, verified);
  await assertValid(dir);
});

test('a gated DNS intent recorded before the approval is refused', async () => {
  const dir = await workspace();
  const requestId = await dnsRequest(dir);
  const r = await appendEvent(dir, JSON.stringify({ actor: AI, session_id: 'session-a', type: 'intent', summary: 'The human adds the record', target: 'app.example.com', action: 'manual dashboard edit', action_kinds: ['remote_mutating', 'gated'], related: [requestId] }));
  assert.equal(r.appended, false);
  assert.ok(r.errors.some((e) => e.check === 'gated-intent-approved'));
});

test('complete request scope survives approval and pending clear through filesystem evidence and brief', async () => {
  const dir = await workspace();
  const locator = 'evidence/dec-scope-request.json';
  const snapshot = {
    id: 'dec-scope', categories: ['dns', 'external_release'], action: 'Human adds one A record; no replacement or deletion.',
    targets: ['app.example.com'], why: 'Expose the approved entry point.', cost_or_blast_radius: 'One public record, no new billable resource.',
    reversibility: 'Record removable; cached answers persist until TTL ends.', rollback: 'Ask once for deletion approval if not covered, remove this record, then verify.',
    success_check: 'Synthetic authoritative answer matches 203.0.113.10.', reply_options: [{ reply: 'approve dns', meaning: 'Approve this concrete record only' }],
    requested_at: null,
  };
  await writeFile(join(dir, locator), JSON.stringify(snapshot));
  const requestId = await append(dir, { type: 'decision_request', summary: 'Ask for one DNS record', request: { id: snapshot.id, categories: snapshot.categories }, evidence: [locator] });
  const log = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  snapshot.requested_at = log.at(-1).at;
  await writeFile(join(dir, locator), JSON.stringify(snapshot));
  const pending = await readState(dir);
  pending.pending_decision = snapshot;
  await writeState(dir, pending);
  await assertValid(dir);
  const decisionId = await append(dir, { actor: HUMAN, type: 'decision', summary: 'Approved concrete DNS record', decision: { request_id: snapshot.id, reply: 'approve dns', redacted: false, outcome: 'approved' }, related: [requestId] });
  pending.pending_decision = null;
  await writeState(dir, pending);
  await assertValid(dir);
  const events = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const decision = events.find((e) => e.id === decisionId);
  const request = events.find((e) => decision.related.includes(e.id));
  assert.deepEqual(JSON.parse(await readFile(join(dir, request.evidence[0]), 'utf8')), snapshot);
  assert.equal(decision.decision.reply, 'approve dns');
  const brief = buildBrief(pending, events, Date.now());
  assert.ok(brief.join('\n').includes(`${requestId} → ${locator}`));
  assert.ok(brief.length <= 30);
});

test('high-risk delegation and recovery scope scenarios are advisory guidance only', async () => {
  const router = await readFile(join(REPO, 'skills/router.md'), 'utf8');
  const recover = await readFile(join(REPO, 'skills/stages/recover.md'), 'utf8');
  // Source coverage, not an AI compliance or arbitrary action authorization experiment.
  for (const phrase of ['off-option delegation', 'one explicit confirmation', 'Natural language', 'exact selections', 'original reply', 'older valid approvals']) {
    assert.ok(router.replace(/\s+/g, ' ').includes(phrase), phrase);
  }
  for (const phrase of ['Stopping a serving service', 'replacing deployed source', 'deleting/rebuilding', 'ask once', 'prior plan/billable approval', 'Private temporary']) {
    assert.ok(recover.replace(/\s+/g, ' ').includes(phrase), phrase);
  }
});

test('documented nonsecret baseline projection compares equal and changed fields without originals', async () => {
  const readme = await readFile(join(REPO, 'README.md'), 'utf8');
  const example = /```js\n([\s\S]*?)```/.exec(readme)[1];
  const projectBaseline = Function(`${example}\nreturn projectBaseline;`)();
  const before = [{ principal: 'operator-a', role: 'reader', credential: 'synthetic-private-original' }, { principal: 'operator-b', role: 'writer' }];
  const project = (v) => JSON.stringify(projectBaseline(v));
  const digest = (v) => createHash('sha256').update(project(v)).digest('hex');
  assert.equal(digest(before), digest([...before].reverse()));
  assert.notEqual(digest(before), digest([{ ...before[0], role: 'writer' }, before[1]]));
  const persisted = JSON.stringify({ fields: projectBaseline(before), digest: digest(before) });
  assert.ok(!persisted.includes(before[0].credential));
  assert.deepEqual(Object.keys(projectBaseline(before)[0]).sort(), ['principal', 'role']);
});

test('human-created run resource uses existing fields and human cleanup has approval and verification', async () => {
  const dir = await workspace();
  await append(dir, { actor: HUMAN, type: 'intent', summary: 'Human prepares disposable local fixture', target: 'synthetic-object', action: 'manual local creation', action_kinds: ['local'] });
  const log = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  await append(dir, { actor: HUMAN, type: 'result', summary: 'Human created the synthetic object for this operation', outcome: 'succeeded', related: [log.at(-1).id] });
  const state = await readState(dir);
  state.resources.push({ id: 'human-object', name: 'synthetic-object', provider: 'local', type: 'temporary-object', purpose: 'Human created this object during the current operation; include in cleanup plan.', billable: false, lifecycle: 'present', origin: 'created_this_run', parent_id: null, evidence_fact: null });
  await writeState(dir, state);
  await assertValid(dir);
  const guidance = await readFile(join(REPO, 'skills/stages/verify-handoff.md'), 'utf8');
  for (const p of [/Include resources created by humans/, /deletion approval/, /executing party/, /human to remove an object, then verify/, /never authorizes deletion/]) assert.match(guidance, p);
});
