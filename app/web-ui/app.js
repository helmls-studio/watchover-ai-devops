// Fetch the record, render it, and do it again every few seconds. Read-only: the page
// only ever issues GET requests to its own local server, and stores nothing.
import { renderError, renderView } from './render.mjs';
import { REFRESH_INTERVAL_MS } from './freshness.mjs';

const main = document.getElementById('view');
const checked = document.getElementById('checked');
let lastHtml = '';
let busy = false;

class RecordError extends Error {
  constructor(title, detail = '') {
    super(title);
    this.title = title;
    this.detail = detail;
  }
}

async function fetchText(name) {
  const res = await fetch(`/${name}`, { cache: 'no-store' });
  if (!res.ok) throw new RecordError(`${name} could not be read`, `(HTTP ${res.status}).`);
  return res.text();
}

function parseState(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new RecordError('state.json is not valid JSON.');
  }
}

function parseEvents(text) {
  return text.split('\n').filter((line) => line.trim() !== '').map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new RecordError(`events.jsonl line ${i + 1} is not valid JSON.`);
    }
  });
}

function show(html, state) {
  if (html !== lastHtml) {
    main.innerHTML = html;
    lastHtml = html;
  }
  main.dataset.state = state;
}

async function refresh() {
  if (busy) return;
  busy = true;
  const now = Date.now();
  try {
    const [stateText, eventsText] = await Promise.all([fetchText('state.json'), fetchText('events.jsonl')]);
    const state = parseState(stateText);
    const events = parseEvents(eventsText);
    let html;
    try {
      html = renderView(state, events, now);
    } catch (err) {
      throw new RecordError('state.json cannot be shown:', err.message);
    }
    show(html, 'ready');
  } catch (err) {
    const known = err instanceof RecordError;
    show(renderError(known ? err.title : 'The record could not be loaded.', known ? err.detail : 'The local server may have stopped.'), 'error');
  } finally {
    checked.textContent = `Checked for updates at ${new Date(now).toISOString().slice(11, 19)} UTC · every ${REFRESH_INTERVAL_MS / 1000} s`;
    busy = false;
  }
}

refresh();
setInterval(refresh, REFRESH_INTERVAL_MS);
