import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO, FIXTURES, tempDir } from './helpers/fixtures.mjs';
import { commitState, realOps } from '../tools/lib/commit.mjs';
import { validateWorkspace } from '../tools/lib/validate.mjs';

const CLI = join(REPO, 'tools', 'watchover.mjs');
const CANARY = ['AK', 'IA', 'WATCHOVERCANARY1'].join('');
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
const sha = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');

// A valid synthetic workspace whose cited evidence files really exist.
async function workspace() {
  const dir = join(await tempDir('watchover-commit-'), 'ws');
  await cp(join(FIXTURES, 'valid', 'lifecycle', '07-verified'), dir, { recursive: true });
  const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  for (const f of state.facts) {
    for (const loc of f.evidence) {
      await mkdir(dirname(join(dir, loc)), { recursive: true });
      await writeFile(join(dir, loc), `synthetic output for ${f.key}\n`);
    }
  }
  assert.equal((await validateWorkspace(dir)).ok, true);
  return { dir, state };
}

const candidate = (state, change) => {
  const next = structuredClone(state);
  change(next);
  return `${JSON.stringify(next, null, 2)}\n`;
};
const touch = (s) => { s.activity.summary = 'Checked the service again; nothing changed'; };

async function refusedUnchanged(dir, text, expect) {
  const before = await sha(join(dir, 'state.json'));
  const result = await commitState(dir, text);
  assert.equal(result.committed, false);
  assert.equal(await sha(join(dir, 'state.json')), before, 'state.json bytes must not change');
  assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith('.tmp')), [], 'no temporary file is left');
  expect(result.errors);
  return result;
}

test('a valid candidate is committed and the workspace still validates', async () => {
  const { dir, state } = await workspace();
  const text = candidate(state, touch);
  const result = await commitState(dir, text);
  assert.equal(result.committed, true);
  assert.equal(result.post.ok, true);
  assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), text);
  assert.equal((await validateWorkspace(dir)).ok, true);
  assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith('.tmp')), []);
});

test('an object fact value is refused with its pointer, actual type and allowed types', async () => {
  const { dir, state } = await workspace();
  await refusedUnchanged(dir, candidate(state, (s) => { s.facts[0].value = { nested: true }; }), (errors) => {
    const e = errors.find((x) => x.pointer === '/facts/0/value' && x.keyword === 'type');
    assert.ok(e, JSON.stringify(errors));
    assert.match(e.message, /expected string or number or boolean or null, got object/);
  });
});

test('a 301-character fact value is refused with the real 300 limit and the actual length', async () => {
  const { dir, state } = await workspace();
  await refusedUnchanged(dir, candidate(state, (s) => { s.facts[0].value = 'x'.repeat(301); }), (errors) => {
    const e = errors.find((x) => x.pointer === '/facts/0/value' && x.keyword === 'maxLength');
    assert.ok(e, JSON.stringify(errors));
    assert.match(e.message, /at most 300 characters \(got 301\)/);
  });
});

test('an invalid secrets availability is refused with the allowed values and no secret echo', async () => {
  const { dir, state } = await workspace();
  await refusedUnchanged(dir, candidate(state, (s) => {
    s.secrets.push({ name: 'APP_SESSION_KEY', location: 'the platform secret store', last_verified_at: null, availability: 'sometimes' });
  }), (errors) => {
    const e = errors.find((x) => x.pointer === `/secrets/${state.secrets.length}/availability`);
    assert.ok(e, JSON.stringify(errors));
    assert.match(e.message, /must be one of "usable", "blocked", "missing"/);
    assert.doesNotMatch(JSON.stringify(errors), /sometimes/);
  });
});

test('a schema-valid but semantically inconsistent candidate is refused', async () => {
  const { dir, state } = await workspace();
  await refusedUnchanged(dir, candidate(state, (s) => {
    s.pending_decision = {
      id: 'dec-unrequested', categories: ['billable'], action: 'Create a small server', targets: ['app-server'],
      why: 'The plan needs it', cost_or_blast_radius: 'About 1 unit per day', reversibility: 'Deletable',
      rollback: 'Delete it', success_check: 'It answers', reply_options: [{ reply: 'approve', meaning: 'go ahead' }],
      requested_at: s.identity.updated_at,
    };
  }), (errors) => assert.ok(errors.some((e) => e.check === 'pending-decision-has-request'), JSON.stringify(errors)));
});

test('cited evidence must exist as a regular file reached without a link (positive control first)', async () => {
  const { dir, state } = await workspace();
  const i = state.facts.findIndex((f) => f.evidence.length > 0);
  const loc = state.facts[i].evidence[0];
  const text = candidate(state, touch);
  // Positive control: the same candidate with the file present is accepted by the check.
  const { validateCandidate } = await import('../tools/lib/validate.mjs');
  assert.equal((await validateCandidate(dir, text)).ok, true);

  const { rm, rename } = await import('node:fs/promises');
  await rename(join(dir, loc), join(dir, `${loc}.moved`));
  await refusedUnchanged(dir, text, (errors) => {
    const e = errors.find((x) => x.check === 'evidence-exists');
    assert.equal(e.pointer, `/facts/${i}/evidence/0`);
    assert.match(e.message, /does not exist/);
  });

  await symlink(join(dir, `${loc}.moved`), join(dir, loc));
  await refusedUnchanged(dir, text, (errors) => assert.match(errors.find((x) => x.check === 'evidence-exists').message, /symbolic link/));

  await rm(join(dir, loc));
  await mkdir(join(dir, loc));
  await refusedUnchanged(dir, text, (errors) => assert.match(errors.find((x) => x.check === 'evidence-exists').message, /not a regular file/));
});

