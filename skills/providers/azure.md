# Provider: Azure

Status: **UNVALIDATED**. This is a skeleton only; nothing here has been exercised. Check
every command against current Azure CLI documentation before use.

`provider_profile`: `azure`.

- **Identity (recon):** `az account show` for the subscription and user.
- **Inventory (read-only):** `az resource list --resource-group <group>` and
  `az vm list --resource-group <group>`.
- **Implicit resources to watch:** OS disks, network interfaces, public IP addresses and
  network security groups created with a VM. The resource group itself may be new or
  pre-existing; record which.
- **Secrets:** read names from Key Vault (`az keyvault secret list`); never print a value.
- **Remote-mutating:** every `create`, `delete`, `update`, `set`, `start`, `stop` and
  `deallocate` command.

Baseline/permissions: use the generic nonsecret fields and private normalized digests
from `stages/execute.md`; never retain secret originals. Visible bindings alone do not
prove all planned permissions; check the required scope or disclose what is unverified.
