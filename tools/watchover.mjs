#!/usr/bin/env node
// WatchOver command line: init, append, commit-state, validate, brief and show a workspace.
// Exit codes: 0 done, 1 refused or invalid, 2 written but the workspace needs attention
// (append: usually a state.json update; commit-state: post-check failed after replacement),
// 64 usage error. Output only repeats redacted validation results.
import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { appendEvent, initWorkspace } from './lib/workspace.mjs';
import { validateWorkspace } from './lib/validate.mjs';
import { commitState } from './lib/commit.mjs';
import { buildBrief } from './lib/brief.mjs';
import { DEFAULT_PORT, startViewServer } from './lib/server.mjs';

const USAGE = `usage: node tools/watchover.mjs <init|append|commit-state|validate|brief|show> <workspace> [options]
  init <workspace> --project <alias> --environment <text> --provider <id> --session <id> [--actor <name>]
  append <workspace> [--file <event.json>]   reads one JSON event from stdin unless --file is given
  commit-state <workspace> --file <candidate.json>  validates the candidate, then safely replaces state.json
  validate <workspace> [--json]
  brief <workspace> [--now <iso-time>]          prints a read-only summary of at most 30 lines
  show <workspace> [--port <n>]              serves the read-only view on 127.0.0.1 (default port ${DEFAULT_PORT})`;

const OPTIONS = {
  init: { project: { type: 'string' }, environment: { type: 'string' }, provider: { type: 'string' }, session: { type: 'string' }, actor: { type: 'string' } },
  append: { file: { type: 'string' } },
  'commit-state': { file: { type: 'string' } },
  validate: { json: { type: 'boolean' } },
  brief: { now: { type: 'string' } },
  show: { port: { type: 'string' } },
};
const REQUIRED_INIT = ['project', 'environment', 'provider', 'session'];

function usage(problem) {
  if (problem) process.stderr.write(`${problem}\n`);
  process.stderr.write(`${USAGE}\n`);
  return 64;
}

function describe(e) {
  const where = [e.file, e.line !== undefined ? `line ${e.line}` : null, e.pointer || null].filter(Boolean).join(' ');
  const detail = e.keyword ?? e.pattern;
  return `- [${e.check}]${where ? ` ${where}` : ''}${detail ? ` (${detail})` : ''}: ${e.message}`;
}

const problems = (errors) => `${errors.length} problem${errors.length === 1 ? '' : 's'}\n${errors.map(describe).join('\n')}\n`;

function summary(result) {
  const s = result.secret_scan;
  return `secret scan self-test ${s.self_test} (${s.patterns} patterns), ${s.findings} finding${s.findings === 1 ? '' : 's'}`;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const [command, ...rest] = argv;
  if (!OPTIONS[command]) return usage(command ? `unknown command "${command}"` : null);
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: OPTIONS[command], allowPositionals: true });
  } catch (err) {
    return usage(err.message);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) return usage('give exactly one workspace folder');
  const [workspace] = positionals;

  if (command === 'init') {
    const missing = REQUIRED_INIT.filter((k) => !values[k]).map((k) => `--${k}`);
    if (missing.length) return usage(`missing ${missing.join(', ')}`);
    const result = await initWorkspace(workspace, values);
    if (!result.ok) {
      process.stdout.write(`refused: ${problems(result.errors)}`);
      return 1;
    }
    process.stdout.write(`initialized ${workspace}\n`);
    return 0;
  }

  if (command === 'show') {
    const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) return usage('--port must be a whole number from 0 to 65535');
    const info = await stat(workspace).catch(() => null);
    if (!info?.isDirectory()) {
      process.stderr.write(`no such folder: ${workspace}\n`);
      return 1;
    }
    const view = await startViewServer({ workspace, port });
    process.stdout.write(`serving ${workspace} at ${view.url} (read-only, loopback only; press Ctrl-C to stop)\n`);
    await new Promise((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
    await view.close();
    return 0;
  }

  if (command === 'commit-state') {
    if (!values.file) return usage('commit-state needs --file <candidate.json>');
    let candidate;
    try {
      candidate = await readFile(values.file, 'utf8');
    } catch (err) {
      process.stderr.write(`cannot read the candidate file (${err.code ?? err.name})\n`);
      return 1;
    }
    const result = await commitState(workspace, candidate);
    if (!result.committed) {
      const unchanged = result.stage === 'stale' ? 'nothing was replaced; the newer record is kept' : 'state.json is unchanged';
      process.stdout.write(`refused: ${problems(result.errors)}${unchanged}\n`);
      return 1;
    }
    if (result.post.ok) {
      process.stdout.write(`committed state.json; workspace valid (folder sync: ${result.dirSync})\n`);
      return 0;
    }
    process.stdout.write(`state.json was replaced, but the post-check found problems (folder sync: ${result.dirSync}): ${problems(result.post.errors)}`);
    return 2;
  }

  if (command === 'brief') {
    const now = values.now === undefined ? Date.now() : Date.parse(values.now);
    if (Number.isNaN(now)) return usage('--now must be an ISO date-time');
    const checked = await validateWorkspace(workspace);
    if (!checked.ok) {
      process.stdout.write(`refused: the record is not valid; no summary is shown\n${problems(checked.errors)}`);
      return 1;
    }
    const state = JSON.parse(await readFile(`${workspace}/state.json`, 'utf8'));
    const events = (await readFile(`${workspace}/events.jsonl`, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    process.stdout.write(`${buildBrief(state, events, now).join('\n')}\n`);
    return 0;
  }

  if (command === 'validate') {
    const result = await validateWorkspace(workspace);
    if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (result.ok) process.stdout.write(`valid: all checks passed; ${summary(result)}\n`);
    else process.stdout.write(`invalid: ${problems(result.errors)}${summary(result)}\n`);
    return result.ok ? 0 : 1;
  }

  const input = values.file ? await readFile(values.file, 'utf8') : await readStdin();
  const result = await appendEvent(workspace, input);
  if (!result.appended) {
    process.stdout.write(`refused: ${problems(result.errors)}nothing was written\n`);
    return 1;
  }
  if (result.workspace.ok) {
    process.stdout.write(`appended ${result.id}; workspace valid\n`);
    return 0;
  }
  process.stdout.write(`appended ${result.id}; the workspace now needs attention (usually a state.json update): ${problems(result.workspace.errors)}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    process.stderr.write(`unexpected error (${err.code ?? err.name}); nothing more is reported to avoid repeating file contents\n`);
    process.exitCode = 1;
  },
);
