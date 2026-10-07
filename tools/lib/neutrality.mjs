// Neutrality scan: search a folder for protected terms (workload names, codenames,
// personal identifiers, real domains) read from a denylist kept outside it. Results name
// only the file, line and term number, never the term. The same pass plants the first
// term in a control file and must find it, or the scan has proved nothing.
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

const SKIP = new Set(['.git', 'node_modules']);

function parseDenylist(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.toLowerCase());
}

function matchText(text, file, terms) {
  const hits = [];
  text.toLowerCase().split('\n').forEach((line, i) => {
    terms.forEach((term, t) => {
      if (line.includes(term)) hits.push({ file, line: i + 1, term: t + 1 });
    });
  });
  return hits;
}

// Regular files only; symbolic links are neither followed nor read.
async function* walk(root, rel = '') {
  const entries = (await readdir(join(root, rel), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk(root, child);
    else if (entry.isFile()) yield child;
  }
}

export async function scanForTerms({ root, denylistPath }) {
  const inside = relative(resolve(root), resolve(denylistPath));
  if (!inside.startsWith('..') && !inside.startsWith(sep) && inside !== resolve(denylistPath)) {
    throw new Error('keep the denylist outside the folder being scanned');
  }
  const terms = parseDenylist(await readFile(denylistPath, 'utf8'));
  if (terms.length === 0) throw new Error('the denylist has no terms, so a clean result would prove nothing');

  const controlDir = await mkdtemp(join(tmpdir(), 'watchover-control-'));
  try {
    const controlFile = join(controlDir, 'control.txt');
    await writeFile(controlFile, `control file\nplanted: ${terms[0]}\n`);
    const control = matchText(await readFile(controlFile, 'utf8'), 'control.txt', terms).some((h) => h.term === 1) ? 'detected' : 'missed';

    const hits = [];
    let filesScanned = 0;
    for await (const file of walk(root)) {
      filesScanned += 1;
      hits.push(...matchText(await readFile(join(root, file), 'utf8'), file, terms));
    }
    const verdict = control !== 'detected' ? 'control-failed' : hits.length ? 'hits' : 'clean';
    return { verdict, control, hits, filesScanned, terms: terms.length };
  } finally {
    await rm(controlDir, { recursive: true, force: true });
  }
}
