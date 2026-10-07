# Provider: Nectar (an OpenStack-based research cloud)

Status: **UNVALIDATED**. This is a skeleton only; nothing here has been exercised. Check
every command against the cloud's current documentation before use.

`provider_profile`: `nectar`.

- **Identity (recon):** `openstack project show <project>` and
  `openstack availability zone list`. Credentials come from an RC file or `clouds.yaml`;
  record where they are kept, never the password or a token.
- **Inventory (read-only):** `openstack server list`, `openstack volume list`,
  `openstack floating ip list`, `openstack security group list`.
- **Implicit resources to watch:** boot volumes, ports, and the default security group
  (usually pre-existing).
- **Allocation:** usage counts against a project allocation rather than a bill. Record
  that in the tier's cost range and uncertainty instead of inventing a price.
- **Remote-mutating:** every `create`, `delete`, `set`, `add` and `remove` command.

Baseline/permissions: use the generic nonsecret fields and private normalized digests
from `stages/execute.md`; never retain secret originals. Visible bindings alone do not
prove all planned permissions; check the required scope or disclose what is unverified.
