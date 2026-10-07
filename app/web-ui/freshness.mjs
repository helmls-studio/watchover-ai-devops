// Freshness and status display, shared by the browser view and the Node tests.
// The view computes expiry from the clock and never upgrades a status: a fact reads as
// current only if it is VERIFIED_* and still inside its own freshness window.

export const NO_RECENT_UPDATE_MINUTES = 15;
// The view re-reads state.json and events.jsonl every REFRESH_INTERVAL_MS; an on-disk
// change is declared to appear within REFRESH_BOUND_MS (one interval plus fetch time).
export const REFRESH_INTERVAL_MS = 5000;
export const REFRESH_BOUND_MS = 10000;

const MINUTE = 60000;

// A check time after the viewing clock means the clocks disagree; such a fact is never
// current, however long its window.
const inFuture = (iso, now) => Boolean(iso) && Date.parse(iso) > now;

export function isCurrent(fact, now) {
  if (fact.status !== 'VERIFIED_LOCAL' && fact.status !== 'VERIFIED_REMOTE') return false;
  if (!fact.checked_at || !fact.fresh_for_minutes || inFuture(fact.checked_at, now)) return false;
  return now < Date.parse(fact.checked_at) + fact.fresh_for_minutes * MINUTE;
}

export function expiresAt(fact) {
  if (!fact.checked_at || !fact.fresh_for_minutes) return null;
  return Date.parse(fact.checked_at) + fact.fresh_for_minutes * MINUTE;
}

const KINDS = {
  'verified-local': { label: 'Verified locally, fresh', symbol: '✓' },
  'verified-remote': { label: 'Verified remotely, fresh', symbol: '✓✓' },
  stale: { label: 'Stale', symbol: '◐' },
  unknown: { label: 'Unknown', symbol: '?' },
  blocked: { label: 'Blocked', symbol: '⊘' },
  assumed: { label: 'Assumed', symbol: '~' },
  'user-confirmed': { label: 'Confirmed by you, not checked', symbol: '✎' },
  unrecognised: { label: 'Unrecognised status', symbol: '!' },
};
const BY_STATUS = {
  STALE: 'stale', UNKNOWN: 'unknown', BLOCKED: 'blocked', ASSUMED: 'assumed', USER_CONFIRMED: 'user-confirmed',
};

export function factDisplay(fact, now) {
  if (fact.status === 'VERIFIED_LOCAL' || fact.status === 'VERIFIED_REMOTE') {
    const where = fact.status === 'VERIFIED_LOCAL' ? 'locally' : 'remotely';
    if (inFuture(fact.checked_at, now)) {
      return { kind: 'verified-future', label: `Verified ${where} at a future time (check the clocks)`, symbol: '»', current: false };
    }
    if (isCurrent(fact, now)) {
      const kind = fact.status === 'VERIFIED_LOCAL' ? 'verified-local' : 'verified-remote';
      return { kind, ...KINDS[kind], current: true };
    }
    return { kind: 'verified-expired', label: `Verified ${where}, expired`, symbol: '◌', current: false };
  }
  const kind = BY_STATUS[fact.status] ?? 'unrecognised';
  return { kind, ...KINDS[kind], current: false };
}

export function ageText(iso, now) {
  if (!iso) return 'never';
  const ms = now - Date.parse(iso);
  if (ms < 0) return 'in the future (check the clocks)';
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours} h ${minutes % 60} min ago` : `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

export function stateRecency(state, now) {
  const iso = state?.identity?.updated_at ?? null;
  const ageMinutes = iso ? (now - Date.parse(iso)) / MINUTE : Infinity;
  const clockProblem = inFuture(iso, now);
  return { ageMinutes, clockProblem, recent: !clockProblem && ageMinutes <= NO_RECENT_UPDATE_MINUTES, ageText: ageText(iso, now) };
}

// Whole minutes left in a fact's freshness window (negative once it has ended), or null
// when the fact has no window. Shared by the view and the `brief` command, so both show
// the same number for the same clock.
export function remainingMinutes(fact, now) {
  const exp = expiresAt(fact);
  return exp === null ? null : Math.floor((exp - now) / MINUTE);
}

// Short freshness wording for a fact, identical in the view and in `brief`.
export function freshnessText(fact, now) {
  const d = factDisplay(fact, now);
  if (d.current) {
    const left = remainingMinutes(fact, now);
    return left < 1 ? 'fresh for less than 1 more min' : `fresh for ${left} more min`;
  }
  if (d.kind === 'verified-expired') return 'freshness window ended';
  if (d.kind === 'verified-future') return 'check time is in the future';
  return 'not a current verified fact';
}

// What the human actually has to do now, from the record only; null when nothing.
export function humanAction(state) {
  const p = state?.pending_decision;
  if (p) return `Reply to request ${p.id}: ${p.action}`;
  if (state?.next?.decision_owner === 'human') return state.next.action;
  if (state?.activity?.waiting_on === 'human') return state.activity.summary;
  return null;
}
