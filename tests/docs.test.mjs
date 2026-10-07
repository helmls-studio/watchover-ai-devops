import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO } from './helpers/fixtures.mjs';
import { experimentGuards, GOVERNANCE_NAMES, OVERSIGHT_NAME } from './helpers/vocabulary.mjs';

const read = (p) => readFile(join(REPO, p), 'utf8');
const DOCS = ['README.md', 'SECURITY.md', 'docs/architecture.md', 'docs/design-decisions.md', 'docs/validation.md', 'docs/provenance.md'];
const section = (text, heading) => {
  const start = text.indexOf(`\n## ${heading}`);
  if (start < 0) return '';
  const next = text.indexOf('\n## ', start + 4);
  return text.slice(start, next < 0 ? undefined : next);
};

test('the README defines the product and separates Validated from Roadmap', async () => {
  const readme = await read('README.md');
  assert.match(readme, /^# WatchOver AI DevOps/m);
  const validated = section(readme, 'Validated');
  const roadmap = section(readme, 'Roadmap');
  assert.ok(validated && roadmap, 'both sections exist');
  assert.match(validated, /local/i);
  assert.match(validated, /cloud profiles remain\s+unverified/i);
  assert.match(roadmap, /GCP/);
  assert.match(roadmap, /UNVALIDATED/);
  assert.doesNotMatch(validated, /\bGCP\b.*validated(?! pending)/i, 'GCP is not claimed as validated');
  assert.match(readme, /MIT/);
  for (const cmd of ['watchover.mjs init', 'watchover.mjs append', 'watchover.mjs validate', 'watchover.mjs show', 'skills/router.md']) {
    assert.ok(readme.includes(cmd), cmd);
  }
});

test('no document makes a benchmark or result claim', async () => {
  for (const f of DOCS) {
    const text = await read(f);
    assert.doesNotMatch(text, /\bbenchmark(ed|s)?\b(?! or result claims)(?! claims)/i, f);
    assert.doesNotMatch(text, /\d+(\.\d+)?\s?% (faster|fewer|less|more|better)|(faster|cheaper|better) than\b/i, f);
  }
});

test('documents allow attribution and history while excluding arm labels and private canaries', async () => {
  for (const f of DOCS) {
    const text = await read(f);
    for (const banned of [...experimentGuards(f), GOVERNANCE_NAMES, OVERSIGHT_NAME]) {
      assert.doesNotMatch(text, banned, `${f}: ${banned}`);
    }
  }
});

test('SECURITY.md covers secrets, the read-only local view, evidence and known limits', async () => {
  const text = await read('SECURITY.md');
  for (const p of [/never.*secret value/i, /canary/i, /redact/i, /127\.0\.0\.1|loopback/i, /read-only/i, /GET and HEAD/, /evidence.*never served|never serves evidence/i, /content-security-policy/i, /## Known limits/, /## Reporting/]) {
    assert.match(text, p, String(p));
  }
});

test('docs/architecture.md describes every component and trust boundary', async () => {
  const text = await read('docs/architecture.md');
  for (const p of ['state.json', 'events.jsonl', 'evidence/', 'schema/', 'tools/watchover.mjs', 'tools/lib/validate.mjs', 'tools/lib/server.mjs', 'app/web-ui/', 'skills/router.md', 'integrations/catalog.json', 'Trust boundaries']) {
    assert.ok(text.includes(p), p);
  }
  assert.doesNotMatch(text, /v0\.1b/);
  assert.match(text, /local writer for human input and a guarded reviewer mode are deferred/);
});

test('README, validation and provenance agree on evidence and archive limits', async () => {
  for (const file of ['README.md', 'docs/validation.md', 'docs/provenance.md']) {
    const text = await read(file);
    assert.match(text, /three experimental stages/i, file);
    assert.match(text, new RegExp(`${['W', '2'].join('')} (included|had) two runs`, 'i'), file);
    assert.match(text, /both formal(?:\s+arm)?\s+verdicts were INVALID/, file);
    assert.match(text, /single Basic-mode observation|one Basic-mode observation/, file);
    assert.match(text, /not a controlled causal proof/, file);
    assert.match(text, /in preparation/, file);
  }
  const limits = await read('docs/validation.md');
  assert.match(limits, /test-only injected post-check failure/);
  assert.match(limits, /AI.*comply|AI obedience/s);
  for (const file of ['README.md', 'docs/provenance.md']) {
    const text = await read(file);
    assert.match(text, /built entirely through HELM's council, executor and operations workflow/);
    assert.match(text, /human.*(?:manually )?routed messages|manually routed messages/is);
    for (const route of ['sessions/', 'council-records/', 'execution-records/', 'operations-records/']) assert.ok(text.includes(route), route);
    assert.match(text, /pending (?:archive )?routes/i);
    assert.match(text, /translated,\s+redacted derivatives/);
  }
});

test('local Markdown documentation links resolve inside the product', async () => {
  const { access } = await import('node:fs/promises');
  const { dirname, resolve, relative, isAbsolute } = await import('node:path');
  let links = 0;
  for (const file of DOCS) {
    for (const [, target] of (await read(file)).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      if (/^https?:|^#/.test(target)) continue;
      const resolved = resolve(REPO, dirname(file), target.split('#')[0]);
      const rel = relative(REPO, resolved);
      assert.ok(!rel.startsWith('..') && !isAbsolute(rel), `${file}: ${target}`);
      await access(resolved); links += 1;
    }
  }
  assert.ok(links >= 10, 'meaningful local link coverage');
});

// Added after running the quick start by hand showed an earlier version left the
// workspace inconsistent; it therefore passed on its first run.
test('the README quick start runs as written and leaves a valid workspace', async () => {
  const { execSync } = await import('node:child_process');
  const { tempDir } = await import('./helpers/fixtures.mjs');
  const readme = await read('README.md');
  const block = /```sh\n([\s\S]*?)```/.exec(readme)[1];
  const commands = block.split('\n').filter((l) => l.trim() && !l.includes(' show '))
    .map((l) => l.replaceAll('node tools/', `node "${join(REPO, 'tools')}/`).replace('watchover.mjs', 'watchover.mjs"'));
  const cwd = await tempDir();
  const out = execSync(commands.join(' && '), { cwd, encoding: 'utf8', shell: '/bin/sh' });
  assert.match(out, /valid: all checks passed/);
});