test('evidence containing a synthetic secret blocks the commit and the value is never echoed', async () => {
  const { dir, state } = await workspace();
  await writeFile(join(dir, 'evidence', 'zz-extra.txt'), `token=${CANARY}\n`);
  await refusedUnchanged(dir, candidate(state, touch), (errors) => {
    assert.ok(errors.some((e) => e.check === 'secret' && e.file === 'evidence/zz-extra.txt'));
    assert.doesNotMatch(JSON.stringify(errors), new RegExp(CANARY));
  });
});

test('a failure writing the temporary file or renaming keeps the original state and leaves no temp', async () => {
  for (const failing of ['writeTempAndSync', 'rename']) {
    const { dir, state } = await workspace();
    const before = await sha(join(dir, 'state.json'));
    const ops = { ...realOps };
    if (failing === 'writeTempAndSync') {
      ops.writeTempAndSync = async (path, text, mode) => {
        await writeFile(path, text.slice(0, 10), { mode }); // a partial file, then the device fails
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      };
    } else {
      ops.rename = async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
    }
    const result = await commitState(dir, candidate(state, touch), { ops });
    assert.equal(result.committed, false, failing);
    assert.match(result.errors[0].message, /state\.json is unchanged/);
    assert.equal(await sha(join(dir, 'state.json')), before, failing);
    assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith('.tmp')), [], failing);
    assert.equal((await validateWorkspace(dir)).ok, true, failing);
  }
});

test('a state or events change at either boundary is detected just before rename; the newer record is kept', async () => {
  for (const [which, boundary] of [['state', 'beforeFinalCompare'], ['events', 'beforeFinalCompare'], ['state', 'afterSnapshot'], ['events', 'afterSnapshot']]) {
    const { dir, state } = await workspace();
    let newer;
    const hooks = {
      async [boundary]() {
        if (which === 'state') {
          newer = candidate(state, (s) => { s.activity.summary = 'Another writer updated the state'; });
          await writeFile(join(dir, 'state.json'), newer);
        } else {
          // Another writer appends a valid read-only intent.
          const { appendEvent } = await import('../tools/lib/workspace.mjs');
          const added = await appendEvent(dir, JSON.stringify({
            actor: { role: 'ai', name: 'ai-deployer' }, session_id: state.identity.session_id, type: 'intent',
            summary: 'List servers (read-only)', target: 'demo-target', action: 'list servers', action_kinds: ['read_only'],
          }));
          assert.equal(added.appended, true, JSON.stringify(added.errors));
          newer = await readFile(join(dir, 'events.jsonl'), 'utf8');
        }
      },
    };
    const result = await commitState(dir, candidate(state, touch), { hooks });
    assert.equal(result.committed, false, which);
    assert.equal(result.stage, 'stale');
    assert.match(result.errors[0].message, /changed after this command started; nothing was replaced/);
    const file = which === 'state' ? 'state.json' : 'events.jsonl';
    assert.equal(await readFile(join(dir, file), 'utf8'), newer, `${which}: newer bytes kept`);
    assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith('.tmp')), [], which);
  }
});

test('the CLI commits, refuses with exit 1 and never prints a secret', async () => {
  const { dir, state } = await workspace();
  const good = join(dir, '..', 'good.json');
  await writeFile(good, candidate(state, touch));
  let r = run(['commit-state', dir, '--file', good]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^committed state\.json; workspace valid/);

  const bad = join(dir, '..', 'bad.json');
  await writeFile(bad, candidate(state, (s) => { s.activity.summary = `copied ${CANARY} by mistake`; }));
  const before = await sha(join(dir, 'state.json'));
  r = run(['commit-state', dir, '--file', bad]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /refused: .*\n[\s\S]*state\.json is unchanged/);
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(CANARY));
  assert.equal(await sha(join(dir, 'state.json')), before);

  assert.equal(run(['commit-state', dir]).status, 64);
});

test('real commit-state CLI returns 2 after replacement when a deterministic post-check fails', async () => {
  const { dir, state } = await workspace();
  const text = candidate(state, (s) => { s.activity.summary = 'New candidate was actually replaced'; });
  const file = join(dir, '..', 'candidate-post.json');
  await writeFile(file, text);
  const before = await sha(join(dir, 'state.json'));
  // Test-only import hook injects an evidence link during directory sync, AFTER rename.
  // The real commit-state implementation and CLI still perform validation and reporting.
  const preload = join(dir, '..', 'post-check-hook.mjs');
  const commitURL = pathToFileURL(join(REPO, 'tools/lib/commit.mjs')).href;
  await writeFile(preload, `
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  if (url !== ${JSON.stringify(commitURL)}) return nextLoad(url, context);
  return { format: 'module', shortCircuit: true, source: \`
    import { commitState as actual, realOps } from ${JSON.stringify(`${commitURL}?actual`)};
    import { symlink } from 'node:fs/promises';
    import { join } from 'node:path';
    export const commitState = (dir, text) => actual(dir, text, { ops: { ...realOps,
      async syncDir(path) { await realOps.syncDir(path); await symlink('not-a-real-target', join(dir, 'evidence/post-check-link')); }
    }});
  \` };
}});
`);
  const r = spawnSync(process.execPath, ['--import', preload, CLI, 'commit-state', dir, '--file', file], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /state\.json was replaced, but the post-check found problems/);
  assert.doesNotMatch(r.stdout, /nothing was written|unchanged/);
  assert.notEqual(await sha(join(dir, 'state.json')), before);
  assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), text);
  console.log(JSON.stringify({ case: 'commit-state-post-check', injection: 'test-only evidence symlink after rename', exit: r.status, output: r.stdout.trim(), before_sha256: before, after_sha256: await sha(join(dir, 'state.json')) }));
});
