# Stage: executing

Goal: carry out the approved plan while keeping the record current enough that anyone
could take over at any moment.

## Each step

1. Re-verify the facts the step depends on: identity, target, the approval, and the
   resources it touches.
2. If it is remote-mutating, gated or long, append an `intent` with the sanitized command.
   A gated intent relates to the approving decision event.

```json
{"actor": {"role": "ai", "name": "ai-deployer"}, "session_id": "session-a", "type": "intent", "summary": "Create the tier B server", "target": "demo-target / region-1", "action": "<provider CLI> create server app-server --size medium", "action_kinds": ["remote_mutating", "gated"], "related": ["evt-0010"]}
```

3. Run it. Save the sanitized output under `evidence/`.
4. Append a `result` related to the intent:

```json
{"actor": {"role": "ai", "name": "ai-deployer"}, "session_id": "session-a", "type": "result", "summary": "Server created", "outcome": "succeeded", "state_change": "Added app-server with its implicit boot disk", "evidence": ["evidence/0013-server-create.txt"], "related": ["evt-0012"]}
```

5. Update `resources`, `facts`, `activity` and `next`, then validate.

## Long operations

An operation expected to take more than 3 minutes is long-running. Before starting it, set
`activity.summary`, `started_at`, `expected_duration` (a range), `slow_reason` if you know
one, and `waiting_on`; include `long_running` in `action_kinds`. Update `last_progress`
only when something real happens. Never invent a percentage or a countdown.

## Resources, names and services

Record every resource with its provider, type, purpose, billable flag, lifecycle and
origin. Include what the provider creates implicitly, such as boot disks, ephemeral
addresses, default rules and service accounts (origin `created_implicitly`), and nest
children under parents (containers and disks under their server). Things that already
existed before this operation and that you rely on are `pre_existing`. Explicit objects
created during this operation by either a human or AI are `created_this_run`; origin is
creation lifecycle, not creator identity. Use existing event actor/summary and resource
purpose to describe human steps, not new label/notes or created_by_human fields. Link each
resource to the fact that verifies it; origin never grants deletion permission.

- `id` is your stable logical id; `name` is the name the provider actually returned,
  read from its output (implicit ones too). Never assume two names match.
- A value copied from a manifest or config file is only *declared*: at most VERIFIED_LOCAL,
  scoped "declared in <file>". Only an observation of the running thing that answers the
  same question makes the runtime fact VERIFIED_REMOTE.
- Each component's service status is one `health.<component>` fact (class `health`, window
  at most 60 minutes) whose `scope` starts with its host resource id. Update the same key;
  never add a second one. "Present" or "container running" is not "serving".
- A resource you stop observing keeps its history; it is `deleted` only with evidence.

## Shared objects

Before changing something shared with other users (project metadata, access policy,
enabled APIs, shared configuration), retain only necessary nonsecret fields/identifiers
and normalized digests for the relevant baseline. Redact before saving; never persist secret
originals. Digests are private material, not proof of complete sanitization. Apply the same
selection/normalization before and after; keep enough nonsecret detail to verify the delta.
Record exactly what you add/change. Undo only that delta, with approval. If preservation
cannot be proved, that fact is UNKNOWN, not clean.
Never reset or disable a whole shared object to undo your part.

## When things change course

- A failure that changes the plan: append `plan_failure`, then a `stage_change` to
  `incident`, and load `stages/recover.md`. Do not retry blindly.
- Reaching a new gate (DNS or public release, deletion, something destructive, an
  unplanned cost): stop and request a decision.
- Done: append a `stage_change` to `verifying` and load `stages/verify-handoff.md`.

## Always (from the router)

- Never write a secret value into the record, evidence, logged commands or git.
- Re-verify the facts an action depends on before any write.
- Around every remote-mutating command, gated action or long operation: an `intent` event
  before it and a `result` event after it.
- Use only the seven statuses. Your own claim is never verified without evidence.
- Gates sit at stage boundaries. Ask once when no action separates two gates;
  the plan explanation travels with the first billable request.
