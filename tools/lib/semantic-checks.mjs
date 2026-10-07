// Named cross-field checks. The schemas fix shape; these fix meaning that a schema in
// the supported subset cannot express (Annex C trust by source, Annex D statuses and
// freshness, Annex F event rules, Annex G approval and coalescing, FT-2 consistency).
// Each check returns errors of the form { check, file, pointer?, line?, message }.

export const FRESHNESS_CAPS = Object.freeze({
  identity: 1440,
  permission: 240,
  resource: 240,
  health: 60,
  source: 1440,
  price: 43200,
  network: 240,
  other: 1440,
});

const VERIFIED = new Set(['VERIFIED_LOCAL', 'VERIFIED_REMOTE']);
const TRUSTED_SOURCE = { VERIFIED_LOCAL: 'local_check', VERIFIED_REMOTE: 'remote_observation', USER_CONFIRMED: 'human', ASSUMED: 'reasoning' };
const OBSERVED_STATUS = { local_check: 'VERIFIED_LOCAL', remote_observation: 'VERIFIED_REMOTE' };
const EVENT_ONLY_FIELDS = { stage: 'stage_change', request: 'decision_request', decision: 'decision', fact: 'fact_verified' };
const REQUIRED_EVENT_FIELDS = {
  stage_change: ['stage'],
  intent: ['target', 'action', 'action_kinds'],
  result: ['outcome', 'related'],
  decision_request: ['request'],
  decision: ['decision', 'related'],
  fact_verified: ['fact', 'evidence'],
  plan_failure: ['state_change'],
};

const S = 'state.json';
const E = 'events.jsonl';
const seq = (id) => Number(id.slice(4));
const sameInstant = (a, b) => a !== null && b !== null && Date.parse(a) === Date.parse(b);
const sameSet = (a, b) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

// Open intents are valid during execution/interruption, but terminal records need results.
export function openIntents(events) {
  const paired = new Set(events.filter((e) => e.type === 'result').flatMap((e) => e.related ?? []));
  return events.filter((e) => e.type === 'intent' && !paired.has(e.id));
}

