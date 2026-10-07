import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, FIXTURES, readWorkspace } from './helpers/fixtures.mjs';
import { renderView } from '../app/web-ui/render.mjs';
import { buildBrief } from '../tools/lib/brief.mjs';
import { humanAction } from '../app/web-ui/freshness.mjs';
import { validateTexts, validateWorkspace } from '../tools/lib/validate.mjs';

const SC = (n) => join(FIXTURES, 'valid', 'scenarios', n);
const read = (...p) => readFile(join(REPO, ...p), 'utf8');
// Deterministic clocks: each scenario is viewed at a fixed offset from its own last update,
// never at the host's current time.
const clockOf = (ws, minutes = 5) => Date.parse(ws.state.identity.updated_at) + minutes * 60000;

test('every scenario fixture validates without any provider profile', async () => {
  for (const n of ['view-handoff-confirmed', 'view-handoff-exception', 'services-and-names', 'shared-object-delta', 'interrupted', 'awaiting-acceptance', 'package-gap']) {
    assert.equal((await validateWorkspace(SC(n))).ok, true, n);
    assert.equal((await readWorkspace(SC(n))).state.identity.provider_profile, 'local', n);
  }
});

test('WO-P05: service rows come from health facts and host resources, with honest freshness', async () => {
  const ws = await readWorkspace(SC('services-and-names'));
  const { state, events } = ws;
  const NOW = clockOf(ws);
  const apiAt = Date.parse(state.facts.find((f) => f.key === 'health.api').checked_at);
  assert.ok(NOW > apiAt && NOW < apiAt + 60 * 60000, 'the chosen clock is inside the api window');
  const html = renderView(state, events, NOW);
  const row = (c) => new RegExp(`<li class="service" data-service="${c}">[\\s\\S]*?</li>`).exec(html)?.[0];
  assert.match(row('api'), /data-kind="verified-local"/);
  assert.match(row('api'), /fresh for \d+ more min/);
  assert.match(row('api'), /demo-app-api-1/);
  assert.match(row('web'), /data-kind="stale"/);
  assert.doesNotMatch(row('web'), /fresh for/);
  assert.match(row('worker'), /data-kind="unknown"/);
  assert.match(row('worker'), /never checked/);
  // The same record viewed after the api window has ended: honest expiry, not "fresh".
  const later = renderView(state, events, apiAt + 61 * 60000);
  const laterApi = /<li class="service" data-service="api">[\s\S]*?<\/li>/.exec(later)[0];
  assert.match(laterApi, /data-kind="verified-expired"/);
  assert.match(laterApi, /freshness window ended/);
  assert.doesNotMatch(laterApi, /fresh for/);
  // One key per component, updated in place; both observations stay in the history.
  assert.equal(state.facts.filter((f) => f.key === 'health.api').length, 1);
  assert.equal(events.filter((e) => e.type === 'fact_verified' && e.fact.key === 'health.api').length, 2);
  // A retired resource keeps its record and history; deletion is backed by evidence.
  const old = state.resources.find((r) => r.id === 'old-worker-container');
  assert.equal(old.lifecycle, 'deleted');
  assert.equal(state.facts.find((f) => f.key === old.evidence_fact).negative_result, true);
  // Any component name works; nothing is hard-coded.
  const renamed = structuredClone(state);
  renamed.facts.find((f) => f.key === 'health.worker').key = 'health.queue-consumer-7';
  assert.match(renderView(renamed, events, NOW), /data-service="queue-consumer-7"/);
  // The health class cap (60 minutes) is enforced by validation.
  const tooLong = structuredClone(state);
  tooLong.facts.find((f) => f.key === 'health.api').fresh_for_minutes = 90;
  const r = await validateTexts(`${JSON.stringify(tooLong)}\n`, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  assert.ok(r.errors.some((e) => e.check === 'freshness-within-class-cap'), JSON.stringify(r.errors));
});

test('WO-P06: logical ids and real names are both kept; a declaration is not a runtime observation', async () => {
  const ws = await readWorkspace(SC('services-and-names'));
  const { state, events } = ws;
  const NOW = clockOf(ws);
  const api = state.resources.find((r) => r.id === 'api-container');
  assert.notEqual(api.id, api.name);
  const vol = state.resources.find((r) => r.origin === 'created_implicitly');
  assert.equal(vol.name, 'demo-app_db-data');
  const html = renderView(state, events, NOW);
  assert.ok(html.includes('demo-app-api-1') && html.includes('api-container'));
  const fact = (k) => state.facts.find((f) => f.key === k);
  assert.match(fact('manifest.web_image').scope, /^Declared in/);
  assert.notEqual(fact('manifest.web_image').status, 'VERIFIED_REMOTE');
  assert.equal(fact('runtime.api_image').status, 'UNKNOWN', 'a declaration alone leaves the runtime fact unknown');
  assert.match(buildBrief(state, events, NOW).find((l) => l.includes('runtime.api_image')), /not a current verified fact/);
  const execute = await read('skills', 'stages', 'execute.md');
  assert.match(execute, /`id` is your stable logical id; `name` is the name the provider actually returned/);
  assert.match(execute, /Never assume two names match/);
  assert.match(execute, /only \*declared\*/);
  const gcp = await read('skills', 'providers', 'gcp.md');
  assert.match(gcp, /it need not\s+match the VM's/);
  assert.match(gcp, /may be a static address or a\s+disk rather than a VM/);
  assert.doesNotMatch(gcp, /Creating the first VM is the first billable action/);
});

test('WO-P07: only this run\'s delta is reversed and the baseline hash is preserved', async () => {
  const stable = (o) => JSON.stringify(Object.keys(o).sort().reduce((a, k) => ({ ...a, [k]: o[k] }), {}));
  const hash = (o) => createHash('sha256').update(stable(o)).digest('hex');
  const baseline = { 'team-shared-setting': 'synthetic-original-value' };
  const delta = Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`run-key-${k + 1}`, `synthetic-${k + 1}`]));
  const applied = { ...baseline, ...delta };
  const reversed = Object.fromEntries(Object.entries(applied).filter(([k]) => !(k in delta)));
  assert.equal(Object.keys(applied).length, 9);
  assert.equal(hash(reversed), hash(baseline), 'removing exactly the delta restores the baseline');
  assert.notEqual(hash({}), hash(baseline), 'resetting the whole shared object would fail the check');
  const { state, events } = await readWorkspace(SC('shared-object-delta'));
  const fact = (k) => state.facts.find((f) => f.key === k);
  // The undo runs only under its own scoped deletion approval, not the plan acceptance.
  const byId = new Map(events.map((e, i) => [e.id, { e, i }]));
  const undoIdx = events.findIndex((e) => e.type === 'intent' && /Remove exactly/.test(e.summary));
  const undo = events[undoIdx];
  assert.ok(undo.action_kinds.includes('gated'));
  const approval = undo.related.map((id) => byId.get(id)).find((x) => x && x.e.type === 'decision');
  assert.ok(approval && approval.i < undoIdx && approval.e.decision.outcome === 'approved');
  const request = events.find((e) => e.type === 'decision_request' && e.request.id === approval.e.decision.request_id);
  assert.deepEqual(request.request.categories, ['delete']);
  for (const k of Object.keys(delta)) assert.ok(request.summary.includes('run-key-1..run-key-8') && undo.action.includes('run-key-1..run-key-8'), k);
  assert.match(request.summary, /team-shared-setting stays/);
  const planDecision = events.find((e) => e.type === 'decision' && e.decision.request_id === 'dec-01');
  assert.ok(!undo.related.includes(planDecision.id), 'plan acceptance alone does not authorize the removal');
  assert.equal(fact('shared.metadata.baseline').value, hash(baseline));
  assert.equal(fact('shared.metadata.restored').value, hash(baseline));
  assert.equal(fact('shared.access_policy.preserved').status, 'UNKNOWN', 'unprovable preservation stays unknown');
  const execute = await read('skills', 'stages', 'execute.md');
  assert.match(execute, /Undo only that delta, with approval/);
  assert.match(execute, /that fact is UNKNOWN, not clean/);
  assert.match(execute, /Never\s+reset or disable a whole shared object/);
});

