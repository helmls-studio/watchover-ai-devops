# Security

WatchOver keeps a record of a deployment. Its security aims are narrow: secrets never enter
the record, and the view can only read and only locally.

## Secrets

- The rule for the AI, stated in every skill: never write a secret value into state, events,
  evidence, logged commands or git. The record holds secret names and where they are kept.
- `validate` scans `state.json`, `events.jsonl` and every regular file under `evidence/` for
  credential patterns: private keys, cloud keys and tokens, credentials in URLs, and
  `password=`/`token=` style assignments.
- Bounded additional shapes: assigned passphrases and uppercase `*_KEY`/`*_SECRET`
  names with values of at least eight characters; Docker-style JSON `auth` fields that
  decode from canonical base64 to printable ASCII username:password; and a credential
  key followed by one indented, single-token YAML scalar (including `|`/`>` introducers).
  Nested mapping keys are not scalars. General rules scan each line separately; only
  the YAML rule checks adjacent lines. Lowercase generic names, colon-containing or
  multiword YAML values, complex YAML and non-ASCII Docker credentials may be missed.
  This finite shape check is not a YAML parser, credential authentication or complete
  secret coverage. Benign values with a supported credential shape can still be flagged.
- Each pattern has an obviously fake canary. Every validation first checks that every
  pattern still detects its canary, so a clean scan is trusted only when the scanner has
  just shown that it works.
- Every string in validation output, including JSON pointers and file names, is redacted
  through the same patterns. A finding names the pattern, file and line, never the value.
- Append validates an event before writing it, so a secret-shaped event is refused, not
  stored.
- Evidence symbolic links and special files are reported and never followed or read.

## The view

- `show` binds to 127.0.0.1 (loopback) only and is read-only: it answers GET and HEAD, and
  refuses everything else with 405.
- It serves an exact allowlist: the view files, `state.json` and `events.jsonl`. Paths are
  matched as received, so traversal attempts and every other file get 404.
  Evidence is never served.
- Requests must name the loopback address in their Host header, which blocks DNS-rebinding
  pages.
- Responses carry a strict Content-Security-Policy (same-origin only), `no-store` caching and
  `nosniff`. The page loads nothing from the network, uses no browser storage, and escapes
  every recorded value.
- There is no write path from the page to the record or to the AI. The human answers in the
  AI's own session.

## Known limits

- Secret detection is pattern-based. It catches common credential shapes, not every
  possible secret. Redact before saving evidence, whatever the scanner says.
- Persist only necessary nonsecret baseline fields and normalized comparison digests,
  never secret originals. Digests remain private and do not certify sanitization.
- Init's workspace-local ignore guard excludes runtime files from normal containing-repo
  staging. It does not change the host ignore file, untrack files or prevent forced add.
- Basic decisions are AI transcriptions, not authenticated human identity. Validation
  checks request/approval/result references; it does not determine whether arbitrary
  commands or targets were authorized, enforce external shell actions or prove AI obedience.
- Anyone who can read the workspace folder can read the record; it is protected only by
  normal file permissions.
- One AI writes a workspace at a time; there is no file locking.
- The record describes what the AI observed and when. It is not a live reading, and it can
  be wrong if the AI records carelessly; the freshness rules make that visible.

## Reporting

Please report a suspected vulnerability privately to the maintainers of the repository
rather than in a public issue, with steps to reproduce it. Do not include real secrets in a
report.