const stateChecks = {
  'unique-ids'(state, err) {
    const groups = [
      ['facts', 'key', state.facts],
      ['resources', 'id', state.resources],
      ['plan/tiers', 'id', state.plan.tiers],
      ['sources', 'name', state.sources],
      ['secrets', 'name', state.secrets],
    ];
    for (const [path, field, items] of groups) {
      const seen = new Set();
      items.forEach((item, i) => {
        if (seen.has(item[field])) err(`/${path}/${i}`, `duplicate ${field} "${item[field]}"`);
        seen.add(item[field]);
      });
    }
  },
  'trust-by-source'(state, err) {
    state.facts.forEach((f, i) => {
      const needed = TRUSTED_SOURCE[f.status];
      if (needed && f.source !== needed) err(`/facts/${i}`, `${f.status} requires source "${needed}", not "${f.source}"`);
    });
  },
  'verified-needs-evidence'(state, err) {
    state.facts.forEach((f, i) => {
      if (!VERIFIED.has(f.status)) return;
      if (f.evidence.length === 0) err(`/facts/${i}`, `${f.status} fact "${f.key}" has no evidence locator`);
      if (f.checked_at === null) err(`/facts/${i}`, `${f.status} fact "${f.key}" has no checked_at`);
      if (f.fresh_for_minutes === null) err(`/facts/${i}`, `${f.status} fact "${f.key}" has no freshness rule`);
    });
  },
  'freshness-within-class-cap'(state, err) {
    state.facts.forEach((f, i) => {
      if (f.fresh_for_minutes !== null && f.fresh_for_minutes > FRESHNESS_CAPS[f.class]) {
        err(`/facts/${i}`, `fresh_for_minutes ${f.fresh_for_minutes} exceeds the ${f.class} cap of ${FRESHNESS_CAPS[f.class]}`);
      }
    });
  },
  'stale-was-observed'(state, err) {
    state.facts.forEach((f, i) => {
      if (f.status === 'STALE' && f.checked_at === null) err(`/facts/${i}`, `STALE fact "${f.key}" was never observed (no checked_at)`);
    });
  },
  'blocked-names-prerequisite'(state, err) {
    state.facts.forEach((f, i) => {
      if (f.status === 'BLOCKED' && !f.blocked_by) err(`/facts/${i}`, `BLOCKED fact "${f.key}" does not say what prerequisite is unavailable`);
    });
  },
  'assumed-holds-value'(state, err) {
    state.facts.forEach((f, i) => {
      if (f.status === 'ASSUMED' && f.value === null) err(`/facts/${i}`, `ASSUMED fact "${f.key}" holds no value`);
    });
  },
  'negative-result-needs-control'(state, err) {
    state.facts.forEach((f, i) => {
      if (f.negative_result === true && VERIFIED.has(f.status) && !f.control) {
        err(`/facts/${i}`, `negative result "${f.key}" is marked verified without a control`);
      }
    });
  },
  'resource-tree'(state, err) {
    const byId = new Map(state.resources.map((r) => [r.id, r]));
    state.resources.forEach((r, i) => {
      if (r.parent_id === null) return;
      if (!byId.has(r.parent_id)) {
        err(`/resources/${i}`, `parent "${r.parent_id}" does not exist`);
        return;
      }
      const seen = new Set([r.id]);
      for (let p = byId.get(r.parent_id); p; p = byId.get(p.parent_id)) {
        if (seen.has(p.id)) {
          err(`/resources/${i}`, `resource "${r.id}" is part of a parent cycle`);
          return;
        }
        seen.add(p.id);
      }
    });
  },
  'references-resolve'(state, err) {
    const keys = new Set(state.facts.map((f) => f.key));
    const tiers = new Set(state.plan.tiers.map((t) => t.id));
    const factRef = (pointer, key) => {
      if (key !== null && !keys.has(key)) err(pointer, `fact "${key}" does not exist`);
    };
    state.resources.forEach((r, i) => factRef(`/resources/${i}/evidence_fact`, r.evidence_fact));
    state.sources.forEach((s, i) => {
      factRef(`/sources/${i}/local_changes_fact`, s.local_changes_fact);
      factRef(`/sources/${i}/deployed_ref_fact`, s.deployed_ref_fact);
    });
    for (const field of ['default_tier', 'selected_tier']) {
      const id = state.plan[field];
      if (id !== null && !tiers.has(id)) err(`/plan/${field}`, `tier "${id}" does not exist`);
    }
  },
  'ranges-ordered'(state, err) {
    const d = state.activity.expected_duration;
    if (d && d.min_minutes > d.max_minutes) err('/activity/expected_duration', 'min_minutes is greater than max_minutes');
    state.plan.tiers.forEach((t, i) => {
      if (t.cost_range.low > t.cost_range.high) err(`/plan/tiers/${i}/cost_range`, 'low is greater than high');
    });
  },
  'coalesced-plan-explanation'(state, err) {
    const p = state.pending_decision;
    if (!p || !p.categories.includes('plan_acceptance')) return;
    const b = state.brief;
    const missing = [];
    if (!b.app_summary) missing.push('brief.app_summary');
    if (b.components.length === 0) missing.push('brief.components');
    if (!b.topology) missing.push('brief.topology');
    if (!b.resource_rationale) missing.push('brief.resource_rationale');
    if (state.plan.tiers.length === 0) missing.push('plan.tiers');
    if (state.plan.default_tier === null && state.plan.selected_tier === null) missing.push('plan.default_tier');
    if (missing.length) err('/pending_decision', `a plan-acceptance request must carry the plan explanation; missing ${missing.join(', ')}`);
  },
  // D-17: problem marks what an observation showed; an unverified assertion cannot carry it.
  'problem-is-observed'(state, err) {
    state.facts.forEach((f, i) => {
      if (f.problem === true && !VERIFIED.has(f.status) && f.status !== 'STALE') {
        err(`/facts/${i}`, `${f.status} fact "${f.key}" is not an observation and cannot flag a problem`);
      }
    });
  },
};

