import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { LIMITS, validateWorkspace } from '../tools/lib/validate.mjs';
import { SECRET_PATTERNS } from '../tools/lib/secret-scan.mjs';
import { FIXTURES, SCHEMA_DIR, subdirs, loadJson, tempDir } from './helpers/fixtures.mjs';

const VALID_STEP = join(FIXTURES, 'valid', 'lifecycle', '03-long-operation');
const CANARY = ['AK', 'IA', 'WATCHOVERCANARY1'].join('');

async function allValidDirs() {
  const dirs = [];
  for (const group of ['lifecycle', 'status']) {
    for (const name of await subdirs(join(FIXTURES, 'valid', group))) dirs.push(join(FIXTURES, 'valid', group, name));
  }
  return dirs;
}

// Copy the product schemas, let the test damage one, and return the copy's directory.
async function damagedSchemaDir(file, damage) {
  const dir = await tempDir('watchover-schema-');
  await cp(SCHEMA_DIR, dir, { recursive: true });
  const schema = await loadJson(join(dir, file));
  damage(schema);
  await writeFile(join(dir, file), JSON.stringify(schema, null, 2));
  return dir;
}

test('every valid fixture validates, with the scanner self-test passing in the same call', async () => {
  for (const dir of await allValidDirs()) {
    const result = await validateWorkspace(dir);
    assert.deepEqual(result.errors, [], dir);
    assert.equal(result.ok, true);
    assert.equal(result.secret_scan.self_test, 'passed');
    assert.equal(result.secret_scan.patterns, SECRET_PATTERNS.length);
    assert.equal(result.secret_scan.findings, 0);
  }
});

test('every invalid fixture is rejected for exactly its intended reason', async () => {
  const names = await subdirs(join(FIXTURES, 'invalid'));
  assert.deepEqual(names, ['malformed-events-line', 'malformed-state-json', 'planted-secret-canary', 'schema-invalid-secret-value-field', 'schema-invalid-status']);
  for (const name of names) {
    const dir = join(FIXTURES, 'invalid', name);
    const expected = await loadJson(join(dir, 'expected.json'));
    const result = await validateWorkspace(dir);
    assert.equal(result.ok, false, name);
    assert.deepEqual(
      [...new Set(result.errors.map((e) => e.check))].sort(),
      [...new Set(expected.errors.map((e) => e.check))].sort(),
      `${name}: ${JSON.stringify(result.errors)}`,
    );
    for (const want of expected.errors) {
      assert.ok(result.errors.some((got) => Object.entries(want).every(([k, v]) => got[k] === v)), `${name} missing ${JSON.stringify(want)}`);
    }
  }
});

test('the planted canary is caught in the same pass that clears the valid fixtures', async () => {
  const dirs = [...(await allValidDirs()), join(FIXTURES, 'invalid', 'planted-secret-canary')];
  const results = await Promise.all(dirs.map((d) => validateWorkspace(d)));
  const canary = results.at(-1);
  assert.equal(canary.secret_scan.findings, 1, 'positive control detected');
  assert.ok(results.slice(0, -1).every((r) => r.secret_scan.findings === 0), 'valid fixtures clean');
  assert.ok(results.every((r) => r.secret_scan.self_test === 'passed'));
  assert.ok(!JSON.stringify(canary).includes(CANARY), 'the result never repeats the secret value');
});

test('the secret scan still runs when the JSON is malformed, and errors never echo the input', async () => {
  const dir = await tempDir();
  await cp(join(FIXTURES, 'invalid', 'malformed-state-json'), dir, { recursive: true });
  const text = await readFile(join(dir, 'state.json'), 'utf8');
  await writeFile(join(dir, 'state.json'), text.replace('"stage": "recon"', `"stage": "recon ${CANARY}`));
  const result = await validateWorkspace(dir);
  assert.deepEqual([...new Set(result.errors.map((e) => e.check))].sort(), ['json', 'secret']);
  assert.ok(!JSON.stringify(result).includes(CANARY));
});

