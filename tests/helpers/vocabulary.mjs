import { readFile, realpath } from 'node:fs/promises';
import { relative, isAbsolute, sep } from 'node:path';

// Test-only public-content guards. Private identifiers belong in an external denylist.
// Synthetic canaries exercise guard classes without reconstructing real identities.
const w = (...parts) => parts.join('');

// Formal arm labels and comparative experiment wording do not belong in product guidance.
// Bare historical stage labels are allowed only in three evidence documents.
export const EXPERIMENT_WORDING = [
  new RegExp(String.raw`\b${w('W')}[12][ABC]?\b`),
  new RegExp(w('treat', 'ment'), 'i'),
  new RegExp(w('experi', 'ment a', 'rm'), 'i'),
];
export const GOVERNANCE_NAMES = new RegExp(String.raw`\b(${[w('private-seat-', 'alpha'), w('private-seat-', 'beta')].join('|')})\b`, 'i');
export const OVERSIGHT_NAME = new RegExp(String.raw`\b${w('private-coordinator-', '417')}\b`, 'i');
export const SAMPLES = {
  experiment: [w('W', '2', 'B'), w('treat', 'ment'), w('experi', 'ment a', 'rm')],
  governance: [w('private-seat-', 'alpha'), w('private-seat-', 'beta')],
  oversight: w('private-coordinator-', '417'),
};

// Exact full URLs only. A suffix, query or another repository is not an exception.
export const PUBLIC_URLS = [
  'https://github.com/helmls-studio/watchover-ai-devops',
  'https://github.com/helmls-studio/agent-run-recorder',
  'https://github.com/desxyx/helm-ai-orchestration-workbench',
];
export const PUBLIC_LINK_FILES = new Set(['README.md', 'docs/provenance.md', 'docs/validation.md', 'tests/helpers/vocabulary.mjs']);
export function withoutPublicLinks(text, file) {
  if (!PUBLIC_LINK_FILES.has(file)) return text;
  return text.replace(/https?:\/\/[^\s<>"'`)]+/g, (url) => PUBLIC_URLS.includes(url) ? '[approved public link]' : url);
}


const HISTORY_FILES = new Set(['README.md', 'docs/validation.md', 'docs/provenance.md']);
const ARM_WORDING = new RegExp(String.raw`\b${w('W')}[12][ABC]\b`);
export function experimentGuards(file) {
  return HISTORY_FILES.has(file) ? [ARM_WORDING, ...EXPERIMENT_WORDING.slice(1)] : EXPERIMENT_WORDING;
}

// Personal account directories, independent of a release-specific denylist.
export const PERSONAL_PATH = /(?:\/(?:Users|home)\/[^/\s]+(?:\/|$)|[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s]+(?:[\\/]|$))/i;

// Optional private input. No private identities or local configuration enter the product.
// Plain lines are case-insensitive substrings; word: lines require whole-word matches.
export async function loadPrivateTerms(file = process.env.WATCHOVER_PRIVACY_DENYLIST, root) {
  if (!file) return [];
  let text;
  try {
    const [actualRoot, actualFile] = await Promise.all([realpath(root), realpath(file)]);
    const inside = relative(actualRoot, actualFile);
    if (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) {
      throw new Error('inside');
    }
    text = await readFile(actualFile, 'utf8');
  } catch {
    throw new Error('The external privacy denylist must be a readable file outside the product.');
  }
  const terms = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
    .map((line) => ({ value: (line.startsWith('word:') ? line.slice(5) : line).trim().toLowerCase(), wholeWord: line.startsWith('word:') }));
  if (!terms.length || terms.some((term) => !term.value)) throw new Error('The external privacy denylist must contain nonempty terms.');
  return terms;
}

const decode = (text) => text.replace(/\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi, (_, unicode, hex) => String.fromCharCode(parseInt(unicode ?? hex, 16)));
const QUOTED = String.raw`(?:'[^'\r\n]*'|"[^"\r\n]*")`;
function privateVariants(line) {
  const decoded = decode(decode(line));
  const sequences = new RegExp(`${QUOTED}(?:\\s*[,+]\\s*${QUOTED})+`, 'g');
  return [line, decoded, ...[...decoded.matchAll(sequences)].map(([sequence]) => [...sequence.matchAll(new RegExp(QUOTED, 'g'))].map(([literal]) => literal.slice(1, -1)).join(''))];
}
function termMatches(text, term) {
  let start = text.indexOf(term.value);
  while (start >= 0) {
    if (!term.wholeWord || (!/[a-z0-9_]/i.test(text[start - 1] ?? '') && !/[a-z0-9_]/i.test(text[start + term.value.length] ?? ''))) return true;
    start = text.indexOf(term.value, start + 1);
  }
  return false;
}
export function contentViolations(text, file, privateTerms = []) {
  const hits = [];
  withoutPublicLinks(text, file).split(/\r?\n/).forEach((line, i) => {
    if ([...experimentGuards(file), GOVERNANCE_NAMES, OVERSIGHT_NAME].some((guard) => guard.test(line))) hits.push({ line: i + 1, check: 'wording' });
    if (PERSONAL_PATH.test(line) || PERSONAL_PATH.test(decode(decode(line)))) hits.push({ line: i + 1, check: 'personal-path' });
    privateTerms.forEach((term, n) => {
      if (privateVariants(line).some((variant) => termMatches(variant.toLowerCase(), term))) hits.push({ line: i + 1, check: 'private-term', term: n + 1 });
    });
  });
  return hits;
}
