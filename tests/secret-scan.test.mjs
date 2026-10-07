import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initWorkspace } from '../tools/lib/workspace.mjs';
import { REPO, tempDir } from './helpers/fixtures.mjs';
import { SECRET_PATTERNS, scanText, selfTest, redact } from '../tools/lib/secret-scan.mjs';

test('every pattern detects its own built-in canary (the positive control)', () => {
  const result = selfTest();
  assert.equal(result.ok, true);
  assert.equal(result.patterns, SECRET_PATTERNS.length);
  assert.deepEqual(result.failed, []);
  for (const p of SECRET_PATTERNS) {
    assert.deepEqual(scanText(`\n${p.canary}\n`, 'probe').map((f) => f.pattern), [p.id], p.id);
  }
});

test('single-line assignments and YAML scalars exclude benign nested mappings and auth modes', () => {
  const benign = [
    'token:\n  enabled: true', 'password:\n  valueFrom:', 'password:\n  valueFrom: secretRef',
    'passphrase:\n  valueFrom: secretRef', 'APP_KEY:\n  valueFrom: secretRef',
    'password:\n  annotations: {}', 'password:\n  "valueFrom": secretRef',
    '"auth": "required"', '"auth": "optional"', 'sort_key = alphabetical-order',
    '"sort_key": "alphabetical-order"', 'token:\nenabled: true',
  ];
  for (const text of benign) {
    assert.deepEqual(scanText(text, 'benign.yaml'), [], text);
    assert.equal(redact(text), text, 'benign record content is retained');
  }
  for (const [id, value] of [
    ['secret-assignment', 'token=synthetic-inline-value'],
    ['passphrase-assignment', 'passphrase=synthetic-phrase-value'],
    ['named-key-secret-assignment', 'APP_KEY=synthetic-key-value'],
    ['named-key-secret-assignment', 'APP_SECRET=synthetic-secret-value'],
    ['docker-auth-field', '"auth": "dXNlcjpwYXNzd29yZA=="'],
    ['yaml-credential-next-line', 'password: | # scalar\r\n    synthetic-yaml-value'],
    ['yaml-credential-next-line', '  api_key:\n    synthetic-api-value'],
  ]) {
    assert.ok(scanText(value, 'positive.yaml').some((f) => f.pattern === id), id);
    assert.deepEqual(scanText(redact(value), 'redacted.yaml'), [], id);
  }
});

test('benign evidence still permits real CLI validate and brief, while a nearby credential is refused', async () => {
  const dir = join(await tempDir('watchover-secret-regression-'), 'workspace');
  assert.equal((await initWorkspace(dir, { project: 'secret-regression', environment: 'synthetic', provider: 'local', session: 'r2' })).ok, true);
  const path = join(dir, 'evidence', 'settings.yaml');
  await writeFile(path, 'token:\n  enabled: true\npassword:\n  valueFrom:\n    secretKeyRef: settings\n"auth": "required"\nsort_key = alphabetical-order\n');
  const run = (command) => spawnSync(process.execPath, [join(REPO, 'tools/watchover.mjs'), command, dir], { encoding: 'utf8' });
  const validate = run('validate');
  const brief = run('brief');
  assert.equal(validate.status, 0, validate.stdout + validate.stderr);
  assert.equal(brief.status, 0, brief.stdout + brief.stderr);
  assert.match(brief.stdout, /WatchOver brief/);
  const credential = 'synthetic-positive-control';
  await writeFile(path, `password:\n  ${credential}\n`);
  for (const command of ['validate', 'brief']) {
    const result = run(command);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /yaml-credential-next-line/);
    assert.ok(!(result.stdout + result.stderr).includes(credential));
  }
  console.log(JSON.stringify({ case: 'r2-benign-evidence-cli', validate_exit: validate.status, brief_exit: brief.status, credential_control_exits: [1, 1], value_echo: false }));
});

