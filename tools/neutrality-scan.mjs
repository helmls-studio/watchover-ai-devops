#!/usr/bin/env node
// Neutrality scan command. Prints the verdict and offending locations only; the terms
// themselves are never printed. Exit 0 clean, 1 hits, 2 control failed or usage error.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { scanForTerms } from './lib/neutrality.mjs';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const USAGE = 'usage: node tools/neutrality-scan.mjs <denylist-file outside the scanned folder> [--root <folder>]';

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: { root: { type: 'string' } }, allowPositionals: true });
  } catch {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (parsed.positionals.length !== 1) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let result;
  try {
    result = await scanForTerms({ root: parsed.values.root ?? REPO, denylistPath: parsed.positionals[0] });
  } catch (err) {
    process.stderr.write(`refused: ${err.code === 'ENOENT' ? 'a file or folder does not exist' : err.message}\n`);
    return 2;
  }
  const control = result.control === 'detected' ? 'control term detected' : 'CONTROL TERM MISSED';
  process.stdout.write(`verdict: ${result.verdict}; ${control}; ${result.hits.length} hits in ${result.filesScanned} files (${result.terms} terms)\n`);
  for (const h of result.hits) process.stdout.write(`- ${h.file}:${h.line} (term ${h.term})\n`);
  if (result.verdict === 'control-failed') return 2;
  return result.verdict === 'clean' ? 0 : 1;
}

main().then((code) => { process.exitCode = code; });
