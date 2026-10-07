import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('LICENSE is the MIT license with a neutral copyright holder', async () => {
  const text = await read('LICENSE');
  assert.match(text, /^MIT License$/m);
  assert.match(text, /^Copyright \(c\) 2026 WatchOver AI DevOps contributors$/m);
  assert.match(text, /Permission is hereby granted, free of charge/);
  assert.match(text, /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/);
});

test('package.json declares an MIT ES-module package with no dependencies', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.name, 'watchover-ai-devops');
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.license, 'MIT');
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal(pkg[key], undefined, `${key} must be absent`);
  }
});

test('npm test runs the node:test suites under tests/', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.match(pkg.scripts?.test ?? '', /^node --test "tests\/\*\*\/\*\.test\.mjs"$/);
});

test('.gitignore keeps dependencies and any evidence directory out of git', async () => {
  const lines = (await read('.gitignore')).split('\n').map((l) => l.trim());
  assert.ok(lines.includes('node_modules/'));
  assert.ok(lines.includes('evidence/'));
});

test('design-decisions.md records every C0 default with a choice and a reason', async () => {
  const text = await read('docs/design-decisions.md');
  const rows = text
    .split('\n')
    .filter((l) => /^\| D-\d{2} /.test(l))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
  const ids = rows.map((r) => r[0]);
  for (const id of ['D-01', 'D-02', 'D-03', 'D-04', 'D-05', 'D-06', 'D-07', 'D-08', 'D-09', 'D-10']) {
    assert.ok(ids.includes(id), `missing decision ${id}`);
  }
  assert.equal(new Set(ids).size, ids.length, 'decision ids must be unique');
  for (const row of rows) {
    assert.equal(row.length, 4, `row ${row[0]} must have ID, Decision, Choice, Reason`);
    assert.ok(row.every((cell) => cell.length > 0), `row ${row[0]} has an empty cell`);
  }
});