test('long whitespace and empty YAML values scan and redact within a bounded subprocess', () => {
  const script = `
    import { scanText, redact } from ${JSON.stringify(new URL('../tools/lib/secret-scan.mjs', import.meta.url).href)};
    import { performance } from 'node:perf_hooks';
    const samples = [];
    for (const n of [65536, 262144, 1048576]) {
      const input = 'password:' + ' '.repeat(n) + '\\n  ';
      const start = performance.now();
      if (scanText(input, 'blank.yaml').length || redact(input) !== input) throw Error('blank value was treated as a secret');
      samples.push({ spaces: n, scan_and_redact_ms: performance.now() - start });
    }
    const control = scanText('password:\\n  synthetic-control', 'control.yaml');
    if (!control.some((f) => f.pattern === 'yaml-credential-next-line')) throw Error('positive control missed');
    console.log(JSON.stringify({ samples, positive_control: true }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 6000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const report = JSON.parse(result.stdout);
  assert.equal(report.samples.length, 3);
  assert.equal(report.positive_control, true);
  console.log(JSON.stringify({ case: 'r2-whitespace-performance', ...report }));
});

test('the self-test fails closed when a pattern stops detecting its canary', () => {
  const broken = SECRET_PATTERNS.map((p) => (p.id === 'aws-access-key-id' ? { ...p, regex: /will-never-match-anything-\u0000/ } : p));
  const result = selfTest(broken);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ['aws-access-key-id']);
});

test('findings name the pattern, file and line but never the value', () => {
  const canary = SECRET_PATTERNS.find((p) => p.id === 'secret-assignment').canary;
  const findings = scanText(`line one\nline two ${canary}\n`, 'events.jsonl');
  assert.deepEqual(findings, [{ pattern: 'secret-assignment', file: 'events.jsonl', line: 2 }]);
  assert.ok(!JSON.stringify(findings).includes(canary.split('=')[1]));
});

test('realistic credential shapes are detected', () => {
  const samples = {
    'private-key-block': '-----BEGIN RSA PRIVATE KEY-----',
    'url-credentials': 'DATABASE_URL uses postgres://app:hunter2hunter2@db.example.com:5432/app',
    'secret-assignment': 'docker run -e DB_PASSWORD=correcthorsebattery demo-app',
  };
  for (const [id, text] of Object.entries(samples)) {
    assert.ok(scanText(text, 'f').some((f) => f.pattern === id), id);
  }
});

test('sanitized and reference-only text is not flagged', () => {
  const clean = [
    'gcloud sql users set-password app --password=[REDACTED]',
    '{"name": "DB_PASSWORD", "location": "gcp-secret-manager:projects/demo-cloud-project/secrets/demo-app-db-password"}',
    'docker run -e DB_PASSWORD=$DB_PASSWORD demo-app',
    'postgres://app:[REDACTED]@db.example.com:5432/app',
    'git clone https://git.example.com/demo/demo-app.git',
    '"secrets": [], "evidence": ["evidence/0013-instance-create.txt"]',
    'API_TOKEN=<from secret manager>',
  ];
  for (const line of clean) assert.deepEqual(scanText(line, 'f'), [], line);
});

test('redact removes every secret-shaped span and names the pattern', () => {
  for (const p of SECRET_PATTERNS) {
    const out = redact(`before\n${p.canary}\nafter`);
    assert.ok(out.includes(`[REDACTED:${p.id}]`), p.id);
    assert.deepEqual(scanText(out, 'f'), [], `${p.id} still detectable after redaction`);
  }
});

test('redact leaves text without secrets unchanged', () => {
  const text = 'fact "gcp.project" does not exist at /facts/3';
  assert.equal(redact(text), text);
});

test('finite added shapes have synthetic positives, nearby negatives and value-free diagnostics', () => {
  const cases = [
    ['passphrase-assignment', 'passphrase="synthetic-passphrase"', 'passphrase="[REDACTED]"', 'synthetic-passphrase'],
    ['named-key-secret-assignment', 'APP_SIGNING_KEY=synthetic-key-value', 'APP_SIGNING_KEY=$APP_SIGNING_KEY', 'synthetic-key-value'],
    ['named-key-secret-assignment', '"CLIENT_SECRET": "synthetic-secret-value"', '"CLIENT_SECRET": "<from store>"', 'synthetic-secret-value'],
    ['docker-auth-field', '{"auths":{"registry.example.com":{"auth":"c3ludGhldGljOmNhbmFyeQ=="}}}', '{"auths":{"registry.example.com":{"auth":"[REDACTED]"}}}', 'c3ludGhldGljOmNhbmFyeQ=='],
    ['yaml-credential-next-line', 'password:\n  synthetic-password', 'password:\n  $PASSWORD', 'synthetic-password'],
    ['yaml-credential-next-line', 'DB_PASSWORD: |\n  synthetic-block-value', 'DB_PASSWORD: |\n  [REDACTED]', 'synthetic-block-value'],
    ['yaml-credential-next-line', 'token: >-\n  synthetic-token-value', 'token: >-\n  # comment only', 'synthetic-token-value'],
  ];
  for (const [id, positive, negative, value] of cases) {
    const findings = scanText(positive, 'synthetic.txt');
    assert.ok(findings.some((f) => f.pattern === id), id);
    assert.ok(!JSON.stringify(findings).includes(value), 'diagnostic does not echo value');
    assert.ok(!redact(positive).includes(value));
    assert.deepEqual(scanText(redact(positive), 'f'), []);
    assert.deepEqual(scanText(negative, 'f'), [], id);
  }
  for (const negative of ['KEY_NAME=benign-reference', 'PASSPHRASE_HINT=benign-description', 'APP_KEY=short', 'auth: basic', 'password:\n  <from store>', 'monkey:\n  banana-banana']) {
    assert.deepEqual(scanText(negative, 'f'), [], negative);
  }
});
