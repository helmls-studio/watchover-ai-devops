# Stage: verifying, handoff, teardown and closed

## Verify by layer

Each layer is its own fact with its own evidence. One layer never proves another:
build ≠ deploy ≠ externally verified.

1. **Build.** The images or artifacts were built.
2. **Deploy.** What runs is the intended version: a deployed-ref fact matching the pin.
3. **Components.** Each component is healthy: one `health.<component>` fact each, scoped to
   its host. One component looking healthy is not the chain working.
4. **Chain.** A request through the real entry point reaches every component and returns.
5. **External.** Only a check made the way users will reach it (a public URL or DNS name)
counts as externally verified. Otherwise record that it is not externally verified.

A manifest establishes declared configuration only. Selected file samples establish only
those files, never complete source verification. Visible IAM bindings do not establish every
planned permission; check the required scope or disclose the unverified remainder. Describe
bounded rollback (what can be restored) and name irreversible effects such as delivered
messages or lost unsaved data; never claim unqualified "Fully reversible".

A "none found" result needs a control. After any change, mark affected facts STALE and
check them again. A verified failure is recorded with `problem: true`, and then you move
to `incident`.

## Handoff

Keep `handoff` complete, so a fresh AI can answer from the record alone:

1. the task: `brief.app_summary` and `next`;
2. the target and environment: `identity`;
3. the current stage;
4. intended and actual source: `pinned_ref` against the deployed-ref fact;
5. the last verified facts, with times and evidence;
6. the stale and unknown facts, listed honestly;
7. the blocker or waiting condition: `activity.waiting_on`, blocking open items, the
   pending decision;
8. the next safe action: `next.action`;
9. the decision owner: `next.decision_owner`;
10. where deeper evidence is: `handoff.read_first` and evidence locators.

Set `last_safe_state`, `rollback_anchor`, `known_unverified` (everything you did not verify)
and `fragile` (what may break, and how you would notice). Then append a `stage_change` to
`handoff`.

Before a new handoff or closed state, pair every intent with a related actual result.
Use `brief` for the open count and full events.jsonl listing locator. Open intents are
valid during execution/interruption. If the result is unknown, use outcome `unknown` and
say what is unknown; for nonexecution/cancellation say so explicitly. Never invent success
or failure. Semantic validation rejects terminal unpaired IDs; preserve sealed history
without migration or automatic repair. These checks do not execute or enforce shell work.

## Teardown

Deletion is a gate. The request lists a teardown inventory: every resource you will delete,
including implicit ones, and what you will leave (pre-existing things). After approval:

Include resources created by humans during this operation. Name deletion approval and
the executing party explicitly: you may ask the human to remove an object, then verify it.
Human origin never authorizes deletion, and pre-existing objects remain outside the plan
unless their specific approved scope includes them.

1. Take an inventory before deleting (read-only, saved as evidence).
2. Delete step by step, with an `intent` and a `result` for each.
3. Take the same inventory again. The first listing is the control for a "none left" fact
   with `negative_result: true`.
4. Mark each resource `deleted`, and append a `stage_change` to `closed`.

## After deployment

`next` says which of these holds, with its owner: kept running (owner none or the human),
waiting for acceptance (human), or waiting for cleanup approval (human). Deployed is not
cleaned up.

## Closed

`activity` states the cleanup that the inventories prove and lists any gap; never claim
the whole project is clean beyond that evidence. `next` says there is nothing more to do,
with no owner.

## Always (from the router)

- Never write a secret value into the record, evidence, logged commands or git.
- Re-verify the facts an action depends on before any write.
- Around every remote-mutating command, gated action or long operation: an `intent` event
  before it and a `result` event after it.
- Use only the seven statuses. Your own claim is never verified without evidence.
- Gates sit at stage boundaries. Ask once when no action separates two gates;
  the plan explanation travels with the first billable request.
