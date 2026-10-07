# Stage: recon / preflight

Goal: understand what is being deployed, from where, and to where, without changing
anything.

**Read-only.** No billable action, no resource creation, no configuration change. If a
check would change something, it belongs in a later stage.

Fill in the state as you go, recording each check as a fact with evidence:

1. **Brief.** `app_summary` in one or two plain sentences, and every component with its
   role. Leave `topology` and `resource_rationale` for the plan stage.
2. **Source.** For each repository: its `remote`, the `pinned_ref` you intend to deploy,
   and a fact for local changes: uncommitted local changes, including untracked files, with
   a one-line `local_changes_summary`. A "none found" result needs a control, for example
   the same command reporting a file you planted in a scratch copy. The deployed ref is an
   UNKNOWN fact until something is deployed.
3. **Identity.** The account, project or subscription the tools are using, the target
   region, and whether that identity has the permissions the plan will need. Check them;
   do not assume. What the human tells you is USER_CONFIRMED, never VERIFIED_*.
4. **Secrets.** The secret names the app needs, where each is kept, and whether each is
   usable, blocked or missing. Do not print a value to check that it exists.
5. **Blockers.** Anything that cannot be checked yet (a disabled service, missing access)
   is a BLOCKED fact with `blocked_by`, and usually an open item owned by the human.
6. **Assumptions.** Anything you infer, such as expected traffic, is ASSUMED with the
   reasoning in `scope`, and also listed in `brief.assumptions`.

Keep `activity` short and current; while you work, `waiting_on` is the AI.

When recon is complete, append a `stage_change` to `plan`, set `state.stage`, validate,
and load `stages/plan.md`.

## Always (from the router)

- Never write a secret value into the record, evidence, logged commands or git.
- Re-verify the facts an action depends on before any write.
- Around every remote-mutating command, gated action or long operation: an `intent` event
  before it and a `result` event after it.
- Use only the seven statuses. Your own claim is never verified without evidence.
- Gates sit at stage boundaries. Ask once when no action separates two gates;
  the plan explanation travels with the first billable request.
