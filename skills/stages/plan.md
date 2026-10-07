# Stage: plan / awaiting decision

Goal: choose the smallest shape that fits, explain why in plain words, and get one clear
decision before anything changes.

## Write the plan

1. `brief.topology`: how the components run and what is exposed.
2. `brief.resource_rationale`: why this shape fits. For each common heavier option (an
   orchestration cluster, a managed database, a load balancer, and so on) add one line to
   `brief.heavier_alternatives` saying why it is not needed now.
3. `plan.tiers`: up to three. Each has its composition, region, cost range with currency
   and period, `price_checked_at`, the load it assumes, and its uncertainty. Set
   `price_checked_at` only when you actually checked a price; otherwise leave it null and
   say so in the uncertainty. Never invent a date or a price.
4. Mark `plan.default_tier`. Keep `brief.assumptions` honest.
5. For a local target, one tier is enough: a cost range of 0 to 0, with the uncertainty
   saying it runs on this machine at no cloud cost. Do not invent a cost to make a gate.

**No resource is created before the gate.** Nothing billable, nothing irreversible,
nothing public, until the human has approved.

## Show the initial plan before execution (early view handoff)

When basic facts and the initial plan are ready, before any dependency install, build,
provisioning or application change:

1. Record facts, assumptions, plan and next step; validate. Stay in `plan`; set
   `activity.waiting_on` and `next.decision_owner` to human.
2. Append an `intent` (action kind `local`) and start `show` for this workspace yourself
   (background process or separate terminal; `--port 0` if the port is taken). Check the
   printed URL serves this workspace.
3. Open the URL when the environment allows, otherwise give it. Guide the human to the task,
   plan, next step and approval scope. Ask them to reply that they can see this page.
4. Wait for that explicit reply. Record it in the `result` of that intent (reply as typed)
   and as a `USER_CONFIRMED` fact `view.page_confirmed` scoped to this workspace. Server
   readiness, an opened browser, silence, a timeout, plan approval or an ambiguous
   "continue" do not count. It is not a gate, so it is not a `decision` event.
5. **If the page is genuinely unreachable**, say why (with the evidence) and offer one
   explicit choice: continue with the limitation disclosed (for example the reply
   "continue with disclosure"). Only that explicit choice releases the plan
   without page confirmation. Record a `BLOCKED` fact `view.page_unreachable` (cause in
   `blocked_by`, evidence of the failure) and the reply as typed in the `result` and in a
   `USER_CONFIRMED` fact `view.continue_with_disclosure`. Refusing a page that does work is
   not this case: keep helping them reach it.

Neither the page reply nor the disclosed-limitation choice approves cost, DNS or deletion;
make the ordinary request below. One reply may cover both only if it says both separately.

## The first request

- If the plan leads to a billable action, plan acceptance and the first billable approval
  are one request: categories `["plan_acceptance", "billable"]`, plus any other gate at the
  same boundary. The plan explanation (brief and tiers) is part of that request.
- If nothing is billable, ask for plan acceptance at the next decision boundary, before the
  first action that changes anything. Combine it with any other gate at that same boundary.
- Fill every `pending_decision` field in plain words: what will be done, the targets, why,
  the cost or blast radius, whether it can be undone and how, how success will be
  confirmed, and the exact replies you accept.
- Append a `stage_change` to `awaiting_decision`; set `waiting_on` to human and
  `next.decision_owner` to human. Then ask in this session. Do not continue on silence.

## After the reply

- Record the reply as a `decision` event exactly as typed, then clear `pending_decision`.
- Preserve the complete sanitized request snapshot linked by request.evidence before
  asking, including requested_at read from the appended event. Follow the router's
  off-option high-risk restatement/confirmation rule; one approval may cover a named batch.
- Approved, with the view handoff confirmed (or the disclosed-limitation choice recorded):
  set `plan.selected_tier`, append a `stage_change` to `executing`, validate, and load
  `stages/execute.md`.
- "change: ...": revise the plan and make a new request with a new id.
- Rejected or deferred: change nothing; set `next` to what the human wants, owned by them.

Examples: an exact "approve B" selects the stated tier without another turn. "You choose"
for a new billable request needs the chosen tier, targets and limits restated, then one
confirmation ("Yes, proceed with that plan" is sufficient). An approved recovery batch
may name stop service S, replace its pinned source and delete/rebuild run resource R;
reuse it only within those limits. Approval to pay for S alone does not cover deleting R.

## Always (from the router)

- Never write a secret value into the record, evidence, logged commands or git.
- Re-verify the facts an action depends on before any write.
- Around every remote-mutating command, gated action or long operation: an `intent` event
  before it and a `result` event after it.
- Use only the seven statuses. Your own claim is never verified without evidence.
- Gates sit at stage boundaries. Ask once when no action separates two gates;
  the plan explanation travels with the first billable request.
