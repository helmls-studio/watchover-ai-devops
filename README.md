# WatchOver AI DevOps

WatchOver is a lightweight local workbench that keeps a human and an AI deployer on one
shared, freshness-honest record of a deployment. The AI keeps a short current state and an
append-only event history. A read-only page that refreshes by itself lets the human see, at
any moment, what is being built, where it stands, why this plan, what needs their decision,
what can be trusted, and what happens next. A fresh AI can continue from the same record
without replaying the conversation.

Its record model is provider-independent: intent, approvals, state, evidence, freshness
and continuation use the same structure. Commands, identity and permissions differ by
cloud. Provider files add optional steps and examples; local usage needs no provider file,
cloud account or SDK.

It is not a cloud console, a CI/CD product, an orchestration service, a secret vault or a
monitoring system. It records and explains; the human decides, in the AI's own session.

> Status: v0.1.2 public-edition candidate, a local prototype. See
> **Validated**, **Development evidence** and **Roadmap** below before relying on it.

## How it fits together

- `skills/router.md`: plain-markdown instructions an AI reads first. They say what to record
  and when; they do not teach deployment. Stage files and provider profiles sit beside it.
- `schema/`: the state and event schemas.
- `tools/watchover.mjs`: initialize, append, commit a candidate state (`commit-state`),
  validate, summarize (`brief`, at most 30 lines, read-only) and show a workspace. It needs
  Node.js 22 or later, with no dependencies.
- `app/web-ui/`: the read-only view.
- `integrations/catalog.json`: official tools an AI may use; nothing is loaded by default.

## Quick start

```sh
node tools/watchover.mjs init my-project/watchover --project demo-app --environment "local trial" --provider local --session session-a
echo '{"actor":{"role":"ai","name":"ai-deployer"},"session_id":"session-a","type":"intent","summary":"List the project files (read-only)","target":"my-project","action":"ls my-project","action_kinds":["read_only"]}' | node tools/watchover.mjs append my-project/watchover
node tools/watchover.mjs validate my-project/watchover
node tools/watchover.mjs brief my-project/watchover
node tools/watchover.mjs show my-project/watchover     # then open http://127.0.0.1:7431/
```

Point the AI at `skills/router.md` and it keeps the record from there. After it understands
the basic facts and prepares an initial plan, the AI starts the view service, opens or links
the actual local URL, and guides you to the task and plan. It waits for your explicit
confirmation that you can see the HTML page before proceeding beyond planning. Dependency
installs, builds and deployment actions wait until then; billable actions, DNS and deletion
still require their own stated approvals. You do not need to start the view service yourself.
If the page genuinely cannot be reached, the AI says why and continues only if you explicitly
choose to continue with that limitation disclosed; silence or a plain "continue" is not that.

On continuation the AI checks the actual URL against the same workspace, restarts `show`
when needed and supplies its reachable URL or discloses failure. A valid prior page reply
and deployment approval can be reused; neither proves the view is reachable now.

## Record scope and local checks

Basic decisions are AI transcriptions of replies in the session, not authenticated human
identity. Before asking, retain the complete sanitized request in `evidence/` and link it
from `decision_request.evidence`; `decision.related` and the original `decision.reply`
preserve the route back after pending is cleared. For new billable, delete/destructive or
DNS off-option delegation, restate the concrete choice and scope and get one explicit
confirmation. A named recovery batch may share one approval; stopping a serving service,
replacing deployed source or deleting/rebuilding an existing resource needs scope coverage.
Validation checks links, not arbitrary action/target authorization or actual shell execution.

Omit event `at` in normal examples and let append fill it. For a fact promotion or request,
read the appended event time and use that exact time for `checked_at` or `requested_at`.
Earlier explicit times are refused; equal times remain valid. Exit 1 means refused/invalid,
2 means written but needs attention, and 64 means malformed usage. Append exit 2 has already
added an event; commit-state exit 2 has replaced state.json and failed its post-check.
Root `--help` and `-h` return usage and 0.

