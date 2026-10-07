# Stage: incident and recovered (a side path from any active stage)

Enter here when something failed, behaves unexpectedly, or the record and reality may
disagree. Append a `stage_change` to `incident` first.

1. **Read the state first**, then re-verify live facts before acting: what is actually
   running, reachable and configured now. Mark facts STALE when they may no longer hold,
   and UNKNOWN when you cannot tell.
2. **Reconcile.** A resource that exists but is missing from the record gets added, with
   its origin and a fact. A resource in the record that is gone gets its lifecycle and fact
   updated. Never delete something just to make the record tidy.
3. **Separate diagnosis from established fact.** A cause you infer is ASSUMED (source
   reasoning), with the evidence you read. Only a check that proves it makes it verified.
4. **Decide the fix.** If it changes the plan, append `plan_failure`. If it needs a gate
   (deletion, something destructive, extra cost), request a decision and wait.
   Recover the full approved scope via decision.related → request.evidence. Stopping a
   serving service, replacing deployed source or deleting/rebuilding an existing run
   resource must be covered; otherwise ask once for the concrete recovery plan and limits.
   A prior plan/billable approval does not authorize newly required deletion. A covered
   batch needs no per-command approval or arbitrary downtime threshold. Private temporary
   diagnostic cleanup is distinct from destructive remote or business actions.
5. **Fix** with an `intent` and a `result`, as in any other stage.
6. When the failure is resolved, append a `stage_change` to `recovered`. Then go
   back to verifying (another `stage_change`) and re-check every affected layer:
   recovered is not verified.

## After an interruption

Read the existing brief and state; restore the same workspace view as the router directs.
Check the actual URL and workspace identity, restarting `show` if needed, then give the URL.
A prior page confirmation is reusable but is not current reachability evidence. If it
cannot be restored, disclose the failure and wait for the human's explicit choice to
continue with that limitation. Read-only reconciliation may continue in the meantime;
do not create another workspace or repeat already valid deployment approvals.

A session can end mid-step, and a killed AI may record nothing. Whoever notices the
interruption, at the last moment it can write or at resume, records it in the existing
fields: `handoff.last_safe_state` (the last state known good), `activity` (what was running,
`waiting_on`) and `next` (the first check and its owner). On resume, first find any `intent`
without a matching `result` and check its target live. Never redo the last step blind.

Add anything that stays fragile to `handoff.fragile`.

Never create a second state or a second workspace. Repair the one you have.

## Always (from the router)

- Never write a secret value into the record, evidence, logged commands or git.
- Re-verify the facts an action depends on before any write.
- Around every remote-mutating command, gated action or long operation: an `intent` event
  before it and a `result` event after it.
- Use only the seven statuses. Your own claim is never verified without evidence.
- Gates sit at stage boundaries. Ask once when no action separates two gates;
  the plan explanation travels with the first billable request.
