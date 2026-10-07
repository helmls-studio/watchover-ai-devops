import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateWorkspace } from '../tools/lib/validate.mjs';
import { FIXTURES, SCHEMA_DIR, loadJson, tempDir } from './helpers/fixtures.mjs';

const VALID_STEP = join(FIXTURES, 'valid', 'lifecycle', '03-long-operation');
const ANNOTATIONS = new Set(['$ref', 'title', 'description', '$comment']);

// A pattern bounds length only if it is anchored and has no open-ended repetition.
const fixedLengthPattern = (p) => typeof p === 'string' && p.startsWith('^') && p.endsWith('$') && !/[*+]|\{\d+,\}/.test(p);

function unboundedNodes(node, path, problems) {
  if (node.$ref && Object.keys(node).every((k) => ANNOTATIONS.has(k))) return problems; // checked at its definition
  const types = node.type === undefined ? [] : [].concat(node.type);
  const finite = 'enum' in node || 'const' in node;
  if (types.length === 0 && !finite && !node.$ref) problems.push(`${path}: no type, enum or const`);
  if (types.includes('array') && node.maxItems === undefined) problems.push(`${path}: array without maxItems`);
  if (types.includes('string') && node.maxLength === undefined && !finite && !fixedLengthPattern(node.pattern)) problems.push(`${path}: string without a length bound`);
  if ((types.includes('number') || types.includes('integer')) && !finite && (node.minimum === undefined || node.maximum === undefined)) problems.push(`${path}: number without minimum and maximum`);
  if (types.includes('object') && node.additionalProperties !== false) problems.push(`${path}: object allows unlisted properties`);
  for (const [name, sub] of Object.entries(node.properties ?? {})) unboundedNodes(sub, `${path}/properties/${name}`, problems);
  if (node.items) unboundedNodes(node.items, `${path}/items`, problems);
  for (const [name, sub] of Object.entries(node.$defs ?? {})) unboundedNodes(sub, `${path}/$defs/${name}`, problems);
  return problems;
}

test('every instance string, array, number and object in the product schemas is bounded', async () => {
  for (const file of ['state.schema.json', 'event.schema.json']) {
    assert.deepEqual(unboundedNodes(await loadJson(join(SCHEMA_DIR, file)), '', []), [], file);
  }
});

test('the bounds check itself notices an unbounded string, array, number and object', () => {
  const problems = unboundedNodes({
    type: 'object',
    properties: { s: { type: 'string', pattern: '^evt-[0-9]{4,}$' }, a: { type: 'array', items: { enum: ['x'] } }, n: { type: 'number', minimum: 0 }, o: { type: 'object' } },
    additionalProperties: false,
  }, '', []);
  assert.deepEqual(problems, [
    '/properties/s: string without a length bound',
    '/properties/a: array without maxItems',
    '/properties/n: number without minimum and maximum',
    '/properties/o: object allows unlisted properties',
  ]);
});

async function withLongValue(edit) {
  const dir = await tempDir();
  await cp(VALID_STEP, dir, { recursive: true });
  await edit(dir);
  return validateWorkspace(dir);
}

test('a timestamp with a 100,000-digit fraction is rejected by its length bound', async () => {
  const result = await withLongValue(async (dir) => {
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    state.identity.updated_at = `2026-09-01T09:46:00.${'1'.repeat(100000)}Z`;
    await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2));
  });
  assert.ok(result.errors.some((e) => e.check === 'schema' && e.keyword === 'maxLength' && e.pointer === '/identity/updated_at'));
});

test('a 100,000-digit event id is rejected by its length bound', async () => {
  const result = await withLongValue(async (dir) => {
    const lines = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trimEnd().split('\n');
    const last = JSON.parse(lines.at(-1));
    last.id = `evt-${'1'.repeat(100000)}`;
    lines[lines.length - 1] = JSON.stringify(last);
    await writeFile(join(dir, 'events.jsonl'), `${lines.join('\n')}\n`);
  });
  assert.ok(result.errors.some((e) => e.check === 'schema' && e.keyword === 'maxLength' && e.pointer === '/id' && e.line === 18));
});
