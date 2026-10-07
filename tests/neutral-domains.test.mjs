// Public-content policy: generic examples and scoped schema dialect references remain
// allowed. Attribution links have exact full-URL exceptions in documentation only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO } from './helpers/fixtures.mjs';
import { PUBLIC_URLS, withoutPublicLinks } from './helpers/vocabulary.mjs';

const DOMAIN = /\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|io|dev|app|au|se|cloud|sh|ai|co|us|uk|gov|edu|internal)\b/gi;
const DIALECT_FILES = new Set(['schema/state.schema.json', 'schema/event.schema.json', 'tools/lib/schema-subset.mjs', 'tests/schema-subset.test.mjs']);
// Built from parts so this file does not contain, and so match, the name itself.
const DIALECT_DOMAIN = ['json-schema', 'org'].join('.');

test('tracked domains stay generic except scoped dialect and exact public links', async () => {
  const files = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean);
  const offending = [];
  for (const file of files) {
    const text = withoutPublicLinks(await readFile(join(REPO, file), 'utf8'), file);
    for (const domain of text.match(DOMAIN) ?? []) {
      const allowed = /(^|\.)example\.com$/i.test(domain) || (domain === DIALECT_DOMAIN && DIALECT_FILES.has(file));
      if (!allowed) offending.push(`${file}: ${domain}`);
    }
  }
  assert.deepEqual(offending, []);
});

test('public URL exceptions reject suffixes, lookalikes and use outside documentation', () => {
  for (const url of PUBLIC_URLS) {
    assert.equal(withoutPublicLinks(`[link](${url})`, 'README.md'), '[link]([approved public link])');
    for (const suffix of ['/private', '?redirect=1', '.invalid']) {
      assert.ok(withoutPublicLinks(url + suffix, 'README.md').includes(url + suffix));
    }
    assert.equal(withoutPublicLinks(url, 'tools/example.mjs'), url);
  }
  const unrelated = 'https://' + ['github', 'com'].join('.') + '/unapproved/project';
  assert.equal(withoutPublicLinks(unrelated, 'README.md'), unrelated);
});
