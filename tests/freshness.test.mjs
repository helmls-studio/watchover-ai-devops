import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factDisplay, isCurrent, ageText, stateRecency, NO_RECENT_UPDATE_MINUTES } from '../app/web-ui/freshness.mjs';

const T = Date.parse('2026-09-01T10:00:00Z');
const min = (n) => n * 60000;
const verified = (status, checkedMinutesAgo, freshFor) => ({
  status, checked_at: new Date(T - min(checkedMinutesAgo)).toISOString(), fresh_for_minutes: freshFor,
});

test('a verified fact is current only inside its freshness window', () => {
  assert.equal(isCurrent(verified('VERIFIED_REMOTE', 10, 15), T), true);
  assert.equal(isCurrent(verified('VERIFIED_REMOTE', 15, 15), T), false, 'expires exactly at the end of the window');
  assert.equal(isCurrent(verified('VERIFIED_LOCAL', 20, 15), T), false);
});

test('only verified facts can ever be current', () => {
  for (const status of ['ASSUMED', 'USER_CONFIRMED', 'STALE', 'UNKNOWN', 'BLOCKED']) {
    assert.equal(isCurrent(verified(status, 1, 60), T), false, status);
  }
  assert.equal(isCurrent({ status: 'VERIFIED_REMOTE', checked_at: null, fresh_for_minutes: 15 }, T), false);
  assert.equal(isCurrent({ status: 'VERIFIED_REMOTE', checked_at: new Date(T).toISOString(), fresh_for_minutes: null }, T), false);
});

test('each status has its own display kind, label and symbol', () => {
  const kinds = [
    factDisplay(verified('VERIFIED_LOCAL', 1, 60), T),
    factDisplay(verified('VERIFIED_REMOTE', 1, 60), T),
    factDisplay(verified('VERIFIED_REMOTE', 90, 60), T),
    factDisplay({ status: 'STALE' }, T),
    factDisplay({ status: 'UNKNOWN' }, T),
    factDisplay({ status: 'BLOCKED' }, T),
    factDisplay({ status: 'ASSUMED' }, T),
    factDisplay({ status: 'USER_CONFIRMED' }, T),
  ];
  assert.deepEqual(kinds.map((k) => k.kind), [
    'verified-local', 'verified-remote', 'verified-expired', 'stale', 'unknown', 'blocked', 'assumed', 'user-confirmed',
  ]);
  assert.equal(new Set(kinds.map((k) => k.label)).size, kinds.length, 'labels are distinct');
  assert.equal(new Set(kinds.map((k) => k.symbol)).size, kinds.length, 'symbols are distinct');
  assert.deepEqual(kinds.map((k) => k.current), [true, true, false, false, false, false, false, false]);
});

test('display never upgrades a status', () => {
  assert.equal(factDisplay({ status: 'STALE', checked_at: new Date(T).toISOString(), fresh_for_minutes: 60 }, T).kind, 'stale');
  assert.equal(factDisplay({ status: 'USER_CONFIRMED', checked_at: new Date(T).toISOString(), fresh_for_minutes: 60 }, T).kind, 'user-confirmed');
  assert.equal(factDisplay({ status: 'SOMETHING_ELSE' }, T).kind, 'unrecognised');
  assert.equal(factDisplay({ status: 'SOMETHING_ELSE' }, T).current, false);
});

test('an expired verified fact says how it was verified and that it expired', () => {
  const d = factDisplay(verified('VERIFIED_LOCAL', 90, 60), T);
  assert.match(d.label, /locally/i);
  assert.match(d.label, /expired/i);
});

test('ages read in plain words', () => {
  const at = (m) => new Date(T - min(m)).toISOString();
  assert.equal(ageText(at(0.2), T), 'just now');
  assert.equal(ageText(at(5), T), '5 min ago');
  assert.equal(ageText(at(130), T), '2 h 10 min ago');
  assert.equal(ageText(at(60 * 49), T), '2 days ago');
  assert.equal(ageText(new Date(T + min(10)).toISOString(), T), 'in the future (check the clocks)');
  assert.equal(ageText(null, T), 'never');
});

test('state recency uses the declared no-recent-update age', () => {
  const state = (m) => ({ identity: { updated_at: new Date(T - min(m)).toISOString() } });
  assert.equal(stateRecency(state(NO_RECENT_UPDATE_MINUTES - 1), T).recent, true);
  assert.equal(stateRecency(state(NO_RECENT_UPDATE_MINUTES + 1), T).recent, false);
  assert.equal(stateRecency(state(3), T).ageText, '3 min ago');
});

// ---- R3: clocks that disagree ----

test('a verified fact checked after the viewing clock is neither current nor fresh', () => {
  const future = { status: 'VERIFIED_REMOTE', checked_at: new Date(T + min(24 * 60)).toISOString(), fresh_for_minutes: 60 };
  assert.equal(isCurrent(future, T), false);
  const d = factDisplay(future, T);
  assert.equal(d.kind, 'verified-future');
  assert.equal(d.current, false);
  assert.match(d.label, /future/i);
});

test('a future-dated state is not recent and flags the clock problem', () => {
  const r = stateRecency({ identity: { updated_at: new Date(T + min(10)).toISOString() } }, T);
  assert.equal(r.recent, false);
  assert.equal(r.clockProblem, true);
  assert.equal(stateRecency({ identity: { updated_at: new Date(T - min(3)).toISOString() } }, T).clockProblem, false);
});

test('any time after the viewing clock reads as a clock problem', () => {
  assert.equal(ageText(new Date(T + 10000).toISOString(), T), 'in the future (check the clocks)');
});