const eventChecks = {
  'event-sequence'(events, err) {
    events.forEach((e, i) => {
      if (i === 0) return;
      const prev = events[i - 1];
      if (seq(e.id) <= seq(prev.id)) err(i, `id ${e.id} does not increase after ${prev.id}`);
      if (Date.parse(e.at) < Date.parse(prev.at)) err(i, `/at precedes previous event ${prev.id} at ${prev.at}; omit at to use CLI time filling, or supply a time at or after the predecessor. Align checked_at with the recorded promotion time`);
    });
  },
  'stage-chain'(events, err) {
    if (events.length === 0) {
      err(null, 'there are no events; initialization writes the first stage event');
      return;
    }
    if (events[0].type !== 'stage_change' || events[0].stage?.from !== null) {
      err(0, 'the first event must be the initial stage change (from null)');
    }
    let current = null;
    events.forEach((e, i) => {
      if (e.type !== 'stage_change' || !e.stage) return;
      if (e.stage.from !== current) err(i, `stage change from "${e.stage.from}" does not follow the current stage "${current}"`);
      current = e.stage.to;
    });
  },
  'event-type-fields'(events, err) {
    events.forEach((e, i) => {
      for (const field of REQUIRED_EVENT_FIELDS[e.type]) {
        const v = e[field];
        if (v === undefined || (Array.isArray(v) && v.length === 0)) err(i, `${e.type} event needs "${field}"`);
      }
      for (const [field, type] of Object.entries(EVENT_ONLY_FIELDS)) {
        if (e[field] !== undefined && e.type !== type) err(i, `"${field}" belongs only on ${type} events`);
      }
      if (e.type === 'decision' && e.actor.role !== 'human') err(i, 'a decision event records a human decision');
      if (e.type === 'fact_verified' && e.fact && !VERIFIED.has(e.fact.status)) err(i, 'fact_verified must promote to a VERIFIED_* status');
    });
  },
  'event-links'(events, err) {
    const index = new Map(events.map((e, i) => [e.id, i]));
    events.forEach((e, i) => {
      const related = e.related ?? [];
      for (const id of related) {
        if (!index.has(id) || index.get(id) >= i) err(i, `related event ${id} is not an earlier event`);
      }
      const earlier = related.filter((id) => index.get(id) < i).map((id) => events[index.get(id)]);
      if (e.type === 'result' && !earlier.some((r) => r.type === 'intent')) err(i, 'a result must relate to its intent event');
      if (e.type === 'decision' && e.decision && !earlier.some((r) => r.type === 'decision_request' && r.request?.id === e.decision.request_id)) {
        err(i, `decision does not relate to the request "${e.decision.request_id}"`);
      }
    });
  },
  'one-decision-per-request'(events, err) {
    const requested = new Set();
    const decided = new Set();
    events.forEach((e, i) => {
      if (e.type === 'decision_request' && e.request) {
        if (requested.has(e.request.id)) err(i, `request id "${e.request.id}" is used more than once`);
        requested.add(e.request.id);
      }
      if (e.type === 'decision' && e.decision) {
        if (decided.has(e.decision.request_id)) err(i, `request "${e.decision.request_id}" already has a decision`);
        decided.add(e.decision.request_id);
      }
    });
  },
  // Annex G: a gated action runs only on an earlier approval; rejected, changed or
  // deferred decisions authorize nothing.
  'gated-intent-approved'(events, err) {
    const index = new Map(events.map((e, i) => [e.id, i]));
    events.forEach((e, i) => {
      if (e.type !== 'intent' || !e.action_kinds?.includes('gated')) return;
      const approved = (e.related ?? []).some((id) => {
        const j = index.get(id);
        return j < i && events[j].type === 'decision' && events[j].decision?.outcome === 'approved';
      });
      if (!approved) err(i, 'a gated intent must relate to an earlier approved decision');
    });
  },
};