test('a product schema with an unsupported keyword fails closed', async () => {
  const schemaDir = await damagedSchemaDir('state.schema.json', (s) => { s.properties.facts.items.patternProperties = {}; });
  const result = await validateWorkspace(VALID_STEP, { schemaDir });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => [e.check, e.file, e.keyword, e.pointer]), [
    ['schema-load', 'state.schema.json', 'patternProperties', '/properties/facts/items'],
  ]);
});

test('a product schema with a remote $ref fails closed', async () => {
  const schemaDir = await damagedSchemaDir('event.schema.json', (s) => { s.properties.actor = { $ref: 'https://example.com/actor.json' }; });
  const result = await validateWorkspace(VALID_STEP, { schemaDir });
  assert.deepEqual(result.errors.map((e) => [e.check, e.file, e.keyword, e.pointer]), [
    ['schema-load', 'event.schema.json', '$ref', '/properties/actor'],
  ]);
});

test('a product schema with an unknown format fails closed', async () => {
  const schemaDir = await damagedSchemaDir('state.schema.json', (s) => { s.$defs.timestamp.format = 'date'; });
  const result = await validateWorkspace(VALID_STEP, { schemaDir });
  assert.deepEqual(result.errors.map((e) => [e.check, e.file, e.keyword, e.pointer]), [
    ['schema-load', 'state.schema.json', 'format', '/$defs/timestamp'],
  ]);
});

test('a schema file that is not valid JSON fails closed', async () => {
  const schemaDir = await tempDir('watchover-schema-');
  await cp(SCHEMA_DIR, schemaDir, { recursive: true });
  await writeFile(join(schemaDir, 'event.schema.json'), '{ "type": ');
  const result = await validateWorkspace(VALID_STEP, { schemaDir });
  assert.deepEqual(result.errors.map((e) => [e.check, e.file]), [['schema-load', 'event.schema.json']]);
});

test('a workspace without events.jsonl is rejected', async () => {
  const dir = await tempDir();
  await cp(VALID_STEP, dir, { recursive: true });
  await rm(join(dir, 'events.jsonl'));
  const result = await validateWorkspace(dir);
  assert.deepEqual(result.errors.map((e) => [e.check, e.file]), [['workspace', 'events.jsonl']]);
});

test('when one workspace file is missing, the remaining file is still secret-scanned', async () => {
  const cases = [
    { missing: 'events.jsonl', planted: 'state.json', plant: (t) => t.replace('"stage": "executing"', `"stage": "executing ${CANARY}"`) },
    { missing: 'state.json', planted: 'events.jsonl', plant: (t) => t.replace('"summary":"Create the tier B VM"', `"summary":"Create the tier B VM ${CANARY}"`) },
  ];
  for (const { missing, planted, plant } of cases) {
    const dir = await tempDir();
    await cp(VALID_STEP, dir, { recursive: true });
    const text = await readFile(join(dir, planted), 'utf8');
    assert.notEqual(plant(text), text, `canary was not planted in ${planted}`);
    await writeFile(join(dir, planted), plant(text));
    await rm(join(dir, missing));
    const result = await validateWorkspace(dir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.check === 'workspace' && e.file === missing), `${missing}: missing-file error`);
    assert.ok(result.errors.some((e) => e.check === 'secret' && e.file === planted && e.pattern === 'aws-access-key-id'), `${planted}: secret finding`);
    assert.equal(result.secret_scan.findings, 1);
    assert.equal(result.secret_scan.self_test, 'passed');
    assert.ok(!JSON.stringify(result).includes(CANARY), 'the result never repeats the secret value');
  }
});

test('a blank line inside events.jsonl is rejected', async () => {
  const dir = await tempDir();
  await cp(VALID_STEP, dir, { recursive: true });
  const lines = (await readFile(join(dir, 'events.jsonl'), 'utf8')).split('\n');
  lines.splice(2, 0, '');
  await writeFile(join(dir, 'events.jsonl'), lines.join('\n'));
  const result = await validateWorkspace(dir);
  assert.deepEqual(result.errors.map((e) => [e.check, e.line]), [['json', 3]]);
});