test('WO-P08: an interruption names the pending intent and owner; brief and view agree', async () => {
  const ws = await readWorkspace(SC('interrupted'));
  const { state, events } = ws;
  const NOW = clockOf(ws);
  const resulted = new Set(events.filter((e) => e.type === 'result').flatMap((e) => e.related ?? []));
  const open = events.filter((e) => e.type === 'intent' && !resulted.has(e.id));
  assert.equal(open.length, 1);
  assert.ok(state.next.action.includes(open[0].id));
  assert.ok(state.handoff.last_safe_state);
  const lines = buildBrief(state, events, NOW);
  const html = renderView(state, events, NOW);
  assert.ok(lines.some((l) => l.startsWith('Next: ') && l.includes(open[0].id)));
  assert.ok(lines.includes('Human action now: nothing needs the human right now'));
  assert.match(html, /Nothing needs you right now\./);
  assert.ok(html.includes(open[0].id));
  const recover = await read('skills', 'stages', 'recover.md');
  assert.match(recover, /a killed AI may record nothing/);
  assert.match(recover, /first find any `intent`\s+without a matching `result`/);
  assert.match(recover, /Never redo the last step blind/);
});

test('WO-P08: after deployment the owner and choice are explicit; deployed is not cleaned up', async () => {
  const ws = await readWorkspace(SC('awaiting-acceptance'));
  const { state, events } = ws;
  const NOW = clockOf(ws);
  assert.equal(state.next.decision_owner, 'human');
  const action = humanAction(state);
  assert.equal(action, state.next.action);
  // brief clips long text to keep within 30 lines; the same action text starts the line.
  assert.ok(buildBrief(state, events, NOW).some((l) => l.startsWith(`Human action now: ${action.slice(0, 60)}`)));
  assert.ok(renderView(state, events, NOW).includes(action));
  assert.ok(state.open_items.some((o) => /Cleanup is not approved/.test(o.text)));
  const vh = await read('skills', 'stages', 'verify-handoff.md');
  assert.match(vh, /kept running .*waiting for acceptance .*waiting for cleanup approval/s);
  assert.match(vh, /Deployed is not\s+cleaned up/);
  assert.match(vh, /never claim\s+the whole project is clean beyond that evidence/);
});

test('generic core: router and stages need no particular cloud command', async () => {
  for (const f of ['router.md', 'stages/recon.md', 'stages/plan.md', 'stages/execute.md', 'stages/verify-handoff.md', 'stages/recover.md']) {
    assert.doesNotMatch(await read('skills', f), /\bgcloud\b/, f);
  }
  const router = await read('skills', 'router.md');
  assert.match(router, /for every\s+target/);
});
