// Commit a candidate state.json (WO-P01). Single writer per workspace: the candidate is
// fully validated against the current events and evidence, written to a temporary file
// in the same folder and flushed, then — only if state.json and events.jsonl are still
// exactly as they were when the command started — renamed over state.json. Events are
// never rewritten and there is no cross-file transaction. A change landing between the
// final comparison and the rename itself cannot be detected without OS locking.
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { validateCandidate, validateWorkspace } from './validate.mjs';

const STATE = 'state.json';
const EVENTS = 'events.jsonl';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function snapshot(dir) {
  const [state, events] = await Promise.all([readFile(join(dir, STATE)), readFile(join(dir, EVENTS))]);
  return { state: sha256(state), events: sha256(events) };
}

// Real file-system operations; tests may substitute failing ones.
export const realOps = {
  async writeTempAndSync(path, text, mode) {
    const handle = await open(path, 'wx', mode);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename,
  unlink,
  async syncDir(dir) {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

const refused = (stage, errors) => ({ committed: false, stage, errors });

export async function commitState(dir, candidateText, { ops = realOps, hooks = {} } = {}) {
  let before;
  let mode;
  try {
    before = await snapshot(dir);
    mode = (await stat(join(dir, STATE))).mode & 0o777;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return refused('workspace', [{ check: 'commit', message: 'this folder is not a WatchOver workspace (state.json or events.jsonl is missing); run init first' }]);
    }
    throw err;
  }

  await hooks.afterSnapshot?.();
  const checked = await validateCandidate(dir, candidateText);
  if (!checked.ok) return { ...refused('validate', checked.errors), secret_scan: checked.secret_scan };

  const temp = join(dir, `.${STATE}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  const dropTemp = async () => { await ops.unlink(temp).catch(() => {}); };

  try {
    await ops.writeTempAndSync(temp, candidateText, mode);
  } catch (err) {
    await dropTemp();
    return refused('write', [{ check: 'commit', message: `could not write the temporary candidate (${err.code ?? err.name}); ${STATE} is unchanged` }]);
  }

  await hooks.beforeFinalCompare?.();
  let after;
  try {
    after = await snapshot(dir);
  } catch (err) {
    await dropTemp();
    return refused('stale', [{ check: 'commit', message: `${err.code === 'ENOENT' ? 'a record file disappeared' : 'the record could not be re-read'} while committing; nothing was replaced` }]);
  }
  if (after.state !== before.state || after.events !== before.events) {
    await dropTemp();
    const which = [after.state !== before.state ? STATE : null, after.events !== before.events ? EVENTS : null].filter(Boolean).join(' and ');
    return refused('stale', [{ check: 'commit', message: `${which} changed after this command started; nothing was replaced and the newer record is kept. Rebuild the candidate from the current state and try again` }]);
  }

  try {
    await ops.rename(temp, join(dir, STATE));
  } catch (err) {
    await dropTemp();
    return refused('rename', [{ check: 'commit', message: `could not replace ${STATE} (${err.code ?? err.name}); ${STATE} is unchanged` }]);
  }

  let dirSync = 'synced';
  try {
    await ops.syncDir(dir);
  } catch (err) {
    dirSync = `not supported here (${err.code ?? err.name})`;
  }

  // From here on state.json has been replaced; never report a later problem as "nothing written".
  const post = await validateWorkspace(dir).catch((err) => ({
    ok: false, errors: [{ check: 'post-check', message: `could not re-read the workspace (${err.code ?? err.name})` }],
  }));
  return { committed: true, dirSync, post };
}