test('schema errors on events name the line, keyword and pointer', async () => {
  const dir = await tempDir();
  await cp(VALID_STEP, dir, { recursive: true });
  const lines = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trimEnd().split('\n');
  const ev = JSON.parse(lines[3]);
  ev.actor.role = 'robot';
  lines[3] = JSON.stringify(ev);
  await writeFile(join(dir, 'events.jsonl'), `${lines.join('\n')}\n`);
  const result = await validateWorkspace(dir);
  assert.deepEqual(result.errors.map((e) => [e.check, e.file, e.line, e.keyword, e.pointer]), [
    ['schema', 'events.jsonl', 4, 'enum', '/actor/role'],
  ]);
});

// ---- evidence scanning ----

async function workspaceWithEvidence(files) {
  const dir = await tempDir();
  await cp(VALID_STEP, dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, '..'), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

test('clean evidence files keep a valid workspace valid', async () => {
  const dir = await workspaceWithEvidence({ 'evidence/0013-instance-create.txt': 'Created [demo-app-vm].\nSTATUS: RUNNING\n' });
  const result = await validateWorkspace(dir);
  assert.deepEqual(result.errors, []);
});

test('every regular file under evidence/ is secret-scanned, recursively', async () => {
  const dir = await workspaceWithEvidence({
    'evidence/0013-instance-create.txt': 'Created [demo-app-vm].\n',
    'evidence/nested/deeper/0019-compose-up.txt': `step one\nexport KEY=${CANARY}\n`,
  });
  const result = await validateWorkspace(dir);
  assert.deepEqual(result.errors.map((e) => [e.check, e.file, e.line, e.pattern]), [
    ['secret', 'evidence/nested/deeper/0019-compose-up.txt', 2, 'aws-access-key-id'],
  ]);
  assert.ok(!JSON.stringify(result).includes(CANARY));
});

test('evidence is scanned even when state is malformed and events are missing', async () => {
  const dir = await workspaceWithEvidence({ 'evidence/0002-gcloud-config.txt': `${CANARY}\n` });
  await writeFile(join(dir, 'state.json'), '{ "stage": ');
  await rm(join(dir, 'events.jsonl'));
  const result = await validateWorkspace(dir);
  assert.ok(result.errors.some((e) => e.check === 'workspace' && e.file === 'events.jsonl'));
  assert.ok(result.errors.some((e) => e.check === 'secret' && e.file === 'evidence/0002-gcloud-config.txt'));
  assert.ok(!JSON.stringify(result).includes(CANARY));
});

test('evidence symbolic links are reported and never followed', async () => {
  const outside = await tempDir('watchover-outside-');
  await writeFile(join(outside, 'leak.txt'), `${CANARY}\n`);
  const dir = await workspaceWithEvidence({});
  await mkdir(join(dir, 'evidence'), { recursive: true });
  await symlink(join(outside, 'leak.txt'), join(dir, 'evidence', 'file-link.txt'));
  await symlink(outside, join(dir, 'evidence', 'dir-link'));
  const result = await validateWorkspace(dir);
  assert.deepEqual(result.errors.map((e) => [e.check, e.file]).sort(), [
    ['evidence', 'evidence/dir-link'],
    ['evidence', 'evidence/file-link.txt'],
  ]);
  assert.equal(result.secret_scan.findings, 0, 'link targets were not read');
});

test('an evidence folder that is itself a symbolic link is reported and not followed', async () => {
  const outside = await tempDir('watchover-outside-');
  await writeFile(join(outside, 'leak.txt'), `${CANARY}\n`);
  const dir = await workspaceWithEvidence({});
  await symlink(outside, join(dir, 'evidence'));
  const result = await validateWorkspace(dir);
  assert.deepEqual(result.errors.map((e) => [e.check, e.file]), [['evidence', 'evidence']]);
  assert.equal(result.secret_scan.findings, 0);
});

// ---- output never repeats secret-shaped input ----

test('schema errors on secret-shaped property names are redacted', async () => {
  const urlSecret = 'postgres://app:watchover-canary@db.example.com/app';
  const dir = await tempDir();
  await cp(VALID_STEP, dir, { recursive: true });
  const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  state.secrets[0][CANARY] = 'x';
  state.facts[0][urlSecret] = 'y';
  await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2));
  const result = await validateWorkspace(dir);
  const checks = new Set(result.errors.map((e) => e.check));
  assert.ok(checks.has('schema') && checks.has('secret'), [...checks].join());
  const out = JSON.stringify(result);
  assert.ok(!out.includes(CANARY) && !out.includes('watchover-canary'), out);
  assert.ok(result.errors.some((e) => e.check === 'schema' && e.pointer === '/secrets/0/[REDACTED:aws-access-key-id]'));
});

