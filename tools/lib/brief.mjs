// Read-only takeover summary (WO-P03). Derived on demand from a validated state.json and
// events.jsonl; nothing is written and no second summary is stored. It points into the
// record; before acting, read the full state and evidence as the router requires.
import { ageText, factDisplay, freshnessText, humanAction } from '../../app/web-ui/freshness.mjs';
import { openIntents } from './semantic-checks.mjs';

export const MAX_LINES = 30;
const PARTY = { ai: 'the AI', human: 'the human', external: 'something external', none: 'nobody' };
// Facts that need attention come first; current verified facts last.
const ORDER = ['blocked', 'verified-expired', 'stale', 'verified-future', 'unknown', 'unrecognised', 'assumed', 'user-confirmed', 'verified-local', 'verified-remote'];
const SYMBOL = { blocked: '⊘', 'verified-expired': '◌', stale: '◐', 'verified-future': '»', unknown: '?', unrecognised: '!', assumed: '~', 'user-confirmed': '✎', 'verified-local': '✓', 'verified-remote': '✓✓' };

const clip = (v, n = 70) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const party = (p) => PARTY[p] ?? p;

export function buildBrief(state, events, now) {
  const lines = [];
  const id = state.identity;
  lines.push(`WatchOver brief — ${id.project_alias} (${clip(id.target_environment, 40)}) — at ${new Date(now).toISOString()}`);
  lines.push('Derived from a validated record. Read state.json and evidence before acting.');
  lines.push(`Stage: ${state.stage} · state updated ${ageText(id.updated_at, now)} by ${id.updated_by.role}`);
  const a = state.activity;
  lines.push(`Activity: ${clip(a.summary)} · waiting on ${party(a.waiting_on)}`);
  lines.push(`Last progress: ${a.last_progress ? `${clip(a.last_progress.summary, 60)} (${ageText(a.last_progress.at, now)})` : 'none recorded'}`);
  const p = state.pending_decision;
  lines.push(`Pending decision: ${p ? `${p.id} [${p.categories.join(', ')}] ${clip(p.action, 50)}` : 'none'}`);
  const action = humanAction(state);
  lines.push(`Human action now: ${action ? clip(action, 80) : 'nothing needs the human right now'}`);
  lines.push(`Next: ${clip(state.next.action)} · owner: ${party(state.next.decision_owner)}`);
  lines.push(`Last safe state: ${state.handoff.last_safe_state ? clip(state.handoff.last_safe_state) : 'not recorded'}`);

  const requests = new Map(events.filter((e) => e.type === 'decision_request' && e.request).map((e) => [e.request.id, e]));
  const approvals = events.filter((e) => e.type === 'decision' && e.decision?.outcome === 'approved');
  const shown = approvals.slice(-3).map((e) => {
    const request = requests.get(e.decision.request_id);
    return `${e.id} ${e.decision.request_id} [${(request?.request.categories ?? []).join(', ')}] → ${request?.id ?? 'missing request'} → ${request?.evidence?.[0] ?? 'snapshot missing'}`;
  });
  lines.push(`Recorded approvals (history, not new authority): ${shown.length ? shown.join('; ') : 'none'}${approvals.length > 3 ? `; ${approvals.length - 3} earlier` : ''}`);
  const missing = approvals.filter((e) => !requests.get(e.decision.request_id)?.evidence?.length).length;
  lines.push(`Approval scope: all decisions in events.jsonl; follow related → decision_request.evidence; ${missing} approved request(s) without snapshot locators (scope unavailable; do not invent). Read linked files to establish contents.`);
  const open = openIntents(events);
  lines.push(`Open intents: ${open.length}${open.length ? ` (${open.slice(0, 3).map((e) => e.id).join(', ')}${open.length > 3 ? `; ${open.length - 3} more` : ''})` : ''}; complete listing: events.jsonl, every type=intent id with no type=result related reference.`);
  const blocking = state.open_items.filter((o) => o.blocking);
  lines.push(`Blocking open items: ${blocking.length}${blocking.length ? ` (first: ${clip(blocking[0].text, 60)})` : ''}`);

  const facts = state.facts.map((f, i) => ({ f, i, d: factDisplay(f, now) }));
  const count = (kinds) => facts.filter((x) => kinds.includes(x.d.kind)).length;
  lines.push(`Facts: ${facts.length} total · current ${count(['verified-local', 'verified-remote'])} · expired ${count(['verified-expired'])} · stale ${count(['stale'])} · unknown ${count(['unknown', 'unrecognised'])} · blocked ${count(['blocked'])} · assumed ${count(['assumed'])} · human-confirmed ${count(['user-confirmed'])} · future-dated ${count(['verified-future'])} · problems ${facts.filter((x) => x.f.problem).length}`);

  const rank = (x) => (x.f.problem ? -1 : ORDER.indexOf(x.d.kind));
  const ordered = [...facts].sort((x, y) => rank(x) - rank(y) || x.i - y.i);
  const budget = MAX_LINES - lines.length - 1; // one line kept for the omitted count
  const listed = ordered.slice(0, Math.max(0, budget));
  for (const { f, d } of listed) {
    lines.push(`  ${SYMBOL[d.kind] ?? '!'} ${f.key}: ${clip(f.value ?? '(no value)', 40)} — ${f.status}, ${freshnessText(f, now)}${f.problem ? ', PROBLEM' : ''}`);
  }
  const omitted = facts.length - listed.length;
  lines.push(omitted ? `${omitted} more fact${omitted === 1 ? '' : 's'} not shown; see state.json /facts.` : 'All facts are listed above.');
  return lines;
}
