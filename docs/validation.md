# Validation and limits

## Current local contract

Independent acceptance of the source version 0.1.2 covered its approved local contract
on macOS arm64 / Node 26.8.1. The English public edition requires separate review of its
exact candidate. Run `npm test` from the repository root for the retained product suites.
They use synthetic data and installed local tools; they do not run deployments.

The suites cover schemas and bounded records, semantic checks, finite secret scanning and
redaction, CLI writes and refusals, decision-request readback, brief output, loopback HTTP,
freshness and the read-only view in a real headless browser. The browser suite uses an
existing Python Playwright installation; `WATCHOVER_PYTHON` selects its interpreter.
See the test output for actual environment, failures and any tool gaps.

## Evidence boundaries

- Skill wording and constructed-record checks are guidance coverage, not proof that an
  AI will comply, authenticate a human or obtain permission for arbitrary commands.
- Basic approvals are AI transcriptions of replies. Request snapshots preserve what was
  asked; they do not authenticate who replied or enforce external shell actions.
- The commit-state exit 2 check uses a test-only injected post-check failure after real
  replacement. Independent review did not trigger it in ordinary operation.
- Synthetic fixtures describe supported record states. A manifest or selected sample is
  not complete runtime verification; current permission bindings do not prove every
  permission in a plan. Freshness describes recorded observations, not live monitoring.
- Finite secret patterns can miss credentials or flag benign text. No complete security
  or data-loss-prevention certification is claimed; see [Security](../SECURITY.md).
- Other operating systems, Node versions, cloud profiles and actual AI obedience remain
  unverified. The declared Node >=22 requirement is not a tested support matrix.

## Historical development evidence

Three experimental stages, W1-W3, used GCP. W2 included two runs, and both formal arm
verdicts were INVALID. The final stage was a single Basic-mode observation with unresolved
evidence limits, not a controlled causal proof. These historical records do not validate
the current 0.1.2 product or every cloud profile, and support no measured performance or
causal-benefit claim. This edition contains no experiment procedures or raw run archives.
The translated, redacted case archive is now published; see [Provenance](provenance.md).

## Provider-independent records

Intent, approvals, state, evidence, freshness and continuation share one record model.
Commands, identity and permissions differ by cloud. The recorder, schema and UI need no
cloud account or SDK. Local usage needs no provider file. GCP guidance is optional and
validation pending for the current contract; Cloudflare DNS, AWS, Azure and Nectar remain
UNVALIDATED. Historical use of GCP does not change those profile statuses.


## Public-content checks

Product tests always check generic personal account paths and product wording. Historical
stage labels are allowed only in README, validation and provenance; skills and other files
retain the stricter guard. Neutral canaries exercise these checks without publishing
private names. Runtime credential patterns and their canaries are separate and unchanged.

For a release-specific private-identity check, point `WATCHOVER_PRIVACY_DENYLIST` at a UTF-8
file outside the product, then run `npm test` or `node --test tests/vocabulary.test.mjs`.
The file contains one case-insensitive substring per line; blank lines and lines starting
with `#` are ignored. Prefix a term with `word:` when only a whole-word match is intended.
The configured file must resolve outside the product and contain nonempty terms; missing,
unreadable, inside-product or empty inputs fail the check. Never commit or publish it.

The check covers tracked paths and text, common Unicode/hex escapes and adjacent quoted
fragments. Only the exact approved public URLs in designated documents are exempted.
Without the variable, the test reports that only generic guards ran; it cannot claim that
private identities were checked. This optional finite check is not universal DLP. Release
review still inspects the full file/archive manifest and Git metadata separately.
