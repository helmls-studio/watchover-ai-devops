# Architecture

WatchOver has one source of truth, one history, one read-only view, and instructions that
tell an AI how to keep them. Everything runs locally.

```
AI session ──writes──▶ state.json        (bounded current state, overwritten in place)
           ──appends─▶ events.jsonl      (append-only history, one event per line)
           ──writes──▶ evidence/         (sanitized raw output, referenced by locator)
read-only view ◀──reads── state.json + events.jsonl        (never evidence/)
Human ◀──reads── view            Human ──answers──▶ AI session (the only channel)
```

## The record (a workspace folder)

- `state.json`: the only current state. It covers identity, stage, activity, brief, plan,
  pending decision, resources (as a tree), source, facts with status and freshness,
  secret names, open items, next step and handoff. It is shaped by
  `schema/state.schema.json`.
- `events.jsonl`: the history. It records stage changes, intents and results around
  remote-mutating or long work, decision requests and decisions, fact promotions, and plan
  changes after failures. It is shaped by `schema/event.schema.json`.
- `evidence/`: command output, sanitized, pointed to by `evidence/...` locators.
- `README.md`: a plain pointer telling a fresh AI to start at `skills/router.md`.

## Capabilities (`tools/watchover.mjs`)

- `init`: builds and validates the first state and stage event before writing, into an
  empty folder only.
- `append`: adds one event after validating the log as it would be; it never rewrites
  earlier bytes (`tools/lib/workspace.mjs`).
- `commit-state`: validates a candidate state against the current events and evidence
  (all checks, plus that every cited evidence file exists), writes it to a temporary file
  in the same folder, flushes it, re-checks that `state.json` and `events.jsonl` are
  unchanged, then renames it into place (`tools/lib/commit.mjs`). Single writer per
  workspace; there is no cross-file transaction. Editing `state.json` by hand still works.
- `brief`: validates the record, then prints a read-only summary of at most 30 lines
  (`tools/lib/brief.mjs`); it writes nothing and stores no second summary.
- `validate`: `tools/lib/validate.mjs`. It runs the scanner canary self-test, loads the
  schemas fail-closed through a small supported subset (`tools/lib/schema-subset.mjs`),
  secret-scans every readable file including evidence, checks size, JSON and schema, then
  runs named cross-field checks (`tools/lib/semantic-checks.mjs`). All output is redacted.
- `show`: `tools/lib/server.mjs` serves `app/web-ui/` plus the two record files on
  127.0.0.1.

## The view (`app/web-ui/`)

`render.mjs` turns state, events and the clock into escaped HTML answering six questions:
what, where, why, decision, trust and next. `freshness.mjs` decides what counts as current:
only a VERIFIED fact inside its own freshness window, computed from the clock, never
upgraded. `app.js` re-reads the record every few seconds and shows an error instead of
content when a file is missing or malformed.

## Instructions (`skills/`)

`skills/router.md` is read first. Load one stage file (`skills/stages/`) and, only when
needed, an optional provider profile (`skills/providers/`). A local target needs no provider
file, cloud account or SDK. The skills are generic markdown and rely on no client auto-loading. `integrations/catalog.json` lists optional official tools, each with
a CLI fallback.

## Trust boundaries

- **Source of trust.** A human statement is USER_CONFIRMED; a local check with evidence is
  VERIFIED_LOCAL; a remote observation with evidence is VERIFIED_REMOTE; reasoning is
  ASSUMED. The AI's own success claim is never verified without evidence. The validator
  enforces these pairings and that every verified or stale fact matches its latest
  promotion event.
- **Decisions.** Authority runs AI → human → AI. The view shows the pending decision and
  says where to reply; it cannot approve or send anything. Gated actions must relate to an
  approved decision.
- **The view boundary.** Loopback only, read-only, allowlist only, evidence never served, no
  network dependencies (see `SECURITY.md`).
- **Secrets.** They are outside the record entirely; the scanner and redaction are a
  backstop, not a vault.

## Not in scope

WatchOver is not a cloud console, not an orchestrator, not continuous monitoring, and not a
per-command approval engine. It has no daemon on any target and no second state.
A local writer for human input and a guarded reviewer mode are deferred and not built.
