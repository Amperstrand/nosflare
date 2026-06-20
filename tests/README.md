# e2e tests — relay.cashu.email

Live end-to-end NIP coverage for `wss://relay.cashu.email`. The suite publishes
real signed events over WebSocket, reads them back, and then deletes all of its
own test data from the D1 backing store.

## Prerequisites

- **Node 22+** (a global `WebSocket` is required; no extra deps).
- **wrangler OAuth login** so the cleanup step can call the D1 REST API. The
  token is read from `~/Library/Preferences/.wrangler/config/default.toml`.
  Run `npx wrangler login` if that file is missing.
- Network access to `relay.cashu.email` and `api.cloudflare.com`.

## Run

```bash
npm run test:e2e
```

Run from this worktree root. Exit code is `0` only when every test passes AND the
cleanup step confirms zero test events remain in the database.

## What it covers

- **NIP-42** — AUTH is disabled; relay must not send an `AUTH` frame.
- **NIP-11** — relay info doc is served with `Access-Control-Allow-Origin: *`.
- **NIP-01** — replaceable kind 0 keeps only the newest version.
- **NIP-09** — a kind 5 deletion removes its target event from queries.
- **NIP-12** — `#p` and `#t` tag filters return matching events.
- **NIP-33** — parameterized replaceable kind 30078 keeps the newest per `d` tag.
- **Realtime broadcast** — a subscriber receives an `EVENT` the moment it is published.
- **Rate limit** — 10 events/min/pubkey; the 11th and 12th are rejected.
- **NIP-15 NOTICE** — malformed JSON and an incomplete event are rejected.
- **NIP-15 EOSE** — an empty-result subscription returns EOSE within 2s.
- **NIP-16** — an ephemeral kind 20000 event is broadcast but never stored.
- **NIP-20** — an event with a corrupted signature is rejected with `OK:false`.
- **NIP-17** — a kind 4 direct message is retrievable by the recipient via `#p`
  (plus a kind 1059 gift-wrap storage check).
- **NIP-25** — a kind 7 reaction is retrievable via the `#e` tag of its root.

## Test-data hygiene

Every published event carries the tag `["t","nip-test-suite-cleanup"]`. At the end
of each run the suite issues a single D1 query batch (via the Cloudflare REST API)
that deletes every event with that tag from `event_tags_cache_multi`,
`content_hashes`, `tags`, and finally `events` — then re-counts to confirm zero
remain. Each run uses freshly generated keypairs so rate-limit windows never leak
between runs.

## Caveats

- The rate-limit test publishes 12 events from one pubkey (2 are expected to be
  rejected); all accepted ones are cleaned up afterwards.
- The ephemeral test depends on broadcast timing; the subscriber subscribes before
  the publisher sends and waits up to 10s for the realtime frame.
