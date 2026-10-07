# WatchOver router

Read this first in every session. It tells you what to record about a deployment, when,
and how, so that a human and any later AI share one honest record. It does not teach
deployment.

## The loop (every action)

1. **Intent.** Before anything that changes something remote, is gated or runs long, append
   an `intent` event with the sanitized command and its approval, if any.
2. **Action.** Run it. Read-only checks need no intent.
3. **Result.** Append a `result` related to the intent; save sanitized output in `evidence/`.
4. **State.** Update `state.json` from what was observed (facts, resources, `activity`, `next`).
5. **Validate.** Run `validate` (or `commit-state`) and fix every problem before moving on.

## The record

- `<repo>` is the folder that contains this `skills/` folder. The tool is
  `node <repo>/tools/watchover.mjs`; the schemas are in `<repo>/schema/`.
- The workspace is one folder, normally `watchover/` inside the project being deployed:
  `state.json`, `events.jsonl`, `evidence/` and a pointer `README.md`.
- `state.json` is the only current state. Keep it short and overwrite it in place.
- `events.jsonl` is the history. Only ever add to it, one event at a time, with the tool.
- `evidence/` holds sanitized command output. Refer to it by locator, such as
  `evidence/0013-vm-create.txt`; never paste raw output into state or events.
- Start the read-only view yourself during initial planning (early view handoff below).
  The human confirms and answers in this session; the page itself grants no approval.

## Start of every session

1. Find the workspace. `node <repo>/tools/watchover.mjs brief <workspace>` prints a short summary to orient you; then
   read `state.json` in full before acting.
2. Read only recent events (the last 20 lines of `events.jsonl`) unless you need more. Open evidence only when a locator
   sends you there.
3. No workspace yet? Create one: `node <repo>/tools/watchover.mjs init <project>/watchover --project <alias> --environment "<where>" --provider <gcp|aws|azure|nectar|local> --session <session-id>`
4. Load only the stage file for `state.stage`, plus an optional provider file; local needs none.

On continuation, check the existing view URL over loopback and read its `state.json` to confirm this workspace's
identity. If missing or unreachable, start the existing `show` command for the same workspace, check its actual URL and
give it to the human. A process start or remembered page reply does not prove current reachability. Reuse this
workspace's valid page confirmation and existing deployment approvals; do not ask for them again. If restoration fails,
disclose the observed failure and let the human explicitly choose continuation with that limitation. Read-only
reconciliation may proceed while restoring the view; external mutation still needs current facts and valid scope
approval.

| `state.stage` | Load |
|---|---|
| recon | `stages/recon.md` |
| plan, awaiting_decision | `stages/plan.md` |
| executing | `stages/execute.md` |
| verifying, handoff, teardown, closed | `stages/verify-handoff.md` |
| incident, recovered | `stages/recover.md` |

Provider files add provider-specific steps and examples; the rules in this router and the
stage files apply to every target. `providers/gcp.md` (validation pending), `providers/dns-cloudflare.md`, `providers/aws.md`,
`providers/azure.md`, `providers/nectar.md` (all UNVALIDATED). A local target needs no provider file.

**A referenced file is missing?** A package may ship without some stage or provider files; a deliberately reduced one
lists them in `skills/package-omissions.json`. Say so once (an `open_items` entry naming the file and its impact), then
continue with this router's loop, the generic stage rules, live evidence and the provider's official documentation. A
missing file never grants a permission, removes a gate or fills a fact.

## Early view handoff

Once you have the basic facts and an initial plan, and before any dependency install, build, provisioning or application
change: record them, start `node <repo>/tools/watchover.mjs show <workspace>` yourself (`--port 0` if the port is
taken), give the actual URL, guide the human to this task's page and wait for their explicit reply that they can see it.
Silence, a running server or an ambiguous "continue" is not that reply. Only if the page is genuinely unreachable may
the human choose, explicitly, to continue with the limitation disclosed. Neither the page reply nor that choice approves cost, DNS or
deletion. The steps and the records are in `stages/plan.md`; a continuation reuses the confirmation of this
workspace only.

## Writing the record

- **Events.** `node <repo>/tools/watchover.mjs append <workspace>` reads one JSON event on standard input (or `--file event.json`). It fills in `schema_version`, `id` and `at` when you leave them out, and prints the id. Exit 0: appended
  and consistent. Exit 2: appended; now update `state.json` to match. Exit 1: refused, nothing written; fix and retry.
- **State.** Write the new state to a candidate file and run `node <repo>/tools/watchover.mjs commit-state <workspace> --file <candidate.json>`: it validates the candidate against the events and evidence and replaces `state.json` only if
  everything passes. Editing `state.json` in place, then `node <repo>/tools/watchover.mjs validate <workspace>`, also
  works. Either way update `identity.updated_at` and `identity.updated_by` and fix every problem reported.
- **Order.** Append the event first, then update the state, then validate.
- **Stage changes** are events too. Append one, then set `state.stage`:
```json
{"actor": {"role": "ai", "name": "ai-deployer"}, "session_id": "session-a", "type": "stage_change", "summary": "Recon finished; preparing the plan", "stage": {"from": "recon", "to": "plan"}}
```
## Fact statuses: use exactly these seven

| Status | Use when | Source |
|---|---|---|
| ASSUMED | you hold a value you have not checked | reasoning |
| USER_CONFIRMED | the human told you; never upgrade it yourself | human |
| VERIFIED_LOCAL | a local check established it, with evidence | local_check |
| VERIFIED_REMOTE | a remote or live observation established it, with evidence | remote_observation |
| STALE | it was verified, but its window passed or something changed it | the original check |
| UNKNOWN | relevant but not determined, or the check was inconclusive | any |
| BLOCKED | cannot be checked now; say what is missing in `blocked_by` | any |

