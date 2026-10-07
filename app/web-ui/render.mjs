// Pure rendering: state + events + clock → HTML for the six questions (Annex H).
// Every recorded value is escaped. The view asserts nothing of its own: it shows what
// was recorded, computes freshness from the clock, and never upgrades a status.
import { ageText, expiresAt, factDisplay, freshnessText, humanAction, stateRecency } from './freshness.mjs';

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const clock = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;
const stamp = (ms) => `${new Date(ms).toISOString().slice(0, 10)} ${clock(ms)}`;
const when = (iso, now) => (iso ? `${ageText(iso, now)} (${stamp(Date.parse(iso))})` : 'never');

const STAGES = {
  recon: 'Recon / preflight (read-only)', plan: 'Planning', awaiting_decision: 'Waiting for your decision',
  executing: 'Provisioning / executing', verifying: 'Verifying', handoff: 'Handed off / running',
  incident: 'Incident', recovered: 'Recovered', teardown: 'Tearing down', closed: 'Closed',
};
const PARTY = { ai: 'the AI', human: 'you (the human)', external: 'something external', none: 'nothing' };
const GATES = {
  plan_acceptance: 'Plan acceptance', billable: 'Billable', dns: 'DNS change', delete: 'Deletion',
  destructive: 'Destructive', external_release: 'External release',
};
const ORIGIN = { created_this_run: 'created in this run', created_implicitly: 'created implicitly by the provider', pre_existing: 'already existed' };
const EVENT_TYPES = {
  stage_change: 'Stage change', intent: 'Intent', result: 'Result', decision_request: 'Decision requested',
  decision: 'Decision', fact_verified: 'Fact verified', plan_failure: 'Plan changed after a failure',
};
const TRUST_ORDER = ['verified-local', 'verified-remote', 'user-confirmed', 'assumed', 'verified-expired', 'verified-future', 'stale', 'unknown', 'blocked', 'unrecognised'];