Brief remains read-only and at most 30 lines. It counts open intents and points to the
complete listing in events.jsonl (intent IDs without any result's related reference).
Open intents are valid while executing or interrupted. New handoff/closed records require
a related actual result for each intent: use outcome `unknown` with a truthful explanation
for unknown execution, nonexecution or cancellation. Version 0.1.2 adds this semantic check;
an old sealed record with an open intent may now fail validation. Preserve its bytes; do
not automatically migrate, repair, or fabricate results.

New workspaces contain their own `.gitignore` guard: normal Git staging in a containing
repository excludes record files, including evidence. It leaves the host root ignore file
alone, does not untrack existing files, and cannot prevent `git add -f`.

For shared-object baselines, select only necessary nonsecret identifiers/fields, normalize
consistently and hash that projection privately. For example, for synthetic access bindings:

```js
const projectBaseline = (bindings) => bindings
  .map(({ principal, role }) => ({ principal, role }))
  .sort((a, b) => a.principal.localeCompare(b.principal) || a.role.localeCompare(b.role));
// Hash JSON.stringify(projectBaseline(before/after)) with SHA-256 locally.
// Persist this nonsecret projection and digest, never discarded credential fields.
```

An equal projection/digest only compares these fields; it cannot establish unseen fields
or complete sanitization. Digests remain private. All provider profiles use this same rule.
Human-created resources in this operation use `created_this_run`, with human event actor
and descriptive purpose; they belong in cleanup planning with explicit approval and party.
A manifest, selected file samples and complete actual verification are different evidence
layers. Visible IAM bindings alone do not prove all planned permissions. Describe rollback
within its bounds and list irreversible effects rather than claiming full reversibility.

## Validated

Independent acceptance of the source version 0.1.2 covered the approved local contract on
macOS arm64 with Node 26.8.1. This public edition changes packaging, documentation and
synthetic wording and requires its own exact-candidate review. Local automated checks cover:

- state and event schemas, fail-closed validation, finite secret patterns with canaries
  and redacted output, and meaningful valid/invalid synthetic fixtures;
- initialization, append, timestamp refusals and complete open-intent handling;
- candidate state replacement and read-only brief, including retained request locators;
- the loopback server and actual headless-browser view, freshness, errors and continuation;
- required guidance and records that validate when constructed as instructed.

Guidance tests do not establish AI obedience. The commit-state exit 2 path was checked
through a test-only injected post-check failure; it was not independently triggered in
ordinary operation. Other operating systems, Node versions and cloud profiles remain
unverified. Node 22 or later is the declared runtime requirement, not a tested version
matrix. See [validation and limits](docs/validation.md) and [security](SECURITY.md).

## Development evidence

Development used three experimental stages, W1, W2 and W3, on GCP. W2 included two runs;
both formal arm verdicts were INVALID. The final stage was a single Basic-mode observation
with unresolved evidence limits, not a controlled causal proof. These are historical
development records. They do not establish cloud validation of current 0.1.2, every cloud
profile, a performance improvement or a causal benefit. No experiments are rerun by this
package. See [provenance](docs/provenance.md) for the public archive status.

## Roadmap

- The optional GCP profile remains validation pending for the current product contract.
- Cloudflare DNS, AWS, Azure and Nectar profiles remain UNVALIDATED.
- A local writer for human input and a guarded reviewer mode are deferred and not built.

## Built through HELM

WatchOver was built entirely through HELM's council, executor and operations workflow.
AI roles handled design, implementation and independent review; a human set the goals,
routed messages and approved actions. The human manually carried messages between roles;
this was not automatic inter-agent communication or unattended governance.

The [public process workbench](https://github.com/desxyx/helm-ai-orchestration-workbench)
describes HELM. The detailed WatchOver case is in preparation. Planned routes under
`council/task/ai-cicd/` in that workbench are:

- Council conversations: `sessions/`, with decisions linked from `council-records/`.
- Executor and Reviewer work: `execution-records/`.
- Operations and handoffs: `operations-records/`.

These are pending archive routes, not published deep links. The records will be translated,
redacted derivatives, not original unedited transcripts. See [provenance](docs/provenance.md).

## More

- [Security](SECURITY.md): secret handling, the view boundary and known limits.
- [Architecture](docs/architecture.md): components and trust boundaries.
- [Design decisions](docs/design-decisions.md): retained product choices and reasons.
- [Validation](docs/validation.md): local coverage and evidence limits.
- [Provenance](docs/provenance.md): HELM attribution and planned case archive.
- [Agent Run Recorder](https://github.com/helmls-studio/agent-run-recorder): a separate
  related tool, not a dependency or evidence of WatchOver validation.

## License

MIT. See [LICENSE](LICENSE).
