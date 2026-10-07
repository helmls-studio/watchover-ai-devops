import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { compileSchema } from '../tools/lib/schema-subset.mjs';
import { ROUTER_SKILL } from '../tools/lib/workspace.mjs';
import { REPO, SCHEMA_DIR, loadJson } from './helpers/fixtures.mjs';
import { EXPERIMENT_WORDING, GOVERNANCE_NAMES } from './helpers/vocabulary.mjs';

const SKILLS = join(REPO, 'skills');
const STAGES = ['recon', 'plan', 'execute', 'verify-handoff', 'recover'];
const PROVIDERS = { full: ['gcp', 'dns-cloudflare'], skeleton: ['aws', 'azure', 'nectar'] };
const BUDGET = { router: 170, stage: 90, fullProvider: 110, skeletonProvider: 40 };
const STATUSES = ['ASSUMED', 'USER_CONFIRMED', 'VERIFIED_LOCAL', 'VERIFIED_REMOTE', 'STALE', 'UNKNOWN', 'BLOCKED'];

const read = (...p) => readFile(join(SKILLS, ...p), 'utf8');
const lines = (text) => text.trimEnd().split('\n').length;

async function allSkillFiles() {
  const files = ['router.md', ...STAGES.map((s) => `stages/${s}.md`)];
  for (const p of [...PROVIDERS.full, ...PROVIDERS.skeleton]) files.push(`providers/${p}.md`);
  return files;
}

// The five rules the release-hygiene check requires, as phrases that must appear.
const RULES = {
  'FT-4 coalescing': [/first billable/i, /plan explanation/i, /ask once|one request/i],
  'FT-7 statuses': STATUSES.map((s) => new RegExp(`\\b${s}\\b`)),
  'FT-8 logging': [/remote-mutating/i, /\bintent\b/, /\bresult\b/],
  're-verify before write': [/re-verify/i],
  secrets: [/never write a secret value/i],
};

test('the router lives at exactly skills/router.md, as the workspace pointer says', () => {
  assert.equal(ROUTER_SKILL, join(SKILLS, 'router.md'));
});

test('the router, stage and provider files exist, and nothing else is in skills/', async () => {
  assert.deepEqual((await readdir(SKILLS)).sort(), ['providers', 'router.md', 'stages']);
  assert.deepEqual((await readdir(join(SKILLS, 'stages'))).sort(), STAGES.map((s) => `${s}.md`).sort());
  assert.deepEqual((await readdir(join(SKILLS, 'providers'))).sort(), [...PROVIDERS.full, ...PROVIDERS.skeleton].map((p) => `${p}.md`).sort());
});

test('every skill stays inside its length budget', async () => {
  assert.ok(lines(await read('router.md')) <= BUDGET.router, 'router');
  for (const s of STAGES) assert.ok(lines(await read('stages', `${s}.md`)) <= BUDGET.stage, s);
  for (const p of PROVIDERS.full) assert.ok(lines(await read('providers', `${p}.md`)) <= BUDGET.fullProvider, p);
  for (const p of PROVIDERS.skeleton) assert.ok(lines(await read('providers', `${p}.md`)) <= BUDGET.skeletonProvider, p);
});

test('the router carries every always-on rule', async () => {
  const router = await read('router.md');
  for (const [rule, patterns] of Object.entries(RULES)) {
    for (const p of patterns) assert.match(router, p, `${rule}: ${p}`);
  }
});

test('every stage file restates the always-on rules', async () => {
  for (const s of STAGES) {
    const text = await read('stages', `${s}.md`);
    for (const [rule, patterns] of Object.entries(RULES)) {
      if (rule === 'FT-7 statuses') assert.match(text, /seven statuses/i, `${s}: ${rule}`);
      else for (const p of patterns) assert.match(text, p, `${s}: ${rule} ${p}`);
    }
  }
});

test('the router says what to read first, how to use the tools, and which one stage file to load', async () => {
  const router = await read('router.md');
  for (const text of ['state.json', 'events.jsonl', 'evidence/', 'recent events', 'tools/watchover.mjs init', 'tools/watchover.mjs append', 'tools/watchover.mjs validate', 'Load only']) {
    assert.ok(router.includes(text), text);
  }
  for (const s of STAGES) assert.ok(router.includes(`stages/${s}.md`), s);
  assert.match(router, /never.*second state/i);
});