const crossChecks = {
  'terminal-intents-have-results'(state, events, err) {
    if (!['handoff', 'closed'].includes(state.stage)) return;
    for (const e of openIntents(events)) {
      err(E, { line: events.indexOf(e) + 1 }, `${state.stage} has unpaired intent ${e.id}; record a related actual result. If unknown or not executed/cancelled, use outcome unknown with a truthful summary`);
    }
  },
  'state-stage-matches-events'(state, events, err) {
    const last = events.filter((e) => e.type === 'stage_change' && e.stage).at(-1);
    if (last && last.stage.to !== state.stage) err(S, { pointer: '/stage' }, `state stage "${state.stage}" differs from the last recorded stage change "${last.stage.to}"`);
  },
  'pending-decision-has-request'(state, events, err) {
    const p = state.pending_decision;
    if (!p) return;
    const requestEvent = events.find((e) => e.type === 'decision_request' && e.request?.id === p.id);
    const request = requestEvent?.request;
    if (!request) {
      err(S, { pointer: '/pending_decision' }, `no decision_request event records "${p.id}"`);
    } else if (events.some((e) => e.type === 'decision' && e.decision?.request_id === p.id)) {
      err(S, { pointer: '/pending_decision' }, `"${p.id}" was already answered but is still pending`);
    } else if (!sameSet(p.categories, request.categories)) {
      err(S, { pointer: '/pending_decision/categories' }, `pending categories differ from the recorded request "${p.id}"`);
    } else if (!sameInstant(p.requested_at, requestEvent.at)) {
      err(S, { pointer: '/pending_decision/requested_at' }, `requested_at differs from the time request "${p.id}" was recorded`);
    }
  },
  'requests-answered-or-pending'(state, events, err) {
    const answered = new Set(events.filter((e) => e.type === 'decision' && e.decision).map((e) => e.decision.request_id));
    events.forEach((e, i) => {
      if (e.type !== 'decision_request' || !e.request || answered.has(e.request.id)) return;
      if (state.pending_decision?.id !== e.request.id) err(E, { line: i + 1 }, `request "${e.request.id}" is unanswered but is not the pending decision`);
    });
  },
  // A VERIFIED_* fact, and a STALE one (an earlier observation), needs a fact_verified
  // event for its key with the verified status its observation source earns.
  // The current fact must be the latest promotion for its key: same verified status
  // (for STALE, the one its source earns), same check time, same evidence.
  'verified-facts-have-promotion-event'(state, events, err) {
    state.facts.forEach((f, i) => {
      if (!VERIFIED.has(f.status) && f.status !== 'STALE') return;
      const at = { pointer: `/facts/${i}` };
      const needed = f.status === 'STALE' ? OBSERVED_STATUS[f.source] : f.status;
      const latest = events.filter((e) => e.type === 'fact_verified' && e.fact?.key === f.key).at(-1);
      if (!needed) err(S, at, `STALE fact "${f.key}" has source "${f.source}", which is not an observation`);
      else if (!latest) err(S, at, `no fact_verified event records "${f.key}"`);
      else if (latest.fact.status !== needed) err(S, at, `the latest promotion of "${f.key}" is ${latest.fact.status}, not ${needed}`);
      else if (!sameInstant(f.checked_at, latest.at)) err(S, at, `checked_at of "${f.key}" differs from its latest promotion (${latest.id})`);
      else if (!sameSet(f.evidence, latest.evidence ?? [])) err(S, at, `evidence of "${f.key}" differs from its latest promotion (${latest.id})`);
    });
  },
  // FT-4: until plan acceptance has been approved, every billable request — recorded
  // or still pending — must carry plan acceptance. Walk the history in order.
  'first-billable-carries-plan'(state, events, err) {
    const requests = new Map();
    let planAccepted = false;
    const carriesPlan = (categories) => !categories.includes('billable') || categories.includes('plan_acceptance') || planAccepted;
    events.forEach((e, i) => {
      if (e.type === 'decision_request' && e.request) {
        requests.set(e.request.id, e.request);
        if (!carriesPlan(e.request.categories)) err(E, { line: i + 1 }, `billable request "${e.request.id}" comes before plan acceptance was approved and does not carry it (FT-4)`);
      }
      if (e.type === 'decision' && e.decision?.outcome === 'approved' && requests.get(e.decision.request_id)?.categories.includes('plan_acceptance')) {
        planAccepted = true;
      }
    });
    const p = state.pending_decision;
    if (p && !carriesPlan(p.categories)) err(S, { pointer: '/pending_decision' }, 'the first billable request must also carry plan acceptance (FT-4)');
  },
};

export const CHECK_IDS = Object.freeze([...Object.keys(stateChecks), ...Object.keys(eventChecks), ...Object.keys(crossChecks)]);

// Checks that need only the event log; Append runs these before writing a line.
export function runEventChecks(events) {
  const errors = [];
  for (const [check, fn] of Object.entries(eventChecks)) {
    fn(events, (i, message) => errors.push(i === null ? { check, file: E, message } : { check, file: E, line: i + 1, message }));
  }
  return errors;
}

export function runSemanticChecks(state, events) {
  const errors = [];
  for (const [check, fn] of Object.entries(stateChecks)) {
    fn(state, (pointer, message) => errors.push({ check, file: S, pointer, message }));
  }
  errors.push(...runEventChecks(events));
  // Cross checks locate a problem by a state pointer or an events line.
  for (const [check, fn] of Object.entries(crossChecks)) {
    fn(state, events, (file, where, message) => errors.push({ check, file, ...where, message }));
  }
  return errors;
}
