// Test-only helpers for reading fixture workspaces and making mutated copies.
import { readdir, readFile, mkdtemp, writeFile, cp } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const FIXTURES = join(REPO, 'fixtures');
export const SCHEMA_DIR = join(REPO, 'schema');

export async function subdirs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

export async function readWorkspace(dir) {
  const stateText = await readFile(join(dir, 'state.json'), 'utf8');
  const eventsText = await readFile(join(dir, 'events.jsonl'), 'utf8');
  return {
    stateText,
    eventsText,
    state: JSON.parse(stateText),
    events: eventsText.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)),
  };
}

export async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

const created = [];
process.on('exit', () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

export async function tempDir(prefix = 'watchover-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

// Copy a fixture workspace into a temp dir, then let the test mutate state and events.
export async function mutatedWorkspace(fixtureDir, mutate) {
  const dir = await tempDir();
  await cp(fixtureDir, dir, { recursive: true });
  const ws = await readWorkspace(dir);
  const result = mutate(ws) ?? ws;
  await writeFile(join(dir, 'state.json'), `${JSON.stringify(result.state, null, 2)}\n`);
  await writeFile(join(dir, 'events.jsonl'), result.events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  return dir;
}