test('each stage file carries its Annex J responsibility', async () => {
  const want = {
    recon: [/read-only/i, /no billable/i, /local (uncommitted )?changes/i, /secret names/i],
    plan: [/tiers?/i, /no resource is created before/i, /heavier/i],
    execute: [/implicit/i, /activity/i, /long-running|more than 3 minutes/i],
    'verify-handoff': [/build.*deploy.*extern/is, /one component/i, /known.unverified/i, /teardown inventory/i, /implicit/i],
    recover: [/re-verify live facts/i, /diagnosis/i, /never create a second state/i, /STALE|stale/, /back to verif/i],
  };
  for (const [stage, patterns] of Object.entries(want)) {
    const text = await read('stages', `${stage}.md`);
    for (const p of patterns) assert.match(text, p, `${stage}: ${p}`);
  }
});

test('the handoff guidance covers all ten Annex K items', async () => {
  const text = await read('stages', 'verify-handoff.md');
  for (const p of [/task/i, /target/i, /stage/i, /intended.*actual|pinned.*deployed/is, /last verified/i, /stale.*unknown|unknown.*stale/is, /blocker|waiting/i, /next safe action/i, /decision owner/i, /evidence/i]) {
    assert.match(text, p, String(p));
  }
});

test('GCP is the target with validation pending; every other provider is UNVALIDATED', async () => {
  const gcp = await read('providers', 'gcp.md');
  assert.match(gcp, /validation pending/i);
  assert.doesNotMatch(gcp, /\bUNVALIDATED\b/);
  for (const p of ['dns-cloudflare', ...PROVIDERS.skeleton]) assert.match(await read('providers', `${p}.md`), /\bUNVALIDATED\b/, p);
  const dns = await read('providers', 'dns-cloudflare.md');
  assert.match(dns, /manual-edit/i);
  assert.match(dns, /scoped-token/i);
});

test('skills are neutral, client-neutral and free of governance or experiment wording', async () => {
  for (const f of await allSkillFiles()) {
    const text = await readFile(join(SKILLS, f), 'utf8');
    for (const banned of [...EXPERIMENT_WORDING, GOVERNANCE_NAMES, /CLAUDE\.md|AGENTS\.md|\.cursorrules|copilot-instructions/i, /benchmark/i]) {
      assert.doesNotMatch(text, banned, `${f}: ${banned}`);
    }
    for (const domain of text.match(/\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|io|dev|app|au)\b/gi) ?? []) {
      assert.ok(/(^|\.)example\.com$/.test(domain), `${f}: domain ${domain}`);
    }
  }
});

test('every example event in the skills is schema-valid once append fills its defaults', async () => {
  const validate = compileSchema(await loadJson(join(SCHEMA_DIR, 'event.schema.json')));
  let examples = 0;
  for (const f of await allSkillFiles()) {
    const text = await readFile(join(SKILLS, f), 'utf8');
    for (const [, block] of text.matchAll(/```json\n([\s\S]*?)```/g)) {
      const value = JSON.parse(block);
      if (!value.type) continue;
      examples += 1;
      const filled = { schema_version: '0.1', id: 'evt-0002', at: '2026-09-01T09:00:00Z', ...value };
      assert.deepEqual(validate(filled), [], `${f}: ${block}`);
    }
  }
  assert.ok(examples >= 4, `only ${examples} example events`);
});

test('Cloudflare manual-edit mode records the approval and a gated intent before the human edits DNS', async () => {
  const dns = await read('providers', 'dns-cloudflare.md');
  const manual = dns.slice(dns.indexOf('### manual-edit mode'), dns.indexOf('### scoped-token mode'));
  const steps = [/replies/i, /record the reply as a `decision`/i, /clear `pending_decision`/i, /gated `intent`/i, /human makes the change/i, /`result`/, /USER_CONFIRMED/, /verify/i];
  let at = -1;
  for (const p of steps) {
    const found = manual.slice(at + 1).search(p);
    assert.ok(found >= 0, `missing or out of order: ${p}`);
    at += 1 + found;
  }
});