const stageLabel = (s) => STAGES[s] ?? `Unrecognised stage (${s})`;
const party = (p) => PARTY[p] ?? p;
const orNone = (v, none) => (v === null || v === undefined || v === '' ? `<span class="none">${esc(none)}</span>` : esc(v));
const list = (items, none, item = esc) => (items.length ? `<ul>${items.map((x) => `<li>${item(x)}</li>`).join('')}</ul>` : `<p class="none">${esc(none)}</p>`);
const dl = (rows) => `<dl>${rows.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
const section = (id, n, question, body, extra = '') => `<section id="${id}" class="question${extra}"><h2><span class="n">${n}</span> ${esc(question)}</h2>${body}</section>`;

function badge(fact, now) {
  const d = factDisplay(fact, now);
  return `<span class="badge" data-kind="${d.kind}"><span class="sym" aria-hidden="true">${esc(d.symbol)}</span> ${esc(d.label)}</span>`;
}

const problemFlag = (f) => f.problem ? '<span class="flag problem-indicator">Problem found</span> ' : '';

function checkShape(state, events) {
  const missing = [];
  const need = (ok, name) => { if (!ok) missing.push(name); };
  const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  need(obj(state), 'the state object');
  if (missing.length === 0) {
    need(obj(state.identity), 'identity');
    need(typeof state.stage === 'string', 'stage');
    need(obj(state.activity), 'activity');
    need(obj(state.brief) && Array.isArray(state.brief.components), 'brief');
    need(obj(state.plan) && Array.isArray(state.plan.tiers), 'plan');
    for (const k of ['resources', 'sources', 'facts', 'secrets', 'open_items']) need(Array.isArray(state[k]), k);
    need(obj(state.next), 'next');
    need(obj(state.handoff) && Array.isArray(state.handoff.read_first), 'handoff');
  }
  need(Array.isArray(events), 'events');
  if (missing.length) throw new Error(`state.json does not have the expected shape (missing ${missing.join(', ')})`);
}

function strip(state, now) {
  const id = state.identity;
  const recency = stateRecency(state, now);
  const top = `<div class="strip">
    <div><span class="k">Project</span> ${esc(id.project_alias)} · ${esc(id.target_environment)} · ${esc(id.provider_profile)}</div>
    <div><span class="k">Stage</span> ${esc(stageLabel(state.stage))}</div>
    <div id="state-age"><span class="k">Record</span> State updated ${esc(recency.ageText)} (${esc(stamp(Date.parse(id.updated_at)))}) by ${esc(id.updated_by?.name)}</div>
  </div>`;
  let banner = '';
  if (recency.clockProblem) {
    banner = `<div id="clock-problem" class="banner warn" role="status"><strong>Clock problem.</strong> This record says it was last updated in the future (${esc(stamp(Date.parse(id.updated_at)))}), so the clocks disagree. Nothing on this page shows current progress.</div>`;
  } else if (!recency.recent) {
    banner = `<div id="no-recent-update" class="banner warn" role="status"><strong>No recent update.</strong> The AI last updated this record ${esc(recency.ageText)}. Nothing on this page shows current progress.</div>`;
  }
  return top + banner;
}

function factRef(state, key, now) {
  const fact = key ? state.facts.find((f) => f.key === key) : null;
  if (!fact) return '<span class="badge" data-kind="unverified"><span class="sym" aria-hidden="true">–</span> Not verified</span>';
  return `<span${fact.problem ? ' class="fact-problem"' : ''}>${problemFlag(fact)}<span class="val">Value: ${orNone(fact.value, 'no value')}</span> · Verification: ${badge(fact, now)}</span>`;
}

function whatSection(state, now) {
  const b = state.brief;
  const id = state.identity;
  const sources = state.sources.map((s) => dl([
    ['Repository', `${esc(s.name)} <code>${esc(s.remote)}</code>`],
    ['Intended version', esc(s.pinned_ref)],
    ['Uncommitted local changes', `${factRef(state, s.local_changes_fact, now)}${s.local_changes_summary ? ` — ${esc(s.local_changes_summary)}` : ''}`],
    ['Running version', factRef(state, s.deployed_ref_fact, now)],
  ])).join('');
  return section('q-what', 1, 'What are we doing?', `
    <p class="lead">${orNone(b.app_summary, 'The app has not been described yet.')}</p>
    ${dl([
      ['Target', `${esc(id.provider_profile)} · ${esc(id.target_environment)} · project alias ${esc(id.project_alias)}`],
      [`Components (${b.components.length})`, list(b.components, 'None recorded yet.', (c) => `<strong>${esc(c.name)}</strong> — ${esc(c.role)}`)],
      ['Deployment shape', orNone(b.topology, 'Not planned yet.')],
    ])}
    ${sources ? `<h3>Source</h3>${sources}` : ''}`);
}

function whereSection(state, events, now) {
  const a = state.activity;
  const d = a.expected_duration;
  const range = d ? `${d.min_minutes}–${d.max_minutes} min` : null;
  const overdue = d && a.started_at && now > Date.parse(a.started_at) + d.max_minutes * 60000;
  const recent = events.slice(-8).reverse().map((e) => `<li><span class="t">${esc(clock(Date.parse(e.at)))}</span> <span class="who">${esc(e.actor?.role)}</span> <span class="type">${esc(EVENT_TYPES[e.type] ?? e.type)}</span> ${esc(e.summary)}${eventDetail(e)}</li>`).join('');
  return section('q-where', 2, 'Where are we now?', `
    ${dl([
      ['Stage', `<strong>${esc(stageLabel(state.stage))}</strong>`],
      ['Now', esc(a.summary)],
      ['Started', a.started_at ? esc(when(a.started_at, now)) : '<span class="none">No start time recorded.</span>'],
      range && ['Expected to take', `${esc(range)}${overdue ? ` <span class="flag">Running longer than the expected ${esc(range)}.</span>` : ''}`],
      a.slow_reason && ['May be slow because', esc(a.slow_reason)],
      ['Waiting on', esc(party(a.waiting_on))],
      ['Last meaningful progress', a.last_progress ? `${esc(a.last_progress.summary)} <span class="age">(${esc(ageText(a.last_progress.at, now))})</span>` : '<span class="none">None recorded.</span>'],
    ])}
    <h3>Recent events <span class="sub">newest first</span></h3>
    ${recent ? `<ol class="events">${recent}</ol>` : '<p class="none">No events.</p>'}`);
}

function eventDetail(e) {
  if (e.type === 'stage_change' && e.stage) {
    const from = e.stage.from === null ? 'Start' : stageLabel(e.stage.from);
    return ` <span class="detail">(${esc(from)} → ${esc(stageLabel(e.stage.to))})</span>`;
  }
  if (e.type === 'result' && e.outcome) return ` <span class="detail">(${esc(e.outcome)})</span>`;
  if (e.type === 'decision' && e.decision) return ` <span class="detail">— reply “${esc(e.decision.reply)}” (${esc(e.decision.outcome)})</span>`;
  return '';
}

function whySection(state, now) {
  const b = state.brief;
  const p = state.plan;
  const tiers = p.tiers.map((t) => {
    const marks = [t.id === p.selected_tier && 'selected', t.id === p.default_tier && 'default'].filter(Boolean);
    const price = t.price_checked_at ? `checked ${esc(ageText(t.price_checked_at, now))}` : '<span class="none">price not checked</span>';
    return `<tr${marks.includes('selected') ? ' class="selected"' : ''}>
      <th scope="row">${esc(t.name)}${marks.map((m) => ` <span class="tag">${m}</span>`).join('')}</th>
      <td>${esc(t.composition)}</td><td>${esc(t.region)}</td>
      <td>${esc(t.cost_range.low)}–${esc(t.cost_range.high)} ${esc(t.cost_range.currency)} per ${esc(t.cost_range.period)}<br><span class="age">${price}</span></td>
      <td>${esc(t.load_assumption)}</td><td>${esc(t.uncertainty)}</td></tr>`;
  }).join('');
  return section('q-why', 3, 'Why this plan?', `
    ${dl([
      ['Why this shape', orNone(b.resource_rationale, 'No rationale recorded yet.')],
      ['Heavier options not needed', list(b.heavier_alternatives, 'None recorded.', (h) => `<strong>${esc(h.alternative)}</strong> — ${esc(h.why_unnecessary)}`)],
      ['Assumptions', list(b.assumptions, 'None recorded.')],
    ])}
    ${tiers ? `<div class="scroll"><table class="tiers"><thead><tr><th>Tier</th><th>What it is</th><th>Region</th><th>Cost range</th><th>Load it assumes</th><th>Uncertainty</th></tr></thead><tbody>${tiers}</tbody></table></div>` : '<p class="none">No tiers yet.</p>'}`);
}

function decisionSection(state, now) {
  const p = state.pending_decision;
  if (!p) return section('q-decision', 4, 'What needs my decision?', '<p class="calm">Nothing needs your decision right now.</p>');
  const card = `<div id="decision-card" class="card" role="region" aria-label="Decision needed">
    <p class="cats">${p.categories.map((c) => `<span class="cat">${esc(GATES[c] ?? c)}</span>`).join(' ')}</p>
    ${dl([
      ['What will be done', esc(p.action)],
      ['Targets', list(p.targets, 'None listed.')],
      ['Why', esc(p.why)],
      ['Cost or blast radius', esc(p.cost_or_blast_radius)],
      ['Can it be undone?', esc(p.reversibility)],
      ['Rollback', esc(p.rollback)],
      ['How success will be confirmed', esc(p.success_check)],
      ['Requested', esc(when(p.requested_at, now))],
    ])}
    <h3>What to reply</h3>
    <ul class="replies">${p.reply_options.map((r) => `<li><code>${esc(r.reply)}</code> — ${esc(r.meaning)}</li>`).join('')}</ul>
    <p class="where-to-reply"><strong>Reply in the AI session.</strong> This page is read-only and cannot send anything.</p>
  </div>`;
  return section('q-decision', 4, 'What needs my decision?', card, ' urgent');
}

// Service rows are derived from the recorded health.<component> facts and their host
// resources; the view adds nothing of its own and shows the last observation, not a live check.
function servicesBlock(state, now) {
  const health = state.facts.filter((f) => f.key.startsWith('health.'));
  if (!health.length) return '';
  const byId = new Map(state.resources.map((r) => [r.id, r]));
  const rows = health.map((f) => {
    const hostId = /^[A-Za-z0-9._-]+/.exec(f.scope)?.[0];
    const host = byId.get(hostId);
    const where = host
      ? `on <strong>${esc(host.name)}</strong> <span class="type">(${esc(host.id)}, ${esc(host.lifecycle)})</span>`
      : `<span class="none">host not recorded</span>`;
    const checked = f.checked_at ? `checked ${esc(ageText(f.checked_at, now))} · ${esc(freshnessText(f, now))}` : 'never checked';
    return `<li class="service${f.problem ? ' fact-problem' : ''}" data-service="${esc(f.key.slice(7))}">${problemFlag(f)}<strong>${esc(f.key.slice(7))}</strong> ${where}
      <div class="fact-val">Value: ${orNone(f.value, 'no value')}</div>
      <div class="fact-meta">Verification: ${badge(f, now)} · ${checked}${f.evidence.length ? ` · Evidence: ${f.evidence.map((e) => `<code>${esc(e)}</code>`).join(' ')}` : ''}</div></li>`;
  }).join('');
  return `<h3>Services <span class="sub">last recorded observation</span></h3><ul class="services">${rows}</ul>`;
}

function trustSection(state, now) {
  const facts = state.facts
    .map((f) => ({ f, d: factDisplay(f, now) }))
    .sort((x, y) => Number(Boolean(y.f.problem)) - Number(Boolean(x.f.problem)) || TRUST_ORDER.indexOf(x.d.kind) - TRUST_ORDER.indexOf(y.d.kind));
  const factItems = facts.map(({ f, d }) => {
    const exp = expiresAt(f);
    let window = '';
    if (exp && d.current) window = ` · ${esc(freshnessText(f, now))} (until ${esc(clock(exp))})`;
    else if (exp && exp <= now) window = ` · freshness window ended ${esc(ageText(new Date(exp).toISOString(), now))}`;
    const freshness = f.checked_at ? `checked ${esc(ageText(f.checked_at, now))}${window}` : 'never checked';
    return `<li class="fact${f.problem ? ' fact-problem' : ''}">
      <div class="fact-head">${problemFlag(f)}<strong>${esc(f.label)}</strong></div>
      <div class="fact-val">Value: ${orNone(f.value, 'no value')}</div>
      <div class="fact-meta">Verification: ${badge(f, now)} · ${freshness} · scope: ${esc(f.scope)}</div>
      ${f.control ? `<div class="fact-meta">Control: ${esc(f.control)}</div>` : ''}
      ${f.blocked_by ? `<div class="fact-meta">Blocked by: ${esc(f.blocked_by)}</div>` : ''}
      ${f.evidence.length ? `<div class="fact-meta">Evidence: ${f.evidence.map((e) => `<code>${esc(e)}</code>`).join(' ')}</div>` : ''}
    </li>`;
  }).join('');

  const byProvider = new Map();
  for (const r of state.resources) {
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, []);
    byProvider.get(r.provider).push(r);
  }
  const tree = (items, parent) => {
    const kids = items.filter((r) => r.parent_id === parent);
    if (!kids.length) return '';
    return `<ul class="tree">${kids.map((r) => `<li data-resource="${esc(r.id)}"><strong>${esc(r.name)}</strong> <span class="type">${esc(r.type)}</span> — ${esc(r.lifecycle)} · ${esc(ORIGIN[r.origin] ?? r.origin)} · ${r.billable ? '<span class="bill">billable</span>' : 'not billable'} · ${factRef(state, r.evidence_fact, now)}${tree(items, r.id)}</li>`).join('')}</ul>`;
  };
  const resources = [...byProvider].map(([provider, items]) => `<div class="provider"><h4>${esc(provider)}</h4>${tree(items, null)}</div>`).join('');
  const secrets = state.secrets.map((s) => `<li><strong>${esc(s.name)}</strong> — ${esc(s.availability)} · kept in ${esc(s.location)} · last verified ${esc(ageText(s.last_verified_at, now))}</li>`).join('');

  return section('q-trust', 5, 'What can I trust?', `
    <p class="note">Verification and freshness describe the check, not whether the value is favorable. A false value can be healthy. Problems are marked separately.</p>
    ${servicesBlock(state, now)}
    ${factItems ? `<ul class="facts">${factItems}</ul>` : '<p class="none">No facts recorded yet.</p>'}
    <h3>Resources</h3>
    ${resources || '<p class="none">No resources recorded.</p>'}
    <h3>Secrets <span class="sub">names and locations only</span></h3>
    ${secrets ? `<ul>${secrets}</ul>` : '<p class="none">No secrets recorded.</p>'}`);
}

function nextSection(state, now) {
  const h = state.handoff;
  const items = [...state.open_items].sort((a, b) => Number(b.blocking) - Number(a.blocking));
  const ready = h.last_safe_state && h.read_first.length;
  return section('q-next', 6, 'What happens next?', `
    ${dl([
      ['Next', `<strong>${esc(state.next.action)}</strong>`],
      ['Decision owner', esc(party(state.next.decision_owner))],
      ['Open items', list(items, 'None.', (o) => `${o.blocking ? '<span class="flag">Blocking</span> ' : ''}${esc(o.text)} <span class="who">(${esc(party(o.owner))})</span>`)],
    ])}
    <h3>Handoff ${ready ? '<span class="tag">written</span>' : '<span class="tag muted">not written yet</span>'}</h3>
    ${dl([
      ['Read first', list(h.read_first, 'Nothing listed.', (x) => `<code>${esc(x)}</code>`)],
      ['Last known safe state', orNone(h.last_safe_state, 'Not recorded yet.')],
      ['Rollback anchor', orNone(h.rollback_anchor, 'Not recorded yet.')],
      ['Known to be unverified', list(h.known_unverified, 'Nothing listed.')],
      ['Fragile', list(h.fragile, 'Nothing listed.')],
    ])}`);
}

function actionBanner(state) {
  const action = humanAction(state);
  return action
    ? `<div class="banner action" id="your-action" role="status"><strong>Your next action:</strong> ${esc(action)}</div>`
    : '<div class="banner calm" id="your-action" role="status">Nothing needs you right now.</div>';
}

export function renderView(state, events, now) {
  checkShape(state, events);
  const sections = [
    whatSection(state, now),
    whereSection(state, events, now),
    whySection(state, now),
    decisionSection(state, now),
    trustSection(state, now),
    nextSection(state, now),
  ];
  if (state.pending_decision) sections.unshift(sections.splice(3, 1)[0]);
  return `${actionBanner(state)}${strip(state, now)}<div class="grid">${sections.join('')}</div>`;
}

export function renderError(title, detail) {
  return `<div class="banner error" role="alert"><strong>${esc(title)}</strong> ${esc(detail)}<br>Nothing is shown rather than a guess. Fix the file and this page will update by itself.</div>`;
}
