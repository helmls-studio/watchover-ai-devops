# Provider: Google Cloud (GCP)

Status: the first provider profile under validation, **validation pending**. These notes
illustrate the generic rules for GCP; they have not yet been exercised end to end against a
real project. Check each command against the current `gcloud` reference before relying on it.

`provider_profile`: `gcp`. Use the project's own region; the examples use `us-central1`.

## Identity and access (recon, read-only)

- Active account and project: `gcloud config list --format=json` and `gcloud auth list`.
  These give the `identity` facts, with the output saved as evidence.
- Permissions the plan needs:
  `gcloud projects get-iam-policy <project> --flatten=bindings --filter="bindings.members:<account>" --format="value(bindings.role)"`.
  If you cannot read the policy, the fact is BLOCKED, not assumed.
- Billing: `gcloud billing projects describe <project>`. If access is denied and the human
  says billing is on, that is USER_CONFIRMED.
- Enabled services: `gcloud services list --enabled`.
- Quotas: `gcloud compute regions describe <region>`. If the Compute Engine API or the
  quota service is not enabled, the quota fact is BLOCKED with that reason.

## Secrets

- Names: `gcloud secrets list`. Existence: `gcloud secrets versions list <name>`.
- Never run `gcloud secrets versions access` to print a value. Let the app read the value at
  runtime, and record only the secret's name and location.

## What to record as resources

- A Compute Engine VM is billable. Its boot disk is created implicitly and is billable; it
  is a child of the VM. Record the disk's actual name from
  `gcloud compute instances describe <vm> --format="value(disks[].source)"`; it need not
  match the VM's. An ephemeral external IP is created implicitly as a child. Firewall
  rules you add are `created_this_run`. The `default` network is usually `pre_existing`.
- Containers running on a VM are children of that VM and are not billable in themselves.
- Inventory (read-only): `gcloud compute instances list`, `gcloud compute disks list`,
  `gcloud compute addresses list`, `gcloud compute firewall-rules list`. Filter by the
  run's name prefix, for example `--filter="name~^demo-app"`.

## Remote-mutating commands (intent before, result after)

- Any `gcloud` command whose verb creates, deletes, updates, adds, removes, sets, resizes,
  starts or stops something.
- `gcloud compute ssh <vm> --command='...'` when the command changes the VM, and
  `gcloud compute scp` to the VM.
- Log the command sanitized: no access tokens, keys or passwords. Refer to secrets by name.
- The first billable action needs the approved request. It may be a static address or a
  disk rather than a VM.
- Shared objects (see `stages/execute.md`): project metadata
  (`gcloud compute project-info describe`), IAM policy (`gcloud projects get-iam-policy`) and
  enabled APIs (`gcloud services list --enabled`) are the baselines. `gcloud compute ssh`
  may add an SSH key to project or instance metadata by itself: record it as intent/result
  and include it in the delta. Do not disable an API you enabled until its other users are
  checked and the human approves.

## Prices

Use the official pricing pages or calculator. Set `price_checked_at` only when you
actually looked; otherwise leave it null and say so in the tier's uncertainty. Egress,
static addresses and snapshots are easy to forget; list them as uncertainty if unpriced.

## Verification notes

- The VM exists and is running: `gcloud compute instances describe <vm> --zone=<zone> --format="value(status)"`.
- Reachability from outside needs the firewall rule and the external IP. Reaching the app
  from the VM itself does not verify external reachability.

## Teardown

- Deleting an instance deletes its boot disk only when auto-delete is on. Check with
  `gcloud compute instances describe`, and list the disk in the inventory either way.
- Also delete the static addresses, firewall rules, images and buckets you created.
- Take the "after" inventory with the same list commands and filters as the "before" one;
  the "before" listing is the control.

Baseline/permissions: use the generic nonsecret fields and private normalized digests
from `stages/execute.md`; never retain secret originals. Visible bindings alone do not
prove all planned permissions; check the required scope or disclose what is unverified.
