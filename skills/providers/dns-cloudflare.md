# Provider: Cloudflare DNS

Status: **UNVALIDATED**. Written for v0.1 but not exercised end to end. Confirm the details
against Cloudflare's current documentation before relying on them.

A public DNS change is an external release. It always needs an approved decision with the
categories `dns` and `external_release`, and it gets a `result` and verification like any
other change. Use neutral names while planning, such as `app.example.com`.

## Choose a mode with the human

### manual-edit mode (the default)

The human changes DNS in the Cloudflare dashboard; you never hold a token.

1. Prepare the exact records: type, name, content, whether proxied, and TTL. Put them in
   the decision request's `action`, written so they can be copied as they are.
2. Wait until the human replies in this session. Record the reply as a `decision` event,
   then clear `pending_decision`.
3. Only after an approval, append a gated `intent` related to that decision, naming the
   records the human will add.
4. The human makes the change in the dashboard and tells you when it is done.
5. Append a `result` related to the intent, and record their statement as a USER_CONFIRMED
   fact (source human). It is not checked yet.
6. Verify it yourself (below). Only then append `fact_verified` and record the DNS fact as
   VERIFIED_REMOTE.

### scoped-token mode

Use this only with an API token scoped to one zone with DNS edit permission. The human keeps
it in an environment variable, for example `CF_API_TOKEN`, with the zone id in
`CF_ZONE_ID`. Record only those names and where they are kept.

- Never put the token itself on a command line you log. Refer to the variables, with
  `CF_API_BASE` set to the API v4 base address given in Cloudflare's official API reference:

  `curl -sS -X POST "$CF_API_BASE/zones/$CF_ZONE_ID/dns_records" -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" --data @record.json`

- Each create, update or delete is remote-mutating: an `intent` before it (related to the
  approving decision) and a `result` after it.
- Save the API response as evidence only after checking it contains no token. Read its
  `success` field; a response is not verification of the DNS answer.
- Listing records (GET) is read-only.

## Verify

- Ask an authoritative name server: `dig +short <name> <type> @<zone name server>`.
- Ask a public resolver as well, and record both answers as evidence.
- A proxied record answers with Cloudflare addresses, not your origin. Verify the origin
  separately, for example with an HTTP request that reaches the app.
- DNS facts use the `network` class. Keep `fresh_for_minutes` no longer than the record's
  TTL, and never longer than the class cap.
- "No record exists" needs a control: the same query returning a record you know exists.

## Teardown

Removing a record is a deletion and needs its own approved request, unless it is part of an
approved teardown inventory. Verify the removal with the same `dig` queries.

Baseline/permissions: use the generic nonsecret fields and private normalized digests
from `stages/execute.md`; never retain secret originals. Visible bindings alone do not
prove all planned permissions; check the required scope or disclose what is unverified.