- Your own claim of success is never VERIFIED_* without an evidence locator.
- **To verify a fact:** save sanitized output, append `fact_verified` omitting `at`, read its CLI-filled `at` from
  events.jsonl, then set `checked_at` to that exact time and use the same evidence list. An explicit `at` must not
  precede the previous event.
```json
{"actor": {"role": "ai", "name": "ai-deployer"}, "session_id": "session-a", "type": "fact_verified", "summary": "Confirmed demo-app-vm is RUNNING", "fact": {"key": "compute.vm_exists", "status": "VERIFIED_REMOTE"}, "evidence": ["evidence/0014-vm-describe.txt"]}
```
- Every fact has a `scope` and a `fresh_for_minutes` no longer than its class allows: identity 1440, permission 240,
  resource 240, health 60, source 1440, price 43200, network 240, other 1440.
- A "none found", "zero" or "clean" result sets `negative_result: true` and names the `control` that showed the same
  check can find something. Without a control, it is not verified.
- When a window ends, or something you did may have changed the fact, set it to STALE and keep its `checked_at` and
  evidence. Never treat STALE or UNKNOWN as current.
- `problem: true` marks a verified observation that shows something wrong.
- Label the checked subject neutrally ("Service response", not "Service works"). Value, verification and problem are
  separate: a reliable false value can be healthy.

## Rules that always apply

1. **Secrets.** Never write a secret value into state, events, evidence, logged commands or git. Record only secret
   names and where they are kept. Redact values from output before saving it as evidence. Validation scans for secrets;
   fix any finding before anything else.
2. **Re-verify before any write.** Before an action that changes anything, re-verify the facts it depends on. Never act
   on a STALE or UNKNOWN fact as if it were current.
3. **Log every remote-mutating command.** Before any command that creates, changes or deletes a remote resource,
   including changes made over a remote shell, append an `intent` event with the sanitized command; afterwards append a
   `result` related to it. Do the same around every gated action and every operation expected to take more than 3
   minutes (also set `activity.expected_duration`). Read-only commands may be logged; they need not be.
4. **Gates sit at stage boundaries, never on each command.** Ask the human at: plan acceptance; the first billable or
   irreversible action; external release (public DNS or URL); every deletion or destructive action. One approval may
   cover a specified batch. When no action separates two gates, ask once; approval never expands beyond its scope. The
   plan explanation (what the app is, its components, the chosen shape and why, the tiers and the default tier) goes
   into the first billable request. With no billable gate, ask for plan acceptance at the next decision boundary, before
   anything changes.
5. **You explain; the human decides.** Only an approved decision authorizes a gated action.
6. **Keep `activity` and `next` current**: what is happening in plain words, when it started, the expected range, what
   you are waiting on, the last real progress, the next step and who owns it. Never invent progress.
7. **Never write a second state.** One workspace per deployment; repair it, never fork it.
8. **Names, services, shared objects, interruptions** (rules in the stage files, for every target): logical id vs real
   name, declared vs observed, `health.<component>` facts and shared-object deltas in `stages/execute.md`; interruptions
   in `stages/recover.md`; the owner after deployment in `stages/verify-handoff.md`.

## Asking for a decision

1. Prepare the complete sanitized request snapshot under `evidence/dec-01-request.json`: all pending fields below,
   including categories, limits, irreversible parts and options. Append `decision_request` omitting `at`, linking the
   snapshot with `evidence`:
```json
{"actor": {"role": "ai", "name": "ai-deployer"}, "session_id": "session-a", "type": "decision_request", "summary": "Asked to accept the plan and approve tier B", "request": {"id": "dec-01", "categories": ["plan_acceptance", "billable"]}, "evidence": ["evidence/dec-01-request.json"]}
```
2. Read the appended request's `at`; use it as `requested_at` in the snapshot and `pending_decision` before asking. Keep
   the same `id` and `categories`, plus: `action`, `targets`, `why`, `cost_or_blast_radius`, `reversibility`,
   `rollback`, `success_check` and `reply_options` (concrete choices). Validate; retain the snapshot after clearing
   pending.
3. Ask in this session, briefly, and say exactly what to reply.
4. Record the reply as typed (redact a secret value only), relate it to the request, then set `pending_decision` to null
   and validate:
```json
{"actor": {"role": "human", "name": "operator"}, "session_id": "session-a", "type": "decision", "summary": "Operator accepted the plan and tier B", "decision": {"request_id": "dec-01", "reply": "approve B", "redacted": false, "outcome": "approved"}, "related": ["evt-0009"]}
```
5. A gated `intent` lists that approving decision's event id in `related`. Recover scope via decision.related →
   request.evidence, not old chat. Missing historical snapshots mean scope is unavailable; disclose that rather than
   inventing it.
6. For a new billable, delete/destructive or DNS request, off-option delegation ("you choose") needs a short restatement
   of the concrete choice and scope and one explicit confirmation before recording approved. Natural language
   confirmation is valid; exact selections need no extra turn. Preserve the original reply in decision.reply; if a
   confirmation was needed, retain it with the restatement as sanitized decision evidence. Do not reinterpret or rewrite
   older valid approvals. These are guidance rules, not an automated judge of arbitrary commands or targets; validate
   only checks record links.
