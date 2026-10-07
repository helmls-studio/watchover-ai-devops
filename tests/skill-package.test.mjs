import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, FIXTURES, readWorkspace, tempDir } from './helpers/fixtures.mjs';
import { validateWorkspace } from '../tools/lib/validate.mjs';

const referenced = (text) => [...new Set([...text.matchAll(/\b(?:stages|providers)\/[a-z0-9-]+\.md\b/g)].map((m) => m[0]))];
const missing = async (skills) => {
  const router = await readFile(join(skills, 'router.md'), 'utf8');
  const out = [];
  for (const rel of referenced(router)) await access(join(skills, rel)).catch(() => out.push(rel));
  return out;
};

test('the complete package has no dangling stage or provider reference', async () => {
  const skills = join(REPO, 'skills');
  const refs = referenced(await readFile(join(skills, 'router.md'), 'utf8'));
  assert.ok(refs.length >= 10, refs.join(','));
  assert.deepEqual(await missing(skills), []);
});

test('a deliberately reduced package is detected, and the router keeps its gates and rules', async () => {
  const skills = join(await tempDir('watchover-pkg-'), 'skills');
  await cp(join(REPO, 'skills'), skills, { recursive: true });
  await rm(join(skills, 'providers'), { recursive: true });
  const gaps = await missing(skills);
  assert.ok(gaps.length > 0 && gaps.every((g) => g.startsWith('providers/')), gaps.join(','));
  const router = await readFile(join(skills, 'router.md'), 'utf8');
  assert.match(router, /A referenced file is missing\?/);
  assert.match(router, /Say so once/);
  assert.match(router, /never grants a permission, removes a gate or fills a fact/);
  assert.match(router, /never write a secret value/i);
  assert.match(router, /Only an approved decision authorizes a gated action/);
});

test('the router opens with the minimal loop and keeps generic rules out of provider files', async () => {
  const router = await readFile(join(REPO, 'skills', 'router.md'), 'utf8');
  const loop = router.slice(0, router.indexOf('## The record'));
  for (const step of ['Intent', 'Action', 'Result', 'State', 'Validate']) assert.match(loop, new RegExp(`\\*\\*${step}\\.\\*\\*`));
  assert.match(router, /the rules in this router and the\s+stage files apply to every target/);
});

const filesUnder = async (root) => {
  const out = [];
  const walk = async (d, rel) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(d, e.name), `${rel}${e.name}/`);
      else out.push(`${rel}${e.name}`);
    }
  };
  await walk(root, '');
  return out.sort();
};

test('a declared reduced package: actual omissions match the declaration and the record discloses each gap once', async () => {
  const decl = JSON.parse(await readFile(join(FIXTURES, 'packages', 'reduced-no-dns', 'package-omissions.json'), 'utf8'));
  const full = await filesUnder(join(REPO, 'skills'));
  // Build the reduced package exactly as declared.
  const skills = join(await tempDir('watchover-reduced-'), 'skills');
  await cp(join(REPO, 'skills'), skills, { recursive: true });
  for (const f of decl.omitted) await rm(join(skills, f));
  await writeFile(join(skills, 'package-omissions.json'), `${JSON.stringify(decl, null, 2)}\n`);
  const included = (await filesUnder(skills)).filter((f) => f !== 'package-omissions.json');
  assert.deepEqual(included, full.filter((f) => !decl.omitted.includes(f)));
  assert.deepEqual(await missing(skills), decl.omitted, 'every dangling reference is declared, and nothing else is missing');
  // The full product package keeps every provider (source unchanged).
  for (const f of decl.omitted) await access(join(REPO, 'skills', f));

  // The record: one disclosure per declared gap, kept once across a continuation.
  const ws = await readWorkspace(join(FIXTURES, 'valid', 'scenarios', 'package-gap'));
  assert.equal((await validateWorkspace(join(FIXTURES, 'valid', 'scenarios', 'package-gap'))).ok, true);
  const gaps = ws.state.open_items.filter((o) => /^Package gap/.test(o.text));
  assert.equal(gaps.length, decl.omitted.length);
  for (const f of decl.omitted) assert.equal(gaps.filter((o) => o.text.includes(f)).length, 1, f);
  assert.match(gaps[0].text, /Impact: /);
  assert.match(gaps[0].text, /still needs its own approval/);
  assert.equal(gaps[0].owner, 'ai');
  assert.match(ws.state.activity.summary, /gap already disclosed/);
  // No permission is invented: nothing approved, nothing pending, the DNS gate stays ahead.
  assert.equal(ws.state.pending_decision, null);
  assert.equal(ws.events.filter((e) => e.type === 'decision').length, 0);
  assert.match(ws.state.next.action, /separate dns approval/);
});