test('named-check errors quoting secret-shaped identifiers are redacted', async () => {
  const slackShaped = ['xo', 'xb-', 'watchover-canary'].join('');
  const dir = await tempDir();
  await cp(VALID_STEP, dir, { recursive: true });
  const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  state.resources[1].evidence_fact = slackShaped;
  await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2));
  const result = await validateWorkspace(dir);
  const checks = new Set(result.errors.map((e) => e.check));
  assert.ok(checks.has('references-resolve') && checks.has('secret'), [...checks].join());
  assert.ok(!JSON.stringify(result).includes('watchover-canary'));
});

// ---- raw size bounds ----

test('an oversized events line is rejected even when its numbers are in range', async () => {
  const dir = await tempDir();
  await cp(VALID_STEP, dir, { recursive: true });
  const lines = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trimEnd().split('\n');
  lines[0] = lines[0].replace('"schema_version":"0.1"', `"schema_version":"0.1","pad":1.${'0'.repeat(20000)}`);
  await writeFile(join(dir, 'events.jsonl'), `${lines.join('\n')}\n`);
  const result = await validateWorkspace(dir);
  assert.ok(result.errors.some((e) => e.check === 'size' && e.file === 'events.jsonl' && e.line === 1), JSON.stringify(result.errors.map((e) => e.check)));
});

// ---- Reviewer-discovered regression tests (R1 closure) ----
// These cover limits that already existed in validate.mjs, so they were added after the
// behaviour and no failing run was observed first.

test('an oversized state.json is rejected by its size limit', async () => {
  const dir = await tempDir();
  await cp(VALID_STEP, dir, { recursive: true });
  const text = await readFile(join(dir, 'state.json'), 'utf8');
  await writeFile(join(dir, 'state.json'), text + ' '.repeat(LIMITS.stateBytes)); // trailing whitespace keeps it valid JSON
  const result = await validateWorkspace(dir);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => [e.check, e.file]), [['size', 'state.json']]);
});

test('an evidence file over the scan limit is reported and not scanned', async () => {
  const dir = await workspaceWithEvidence({ 'evidence/huge.txt': `${CANARY}\n`.padEnd(LIMITS.evidenceFileBytes + 1, 'x') });
  const result = await validateWorkspace(dir);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => [e.check, e.file]), [['evidence', 'evidence/huge.txt']]);
  assert.equal(result.secret_scan.findings, 0, 'the oversized file was not read');
  assert.ok(!JSON.stringify(result).includes(CANARY));
});

test('a special evidence file is reported without being opened', { timeout: 10000 }, async () => {
  const dir = await workspaceWithEvidence({ 'evidence/0013-instance-create.txt': 'Created [demo-app-vm].\n' });
  execFileSync('mkfifo', [join(dir, 'evidence', 'pipe')]); // opening a FIFO for reading would block
  const result = await validateWorkspace(dir);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => [e.check, e.file]), [['evidence', 'evidence/pipe']]);
});
