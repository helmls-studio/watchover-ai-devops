// Secret-pattern check for every product surface (FT-3).
// Each pattern carries a canary: an obviously fake sample it must detect. selfTest()
// runs every canary in the same validation pass, so a clean scan is only trusted when
// every pattern has just proven it can still fire. Canaries are assembled from
// fragments so this source file does not itself contain a credential-shaped string.

const c = (...parts) => parts.join('');

export const SECRET_PATTERNS = Object.freeze([
  { id: 'private-key-block', regex: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/, canary: c('-----BEGIN ', 'PRIVATE KEY-----') },
  { id: 'service-account-key-field', regex: /"private_key(?:_id)?"\s*:\s*"[^"]{8,}/, canary: c('"private', '_key": "WATCHOVER-CANARY-NOT-A-KEY"') },
  { id: 'aws-access-key-id', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, canary: c('AK', 'IA', 'WATCHOVERCANARY1') },
  { id: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/, canary: c('AI', 'za', 'WatchOverCanaryNotARealKey000000000') },
  { id: 'google-oauth-token', regex: /\bya29\.[0-9A-Za-z_-]{20,}/, canary: c('ya', '29.', 'WatchOverCanaryNotAToken') },
  { id: 'github-token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/, canary: c('gh', 'p_', 'WatchOverCanaryNotARealToken00000000') },
  { id: 'slack-token', regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, canary: c('xo', 'xb-', 'watchover-canary') },
  { id: 'stripe-live-key', regex: /\b[rs]k_live_[0-9A-Za-z]{16,}/, canary: c('sk', '_live_', 'WatchOverCanary0') },
  { id: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, canary: c('ey', 'Jwatchover.', 'ey', 'Jcanary00.notasignature') },
  { id: 'url-credentials', regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:(?!\[REDACTED\])[^\s/@"']+@/i, canary: c('postgres://app:', 'watchover-canary', '@db.example.com/app') },
  {
    id: 'secret-assignment',
    regex: /(?<![A-Za-z])(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?(?!\[REDACTED\]|\$|<|\*{3})[^\s"',;]{8,}/i,
    canary: c('API_TO', 'KEN=', 'watchover-canary-value'),
  },
  {
    id: 'passphrase-assignment',
    regex: /\bpassphrase["']?\s*[:=]\s*["']?(?!\[REDACTED|\$|<|\*{3})[^\s"',;]{8,}/i,
    canary: c('pass', 'phrase=', 'watchover-canary-phrase'),
  },
  {
    id: 'named-key-secret-assignment',
    regex: /\b[A-Z][A-Z0-9_]*_(?:KEY|SECRET)["']?\s*[:=]\s*["']?(?!\[REDACTED|\$|<|\*{3})[^\s"',;]{8,}/,
    canary: c('DEPLOY_', 'KEY=', 'watchover-canary-value'),
  },
  {
    id: 'docker-auth-field',
    regex: /"auth"\s*:\s*"([A-Za-z0-9+/]{8,}={0,2})"/,
    canary: c('"au', 'th": "', 'd2F0Y2hvdmVyOmNhbmFyeQ=="'),
  },
  {
    id: 'yaml-credential-next-line',
    // Only this pattern crosses lines. Match trimmed adjacent lines, so indentation
    // cannot cause whitespace backtracking. A mapping key is not a credential scalar.
    multiline: true,
    regex: /^(?:[A-Z][A-Z0-9_]*_)?(?:passphrase|password|passwd|token|secret|key|api[_-]?key|access[_-]?key)["']?[ \t]*:[ \t]*(?:[|>][-+]?[ \t]*)?(?:#[^\r\n]*)?\n[ \t]+["']?(?!\[REDACTED|\$|<|\*{3}|#)[^\s"'#,;:]{8,}["']?(?:[ \t]+#[^\r\n]*)?$/i,
    canary: c('pass', 'word: |\n  ', 'watchover-canary-value'),
  },
]);

function* matches(pattern, text) {
  for (const match of text.matchAll(new RegExp(pattern.regex.source, `${pattern.regex.flags}g`))) {
    if (pattern.id === 'docker-auth-field') {
      const decoded = Buffer.from(match[1], 'base64');
      // Docker auth is base64 username:password, not an arbitrary auth mode word.
      if (decoded.toString('base64').replace(/=+$/, '') !== match[1].replace(/=+$/, '') ||
          !/^[\x20-\x7e]+:[\x20-\x7e]+$/.test(decoded.toString('utf8'))) continue;
    }
    yield match;
  }
}

function yamlPair(lines, i) {
  const next = lines[i + 1];
  if (next === undefined || !/^[ \t]+\S/.test(next)) return '';
  return `${lines[i].trim()}\n  ${next.trim()}`;
}

export function scanText(text, file) {
  const findings = [];
  const lines = String(text).split('\n');
  for (const [i, line] of lines.entries()) {
    for (const p of SECRET_PATTERNS) {
      if (!matches(p, p.multiline ? yamlPair(lines, i) : line).next().done) {
        findings.push({ pattern: p.id, file, line: i + 1 });
      }
    }
  }
  return findings;
}

export function selfTest(patterns = SECRET_PATTERNS) {
  const failed = patterns.filter((p) => matches(p, p.canary).next().done).map((p) => p.id);
  return { ok: failed.length === 0, patterns: patterns.length, failed };
}

// Replace every secret-shaped span with a marker naming its pattern, so output can
// point at a problem without repeating the value.
export function redact(text) {
  let out = String(text);
  for (const p of SECRET_PATTERNS) {
    const lines = out.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (p.multiline) {
        if (!matches(p, yamlPair(lines, i)).next().done) {
          lines[i] = `[REDACTED:${p.id}]`;
          lines[i + 1] = '';
        }
      } else {
        let end = 0;
        const parts = [];
        for (const match of matches(p, lines[i])) {
          parts.push(lines[i].slice(end, match.index), `[REDACTED:${p.id}]`);
          end = match.index + match[0].length;
        }
        lines[i] = parts.join('') + lines[i].slice(end);
      }
    }
    out = lines.join('\n');
  }
  return out;
}
