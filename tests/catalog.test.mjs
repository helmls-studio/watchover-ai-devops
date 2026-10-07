import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scanText } from '../tools/lib/secret-scan.mjs';
import { REPO } from './helpers/fixtures.mjs';

const FILE = join(REPO, 'integrations', 'catalog.json');
const FIELDS = ['id', 'name', 'kind', 'provider', 'stages', 'source', 'install_or_access', 'permissions', 'risk', 'last_checked', 'check_status', 'check_note', 'cli_fallback', 'loaded_by_default'];
const STAGES = ['recon', 'plan', 'execute', 'verify', 'teardown'];
const load = async () => JSON.parse(await readFile(FILE, 'utf8'));

test('the catalog has 10 to 20 entries with every field', async () => {
  const { entries } = await load();
  assert.ok(entries.length >= 10 && entries.length <= 20, `${entries.length} entries`);
  for (const e of entries) {
    assert.deepEqual(Object.keys(e).sort(), [...FIELDS].sort(), e.id);
    for (const f of ['id', 'name', 'provider', 'source', 'install_or_access', 'permissions', 'cli_fallback', 'check_note']) {
      assert.ok(typeof e[f] === 'string' && e[f].trim().length > 0, `${e.id}.${f}`);
    }
  }
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length, 'ids are unique');
});

test('entries name an official source, known stages, a kind and a risk level', async () => {
  for (const e of (await load()).entries) {
    assert.match(e.source, /^[A-Z][^:]+: .+/, `${e.id}: source is "<publisher>: <official document>"`);
    assert.doesNotMatch(e.source, /https?:|\.(com|org|net|io|se|dev)\b/, `${e.id}: source must not be a real domain`);
    assert.ok(['cli', 'mcp', 'api', 'web'].includes(e.kind), `${e.id} kind`);
    assert.ok(e.stages.length > 0 && e.stages.every((s) => STAGES.includes(s)), `${e.id} stages`);
    assert.ok(['low', 'medium', 'high'].includes(e.risk.level) && e.risk.note.length > 0, `${e.id} risk`);
  }
});

test('nothing is loaded by default, MCP is optional, and every entry has a CLI fallback', async () => {
  const catalog = await load();
  assert.match(catalog.note, /nothing is loaded by default/i);
  assert.match(catalog.note, /optional/i);
  assert.ok(catalog.entries.some((e) => e.kind === 'mcp'));
  for (const e of catalog.entries) assert.equal(e.loaded_by_default, false, e.id);
});

test('no entry claims an online check that was not made, and no date is invented', async () => {
  const text = await readFile(FILE, 'utf8');
  for (const e of JSON.parse(text).entries) {
    assert.equal(e.last_checked, null, e.id);
    assert.equal(e.check_status, 'UNKNOWN', e.id);
    assert.match(e.check_note, /not performed/i, e.id);
  }
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}/, 'no dates anywhere in the catalog');
});

test('the catalog carries no secret-shaped text', async () => {
  assert.deepEqual(scanText(await readFile(FILE, 'utf8'), 'catalog.json'), []);
});
