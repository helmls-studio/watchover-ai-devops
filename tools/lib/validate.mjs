// Validate capability (Annex I.2): schemas, named checks and the secret-pattern check
// with its canary self-test, all in one pass. Fails closed at every step. Every
// readable product file — state, events and each regular evidence file — is scanned,
// and every string in the output is redacted, so a secret cannot leak through it.
import { lstat, open, readdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SchemaError, compileSchema } from './schema-subset.mjs';
import { redact, scanText, selfTest } from './secret-scan.mjs';
import { runEventChecks, runSemanticChecks } from './semantic-checks.mjs';

export const DEFAULT_SCHEMA_DIR = fileURLToPath(new URL('../../schema/', import.meta.url));
export const LIMITS = Object.freeze({
  stateBytes: 2 * 1024 * 1024,
  eventLineBytes: 16 * 1024,
  evidenceFileBytes: 16 * 1024 * 1024,
});
const STATE = 'state.json';
const EVENTS = 'events.jsonl';
const EVIDENCE = 'evidence';

async function loadSchemas(schemaDir) {
  const validators = {};
  const errors = [];
  for (const [name, file] of [['state', 'state.schema.json'], ['event', 'event.schema.json']]) {
    try {
      validators[name] = compileSchema(JSON.parse(await readFile(join(schemaDir, file), 'utf8')));
    } catch (err) {
      if (err instanceof SchemaError) {
        errors.push({ check: 'schema-load', file, keyword: err.keyword, pointer: err.pointer, message: err.message });
      } else {
        errors.push({ check: 'schema-load', file, message: err.code === 'ENOENT' ? 'schema file is missing' : 'schema file is not valid JSON' });
      }
    }
  }
  return { validators, errors };
}

// JSON.parse messages can quote the input, so report only where the problem is.
function jsonProblem(err) {
  const at = /position (\d+)/.exec(String(err.message));
  return at ? `is not valid JSON (problem near character ${at[1]})` : 'is not valid JSON';
}

// Canary self-test plus a secret scan of every text that could be read.
function scanForSecrets(texts) {
  const errors = [];
  const scanner = selfTest();
  if (!scanner.ok) {
    errors.push({ check: 'scanner-self-test', message: `secret patterns failed to detect their canary: ${scanner.failed.join(', ')}` });
  }
  const findings = Object.entries(texts).flatMap(([file, text]) => scanText(text, file));
  for (const f of findings) {
    errors.push({ check: 'secret', file: f.file, line: f.line, pattern: f.pattern, message: `possible secret (${f.pattern}); the value is not shown` });
  }
  const summary = { self_test: scanner.ok ? 'passed' : 'failed', patterns: scanner.patterns, findings: findings.length };
  return { errors, summary };
}

