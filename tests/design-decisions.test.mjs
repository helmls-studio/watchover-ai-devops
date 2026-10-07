import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const ids = (text) => text.split('\n').filter((l) => /^\| D-\d{2} /.test(l)).map((l) => l.split('|')[1].trim());

test('design-decisions.md records every C1 default', async () => {
  const text = await read('docs/design-decisions.md');
  const recorded = ids(text);
  for (let n = 11; n <= 26; n += 1) assert.ok(recorded.includes(`D-${n}`), `missing decision D-${n}`);
});

test('design-decisions.md records every C1 R1-batch default', async () => {
  const recorded = ids(await read('docs/design-decisions.md'));
  for (let n = 27; n <= 32; n += 1) assert.ok(recorded.includes(`D-${n}`), `missing decision D-${n}`);
});

test('no C1 default is still listed as undecided', async () => {
  const text = await read('docs/design-decisions.md');
  const pending = text.split('## Defaults still to be decided')[1] ?? '';
  assert.ok(!/^- C1:/m.test(pending));
});

test('the documented keyword subset matches the validator', async () => {
  const { SUPPORTED_KEYWORDS } = await import('../tools/lib/schema-subset.mjs');
  const text = await read('docs/design-decisions.md');
  const row = text.split('\n').find((l) => l.startsWith('| D-12 '));
  assert.ok(row, 'D-12 row missing');
  const documented = [...row.matchAll(/`([$a-zA-Z]+)`/g)].map((m) => m[1]).sort();
  assert.deepEqual(documented, [...SUPPORTED_KEYWORDS].sort());
});

test('the documented freshness caps match the validator', async () => {
  const { FRESHNESS_CAPS } = await import('../tools/lib/semantic-checks.mjs');
  const text = await read('docs/design-decisions.md');
  const row = text.split('\n').find((l) => l.startsWith('| D-16 '));
  assert.ok(row, 'D-16 row missing');
  const documented = Object.fromEntries([...row.matchAll(/([a-z]+) (\d+)/g)].map((m) => [m[1], Number(m[2])]));
  assert.deepEqual(documented, { ...FRESHNESS_CAPS });
});

test('design-decisions.md records every C2 default and none is still undecided', async () => {
  const text = await read('docs/design-decisions.md');
  const recorded = ids(text);
  for (let n = 33; n <= 39; n += 1) assert.ok(recorded.includes(`D-${n}`), `missing decision D-${n}`);
  const pending = text.split('## Defaults still to be decided')[1] ?? '';
  assert.ok(!/^- C2:/m.test(pending));
});

const row = (text, id) => text.split('\n').find((l) => l.startsWith(`| ${id} `)) ?? '';

test('D-04 names Framework Python 3.12 as the working default for browser checks', async () => {
  const { FRAMEWORK_PYTHON_312 } = await import('./helpers/python.mjs');
  const d04 = row(await read('docs/design-decisions.md'), 'D-04');
  assert.ok(d04.includes('Framework Python 3.12'));
  assert.ok(d04.includes(FRAMEWORK_PYTHON_312));
  assert.ok(d04.includes('WATCHOVER_PYTHON'));
});

test('design-decisions.md records every C3 default, matching the code', async () => {
  const text = await read('docs/design-decisions.md');
  const recorded = ids(text);
  for (let n = 40; n <= 46; n += 1) assert.ok(recorded.includes(`D-${n}`), `missing decision D-${n}`);
  const pending = text.split('## Defaults still to be decided')[1] ?? '';
  assert.ok(!/^- C3:/m.test(pending));
  const { DEFAULT_PORT } = await import('../tools/lib/server.mjs');
  const { REFRESH_INTERVAL_MS, REFRESH_BOUND_MS, NO_RECENT_UPDATE_MINUTES } = await import('../app/web-ui/freshness.mjs');
  assert.ok(row(text, 'D-40').includes(String(DEFAULT_PORT)));
  assert.ok(row(text, 'D-41').includes(`every ${REFRESH_INTERVAL_MS / 1000} s`));
  assert.ok(row(text, 'D-41').includes(`within ${REFRESH_BOUND_MS / 1000} s`));
  assert.ok(row(text, 'D-42').includes(`${NO_RECENT_UPDATE_MINUTES} minutes`));
});

test('design-decisions.md records every C4 default, matching the skills test budgets', async () => {
  const text = await read('docs/design-decisions.md');
  const recorded = ids(text);
  for (let n = 47; n <= 50; n += 1) assert.ok(recorded.includes(`D-${n}`), `missing decision D-${n}`);
  const pending = text.split('## Defaults still to be decided')[1] ?? '';
  assert.ok(!/^- C4:/m.test(pending));
  const budgets = await readFile(new URL('./skills.test.mjs', import.meta.url), 'utf8');
  const [, router, stage, full, skeleton] = /router: (\d+), stage: (\d+), fullProvider: (\d+), skeletonProvider: (\d+)/.exec(budgets);
  const d47 = row(text, 'D-47');
  for (const n of [router, stage, full, skeleton]) assert.ok(d47.includes(`${n} lines`), `D-47 lacks ${n} lines`);
});

test('design-decisions.md records every C5 default and nothing for C5 is still undecided', async () => {
  const text = await read('docs/design-decisions.md');
  const recorded = ids(text);
  for (let n = 51; n <= 53; n += 1) assert.ok(recorded.includes(`D-${n}`), `missing decision D-${n}`);
  const pending = text.split('## Defaults still to be decided')[1] ?? '';
  assert.ok(!/^- C5:/m.test(pending));
});

test('public design rationale retains product docs and excludes evaluation-only decisions', async () => {
  const text = await read('docs/design-decisions.md');
  for (const id of ['D-54', 'D-55', 'D-56']) assert.ok(!ids(text).includes(id), id);
  assert.ok(row(text, 'D-53').includes('docs/validation.md'));
  assert.ok(row(text, 'D-53').includes('docs/provenance.md'));
  assert.ok(row(text, 'D-09').includes('0.1.2'));
});

test('design-decisions.md records the R3 defaults', async () => {
  const recorded = ids(await read('docs/design-decisions.md'));
  for (let n = 57; n <= 58; n += 1) assert.ok(recorded.includes(`D-${n}`), `missing decision D-${n}`);
});
