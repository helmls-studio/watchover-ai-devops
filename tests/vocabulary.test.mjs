import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXPERIMENT_WORDING, GOVERNANCE_NAMES, OVERSIGHT_NAME, SAMPLES, contentViolations, loadPrivateTerms, PUBLIC_URLS } from './helpers/vocabulary.mjs';
import { REPO, tempDir } from './helpers/fixtures.mjs';

test('each experiment-wording guard catches its own class', () => {
  SAMPLES.experiment.forEach((sample, i) => {
    assert.match(`some text ${sample} here`, EXPERIMENT_WORDING[i], `guard ${i}`);
  });
});

test('the private-seat guard catches neutral canaries, whole words only', () => {
  for (const name of SAMPLES.governance) assert.match(`as ${name} said`, GOVERNANCE_NAMES, name);
  assert.doesNotMatch('HELM H.E.L.M Council Executor Reviewer Operations Coordinator', GOVERNANCE_NAMES);
});

test('the coordinator guard catches its neutral canary, whole words only', () => {
  assert.match(`ask ${SAMPLES.oversight} first`, OVERSIGHT_NAME);
  assert.doesNotMatch('describes the design', OVERSIGHT_NAME);
});

test('the guards leave neutral product wording alone', () => {
  const neutral = 'The AI records a stage change; the human approves the plan in the session.';
  for (const g of [...EXPERIMENT_WORDING, GOVERNANCE_NAMES, OVERSIGHT_NAME]) assert.doesNotMatch(neutral, g);
});

test('tracked paths and content pass always-on guards and any configured private denylist', async () => {
  const files = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean);
  const privateTerms = await loadPrivateTerms(undefined, REPO);
  console.log(`External privacy denylist: ${privateTerms.length ? 'configured' : 'not configured; generic guards only'}`);
  const offending = [];
  for (const file of files) {
    const text = await readFile(join(REPO, file), 'utf8');
    for (const hit of [...contentViolations(file, file, privateTerms), ...contentViolations(text, file, privateTerms)]) {
      offending.push({ file, ...hit });
    }
  }
  assert.deepEqual(offending, []);
});

test('personal-path guards reject neutral account paths and allow ordinary local usage', () => {
  const paths = [
    ['', 'Users', 'example-user', 'record'].join('/'),
    ['', 'home', 'example-user', 'record'].join('/'),
    ['C:', 'Users', 'example-user', 'record'].join(String.fromCharCode(92)),
  ];
  for (const path of paths) assert.ok(contentViolations(path, 'README.md').some((hit) => hit.check === 'personal-path'));
  for (const text of ['/var/log/app', 'http://127.0.0.1:7431/', 'localhost', 'example.com']) assert.deepEqual(contentViolations(text, 'README.md'), []);
});

test('bare historical stage labels are scoped to exactly three documents', () => {
  const stages = [['W', '1'].join(''), ['W', '2'].join('')];
  for (const file of ['README.md', 'docs/validation.md', 'docs/provenance.md']) {
    for (const stage of stages) assert.deepEqual(contentViolations(stage, file), []);
    assert.ok(contentViolations(stages[1] + 'B', file).length);
  }
  for (const file of ['skills/router.md', 'tools/example.mjs', 'tests/example.mjs', 'docs/architecture.md', 'docs/design-decisions.md', 'SECURITY.md']) {
    for (const stage of stages) assert.ok(contentViolations(stage, file).length, file);
  }
});

test('external private terms detect neutral literal, escaped and split forms with exact URL exceptions', async () => {
  const file = join(await tempDir(), 'private-terms.txt');
  const term = ['quartz', 'moth-417'].join('');
  await writeFile(file, `# neutral control\n${term}\nword:coordinator-sample-417\n`);
  const terms = await loadPrivateTerms(file, REPO);
  for (const text of [term.toUpperCase(), 'w("quartz", "moth-417")', String.raw`\u0071uartzmoth-417`, String.raw`\x71uartzmoth-417`]) {
    assert.ok(contentViolations(text, 'README.md', terms).some((hit) => hit.check === 'private-term'));
  }
  assert.ok(contentViolations('coordinator-sample-417', 'README.md', terms).length);
  assert.deepEqual(contentViolations('coordinator-sample-417describes', 'README.md', terms), []);
  const url = PUBLIC_URLS[2];
  const username = new URL(url).pathname.split('/')[1];
  const accountTerms = [{ value: username, wholeWord: false }];
  for (const approved of PUBLIC_URLS.filter((value) => new URL(value).pathname.split('/')[1] === username)) {
    assert.deepEqual(contentViolations(`[process](${approved})`, 'README.md', accountTerms), []);
    for (const text of [approved + '/private', approved + '?redirect=1']) assert.ok(contentViolations(text, 'README.md', accountTerms).length);
    assert.ok(contentViolations(approved, 'tools/example.mjs', accountTerms).length);
  }
  assert.ok(contentViolations(username, 'README.md', accountTerms).length);
});

test('the optional private input fails closed when configured incorrectly', async () => {
  assert.deepEqual(await loadPrivateTerms('', REPO), []);
  await assert.rejects(loadPrivateTerms(join(REPO, 'package.json'), REPO), /outside the product/);
  const folder = await tempDir();
  await assert.rejects(loadPrivateTerms(join(folder, 'missing.txt'), REPO), /readable file/);
  const file = join(folder, 'empty.txt');
  await writeFile(file, '# no terms\n');
  await assert.rejects(loadPrivateTerms(file, REPO), /nonempty terms/);
});