// Pointers are redacted per segment, unescaped first, so escaping cannot hide a match.
const unescape = (s) => s.replace(/~1/g, '/').replace(/~0/g, '~');
const escape = (s) => s.replace(/~/g, '~0').replace(/\//g, '~1');
const redactPointer = (pointer) => pointer.split('/').map((seg) => escape(redact(unescape(seg)))).join('/');

function redactError(error) {
  return Object.fromEntries(Object.entries(error).map(([key, value]) => {
    if (typeof value !== 'string') return [key, value];
    return [key, key === 'pointer' ? redactPointer(value) : redact(value)];
  }));
}

function finish(errors, summary) {
  const redacted = errors.map(redactError);
  return { ok: redacted.length === 0, errors: redacted, secret_scan: summary };
}

async function checkContent({ stateText, eventsText, extraTexts = {}, preErrors = [] }, schemaDir) {
  const present = {};
  if (stateText !== undefined) present[STATE] = stateText;
  if (eventsText !== undefined) present[EVENTS] = eventsText;
  const scan = scanForSecrets({ ...present, ...extraTexts });
  const errors = [...preErrors, ...scan.errors];
  if (stateText === undefined || eventsText === undefined) return finish(errors, scan.summary);

  const stateBytes = Buffer.byteLength(stateText);
  if (stateBytes > LIMITS.stateBytes) {
    errors.push({ check: 'size', file: STATE, message: `state.json is ${stateBytes} bytes; the limit is ${LIMITS.stateBytes}` });
  }

  const { validators, errors: loadErrors } = await loadSchemas(schemaDir);
  errors.push(...loadErrors);

  let state;
  let shapeOk = true;
  try {
    state = JSON.parse(stateText);
  } catch (err) {
    shapeOk = false;
    errors.push({ check: 'json', file: STATE, message: `state.json ${jsonProblem(err)}` });
  }

  const parsed = parseEvents(eventsText, errors);

  if (shapeOk && parsed.ok && loadErrors.length === 0) {
    for (const e of validators.state(state)) errors.push({ check: 'schema', file: STATE, ...e });
    schemaCheckEvents(validators, parsed.events, errors);
    if (!errors.some((e) => e.check === 'schema')) errors.push(...runSemanticChecks(state, parsed.events));
  }

  return finish(errors, scan.summary);
}

function parseEvents(eventsText, errors) {
  const lines = eventsText.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const events = [];
  let ok = true;
  lines.forEach((line, i) => {
    const bytes = Buffer.byteLength(line);
    if (bytes > LIMITS.eventLineBytes) {
      errors.push({ check: 'size', file: EVENTS, line: i + 1, message: `line is ${bytes} bytes; the limit is ${LIMITS.eventLineBytes}` });
    }
    try {
      if (line.trim() === '') throw new Error('blank line');
      events.push(JSON.parse(line));
    } catch (err) {
      ok = false;
      errors.push({ check: 'json', file: EVENTS, line: i + 1, message: line.trim() === '' ? 'blank line' : `line ${jsonProblem(err)}` });
    }
  });
  return { events, ok };
}

function schemaCheckEvents(validators, events, errors) {
  events.forEach((ev, i) => {
    for (const e of validators.event(ev)) errors.push({ check: 'schema', file: EVENTS, line: i + 1, ...e });
  });
}

// The event log on its own: secret scan, size, JSON, schema and the event-only named
// checks. Append runs this on the log as it would be, before writing anything.
export async function validateEventsText(eventsText, { schemaDir = DEFAULT_SCHEMA_DIR } = {}) {
  const scan = scanForSecrets({ [EVENTS]: eventsText });
  const errors = [...scan.errors];
  const { validators, errors: loadErrors } = await loadSchemas(schemaDir);
  errors.push(...loadErrors);
  const parsed = parseEvents(eventsText, errors);
  if (parsed.ok && loadErrors.length === 0) {
    schemaCheckEvents(validators, parsed.events, errors);
    if (!errors.some((e) => e.check === 'schema')) errors.push(...runEventChecks(parsed.events));
  }
  return finish(errors, scan.summary);
}

// Read every regular file under evidence/ without following symbolic links. Links and
// special files are reported, never read, so nothing outside the workspace is touched
// and no unscanned file passes silently.
async function readEvidence(dir) {
  const texts = {};
  const errors = [];
  const report = (file, message) => errors.push({ check: 'evidence', file, message });
  const link = 'is a symbolic link; links are not followed, so its target was not scanned';

  let root;
  try {
    root = await lstat(join(dir, EVIDENCE));
  } catch (err) {
    if (err.code === 'ENOENT') return { texts, errors };
    throw err;
  }
  if (root.isSymbolicLink()) report(EVIDENCE, link);
  else if (!root.isDirectory()) report(EVIDENCE, 'must be a folder');
  else await walk(join(dir, EVIDENCE), EVIDENCE);
  return { texts, errors };

  async function walk(abs, rel) {
    const entries = (await readdir(abs, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const childAbs = join(abs, entry.name);
      const childRel = `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) report(childRel, link);
      else if (entry.isDirectory()) await walk(childAbs, childRel);
      else if (!entry.isFile()) report(childRel, 'is not a regular file and was not scanned');
      else await readRegular(childAbs, childRel);
    }
  }

  async function readRegular(abs, rel) {
    let handle;
    try {
      handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (err) {
      if (err.code === 'ELOOP') return report(rel, link);
      throw err;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) return report(rel, 'is not a regular file and was not scanned');
      if (info.size > LIMITS.evidenceFileBytes) return report(rel, `is ${info.size} bytes, over the ${LIMITS.evidenceFileBytes} byte scan limit, and was not scanned`);
      texts[rel] = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  }
}

// Every evidence locator a candidate's facts cite must name a regular file inside this
// workspace's evidence/ folder, reached without a symbolic link. Used only by
// commit-state, so the existing validate/append behaviour is unchanged.
async function checkCitedEvidence(dir, stateText) {
  let state;
  try {
    state = JSON.parse(stateText);
  } catch {
    return []; // reported as a JSON problem by the full check
  }
  const errors = [];
  if (!Array.isArray(state?.facts)) return errors;
  const report = (pointer, message) => errors.push({ check: 'evidence-exists', file: STATE, pointer, message });
  for (const [i, fact] of state.facts.entries()) {
    if (!Array.isArray(fact?.evidence)) continue;
    for (const [j, locator] of fact.evidence.entries()) {
      if (typeof locator !== 'string' || !locator.startsWith(`${EVIDENCE}/`)) continue; // schema reports it
      const problem = await citedFileProblem(dir, locator);
      if (problem) report(`/facts/${i}/evidence/${j}`, `cited evidence ${problem}`);
    }
  }
  return errors;
}

async function citedFileProblem(dir, locator) {
  const parts = locator.split('/').filter(Boolean);
  if (parts.some((p) => p === '.' || p === '..')) return 'is not a plain path inside evidence/';
  let abs = dir;
  for (const [k, part] of parts.entries()) {
    abs = join(abs, part);
    let info;
    try {
      info = await lstat(abs);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return 'does not exist in the workspace';
      throw err;
    }
    if (info.isSymbolicLink()) return 'goes through a symbolic link, which is not followed';
    const last = k === parts.length - 1;
    if (!last && !info.isDirectory()) return 'does not exist in the workspace';
    if (last && !info.isFile()) return 'is not a regular file';
  }
  return null;
}

// A candidate state checked against this workspace's current events and evidence: every
// existing check plus cited-evidence existence. Nothing is written.
export async function validateCandidate(dir, candidateText, { schemaDir = DEFAULT_SCHEMA_DIR } = {}) {
  let eventsText;
  const preErrors = [];
  try {
    eventsText = await readFile(join(dir, EVENTS), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    preErrors.push({ check: 'workspace', file: EVENTS, message: `${EVENTS} is missing` });
  }
  const evidence = await readEvidence(dir);
  const cited = await checkCitedEvidence(dir, candidateText);
  return checkContent({
    stateText: candidateText,
    eventsText,
    extraTexts: evidence.texts,
    preErrors: [...preErrors, ...evidence.errors, ...cited],
  }, schemaDir);
}

export async function validateTexts(stateText, eventsText, { schemaDir = DEFAULT_SCHEMA_DIR } = {}) {
  return checkContent({ stateText, eventsText }, schemaDir);
}

export async function validateWorkspace(dir, { schemaDir = DEFAULT_SCHEMA_DIR } = {}) {
  const texts = {};
  const missing = [];
  for (const file of [STATE, EVENTS]) {
    try {
      texts[file] = await readFile(join(dir, file), 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      missing.push({ check: 'workspace', file, message: `${file} is missing` });
    }
  }
  const evidence = await readEvidence(dir);
  return checkContent({
    stateText: texts[STATE],
    eventsText: texts[EVENTS],
    extraTexts: evidence.texts,
    preErrors: [...missing, ...evidence.errors],
  }, schemaDir);
}
