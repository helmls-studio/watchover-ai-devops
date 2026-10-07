// Initialize (Annex I.1) and Append (Annex I.3). Both validate what they are about to
// write before touching the disk, and both re-validate the workspace afterwards (I.2).
// Append only ever adds one line to events.jsonl; it never rewrites earlier bytes.
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEventsText, validateTexts, validateWorkspace } from './validate.mjs';

export const ROUTER_SKILL = fileURLToPath(new URL('../../skills/router.md', import.meta.url));
export const POINTER_FILE = 'README.md';
const REQUIRED = [['project', '--project'], ['environment', '--environment'], ['provider', '--provider'], ['session', '--session']];

const pointerText = () => `# WatchOver record

This folder is the WatchOver record for a deployment: a shared, freshness-honest account
of what is being built, where it stands and what happens next.

If you are an AI continuing this work, read these first, in order:

1. ${ROUTER_SKILL} — how to read and update these records
2. state.json — the current state; the only source of truth
3. events.jsonl — the append-only history; read recent events only, as needed

evidence/ holds sanitized command output that facts and events point to. Open it only
when a locator sends you there.

Nothing here is loaded automatically, and nothing here is a live cloud reading.
Secret values never belong in any of these files.
`;

function initialRecords({ project, environment, provider, session, actor }) {
  const at = new Date().toISOString();
  const who = { role: 'ai', name: actor ?? 'ai-deployer' };
  const first = {
    schema_version: '0.1', id: 'evt-0001', at, actor: who, session_id: session,
    type: 'stage_change', summary: 'Workspace initialized; starting read-only recon', stage: { from: null, to: 'recon' },
  };
  const state = {
    schema_version: '0.1',
    identity: { project_alias: project, target_environment: environment, provider_profile: provider, mode: 'basic', updated_at: at, updated_by: who, session_id: session },
    stage: 'recon',
    activity: { summary: 'Workspace initialized; recon has not started yet', started_at: at, expected_duration: null, slow_reason: null, waiting_on: 'ai', last_progress: null },
    brief: { app_summary: null, components: [], topology: null, resource_rationale: null, heavier_alternatives: [], assumptions: [] },
    plan: { tiers: [], default_tier: null, selected_tier: null },
    pending_decision: null,
    resources: [],
    sources: [],
    facts: [],
    secrets: [],
    open_items: [],
    next: { action: 'Start read-only recon: the app, its source, the target account and the names of the secrets it needs', decision_owner: 'ai' },
    handoff: { read_first: [ROUTER_SKILL, 'state.json', 'events.jsonl (recent events only)'], last_safe_state: null, rollback_anchor: null, known_unverified: [], fragile: [] },
  };
  return { stateText: `${JSON.stringify(state, null, 2)}\n`, eventsText: `${JSON.stringify(first)}\n` };
}

async function hasContent(dir) {
  try {
    return (await readdir(dir)).length > 0;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    return true; // not a readable folder: treat as occupied and refuse
  }
}

export async function initWorkspace(dir, options = {}) {
  const missing = REQUIRED.filter(([key]) => !options[key]).map(([, flag]) => flag);
  if (missing.length) return { ok: false, errors: [{ check: 'init', message: `missing ${missing.join(', ')}` }] };

  const { stateText, eventsText } = initialRecords(options);
  const planned = await validateTexts(stateText, eventsText);
  if (!planned.ok) return { ok: false, errors: planned.errors };
  if (await hasContent(dir)) {
    return { ok: false, errors: [{ check: 'init', message: 'the folder already has content; init only creates a new workspace' }] };
  }

  await mkdir(join(dir, 'evidence'), { recursive: true });
  // Keep this new record out of normal staging by a containing business repository.
  // This guard does not affect already tracked paths or prevent forced add.
  await writeFile(join(dir, '.gitignore'), '*\n', { flag: 'wx' });
  await writeFile(join(dir, 'state.json'), stateText, { flag: 'wx' });
  await writeFile(join(dir, 'events.jsonl'), eventsText, { flag: 'wx' });
  await writeFile(join(dir, POINTER_FILE), pointerText(), { flag: 'wx' });
  const written = await validateWorkspace(dir);
  return { ok: written.ok, errors: written.errors };
}

export async function appendEvent(dir, input) {
  const refuse = (message) => ({ appended: false, errors: [{ check: 'append', message }] });
  const eventsPath = join(dir, 'events.jsonl');

  let existing;
  try {
    existing = await readFile(eventsPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return refuse('this folder is not a WatchOver workspace (no events.jsonl); run init first');
    throw err;
  }
  if (!existing.endsWith('\n')) return refuse('events.jsonl does not end with a complete line, so nothing is appended to it');

  let event;
  try {
    event = JSON.parse(input);
  } catch {
    return refuse('input must be exactly one JSON object');
  }
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return refuse('input must be exactly one JSON object');

  let lastSeq = 0;
  let lastAt = 0;
  try {
    const last = JSON.parse(existing.trimEnd().split('\n').at(-1));
    lastSeq = Number(last.id.slice(4));
    lastAt = Date.parse(last.at) || 0;
  } catch {
    // A damaged last line is reported by validation below.
  }
  const filled = {
    schema_version: event.schema_version ?? '0.1',
    id: event.id ?? `evt-${String(lastSeq + 1).padStart(4, '0')}`,
    // A filled-in time never runs earlier than the last event, even if that event's
    // explicit time came from a clock slightly ahead of this one.
    at: event.at ?? new Date(Math.max(Date.now(), lastAt)).toISOString(),
    ...event,
  };
  const line = `${JSON.stringify(filled)}\n`;

  const planned = await validateEventsText(existing + line);
  if (!planned.ok) return { appended: false, errors: planned.errors };

  await appendFile(eventsPath, line);
  const workspace = await validateWorkspace(dir);
  return { appended: true, id: filled.id, errors: [], workspace };
}
