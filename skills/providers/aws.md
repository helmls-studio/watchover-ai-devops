# Provider: AWS

Status: **UNVALIDATED**. This is a skeleton only; nothing here has been exercised. Check
every command against current AWS documentation before use.

`provider_profile`: `aws`.

- **Identity (recon):** `aws sts get-caller-identity` for the account and principal;
  `aws configure get region` for the region.
- **Inventory (read-only):** `aws ec2 describe-instances`, `aws ec2 describe-volumes`,
  `aws ec2 describe-addresses`, `aws ec2 describe-security-groups`.
- **Implicit resources to watch:** root volumes, network interfaces, auto-assigned public
  addresses. The default VPC and its security group are usually pre-existing.
- **Secrets:** read names from Secrets Manager or Parameter Store; never print a value.
- **Remote-mutating:** `run-instances`, `terminate-instances`, and every `create-*`,
  `delete-*`, `modify-*`, `authorize-*` and `revoke-*` command.

Baseline/permissions: use the generic nonsecret fields and private normalized digests
from `stages/execute.md`; never retain secret originals. Visible bindings alone do not
prove all planned permissions; check the required scope or disclose what is unverified.
