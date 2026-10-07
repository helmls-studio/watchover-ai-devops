import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scanForTerms } from '../tools/lib/neutrality.mjs';
import { REPO, tempDir } from './helpers/fixtures.mjs';

// A made-up term that stands in for a protected one; real terms never enter the repo.
const TERM = 'quartzmoth-417';
const CLI = join(REPO, 'tools', 'neutrality-scan.mjs');

async function denylist(...terms) {
  const dir = await tempDir('watchover-deny-');
  const file = join(dir, 'denylist.txt');
  await writeFile(file, `# protected terms, one per line\n\n${terms.join('\n')}\n`);
  return file;
}

async function tree(files) {
  const root = await tempDir('watchover-tree-');
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(root, rel, '..'), { recursive: true });
    await writeFile(join(root, rel), text);
  }
  return root;
}

test('a clean tree passes, and the planted control term is detected in the same pass', async () => {
  const root = await tree({ 'a.md': 'nothing here\n', 'sub/b.txt': 'demo-app\n' });
  const result = await scanForTerms({ root, denylistPath: await denylist(TERM) });
  assert.equal(result.verdict, 'clean');
  assert.equal(result.control, 'detected');
  assert.deepEqual(result.hits, []);
});

test('a hit is reported by location and term number, never by the term itself', async () => {
  const root = await tree({ 'a.md': 'ok\n', 'sub/b.txt': `line one\nthis mentions ${TERM.toUpperCase()} here\n` });
  const result = await scanForTerms({ root, denylistPath: await denylist('unused-term', TERM) });
  assert.equal(result.verdict, 'hits');
  assert.deepEqual(result.hits, [{ file: 'sub/b.txt', line: 2, term: 2 }]);
  assert.ok(!JSON.stringify(result).toLowerCase().includes(TERM));
});

test('.git and node_modules are skipped', async () => {
  const root = await tree({ '.git/config': TERM, 'node_modules/x/index.js': TERM, 'ok.md': 'fine\n' });
  assert.equal((await scanForTerms({ root, denylistPath: await denylist(TERM) })).verdict, 'clean');
});

test('an empty denylist cannot prove anything and is refused', async () => {
  const root = await tree({ 'a.md': 'x\n' });
  await assert.rejects(scanForTerms({ root, denylistPath: await denylist() }), /no terms/);
});

test('the command prints only the verdict and locations, with exit codes 0, 1 and 2', async () => {
  const clean = spawnSync(process.execPath, [CLI, await denylist(TERM), '--root', await tree({ 'a.md': 'x\n' })], { encoding: 'utf8' });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /verdict: clean; control term detected; 0 hits/);
  const dirty = spawnSync(process.execPath, [CLI, await denylist(TERM), '--root', await tree({ 'a.md': `x ${TERM}\n` })], { encoding: 'utf8' });
  assert.equal(dirty.status, 1);
  assert.match(dirty.stdout, /a\.md:1 \(term 1\)/);
  assert.ok(!(dirty.stdout + dirty.stderr).includes(TERM));
  assert.equal(spawnSync(process.execPath, [CLI], { encoding: 'utf8' }).status, 2);
});

test('the repository itself scans clean for a term it cannot contain', async () => {
  const result = await scanForTerms({ root: REPO, denylistPath: await denylist(TERM.split('').reverse().join('')) });
  assert.equal(result.verdict, 'clean');
  assert.equal(result.control, 'detected');
  assert.ok(result.filesScanned > 50);
});

test('a denylist kept inside the scanned folder is refused', async () => {
  const root = await tree({ 'a.md': 'x\n', 'deny.txt': `${TERM}\n` });
  await assert.rejects(scanForTerms({ root, denylistPath: join(root, 'deny.txt') }), /outside/);
});
