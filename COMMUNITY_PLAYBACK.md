# TryTV community playback hints (staged, off by default)

This is a proposed, **not-yet-deployed** intake for user-submitted smart-player
outcomes at the **work + source + provider** level. Individual episodes are not
stored or ranked. The existing P2P SourceSync relay continues operating as before.

The receiver is on the Render coordinator; the desktop app makes outbound HTTPS
requests only. No router port forwarding, GitHub Actions, user GitHub tokens,
Cloudflare writes or direct writes to `raw.githubusercontent.com` are involved.

## Required Render environment values

The endpoint is **disabled** until all three values are set by the owner using
Render's private environment-variable UI:

- `TRYTV_PLAYBACK_INGEST_ENABLED=true`
- `TRYTV_PLAYBACK_GITHUB_TOKEN`: owner-created fine-grained token with Contents
  read/write permission limited to both `TryTV-Public-Catalog` and
  `TryTV-Client-Data`. Do not enter this token in chat, the packaged app or repo.
- `TRYTV_PLAYBACK_VIEWER_SECRET`: random, private server-side secret (32+ chars)
  used to HMAC-pseudonymize client viewer identifiers.

Do not deploy this feature branch or enable the environment settings until the
owner approves Render-to-GitHub write access and production scope.

## Data flow

1. TryTV client identifies its **source URL**, **work URL**, stable **provider**
   name and whether the local video timer passed the existing 1-second test.
2. The client sends a single small JSON report to
   `POST /v1/playback/evidence`. A 202 means **queued in volatile memory**,
   not published or verified. The current Windows app has NOT been connected
   to this endpoint yet.
3. The Render intake checks a privately fetched catalog allowlist, validates
   the report, applies short per-IP and per-viewer quotas, and stores only
   HMAC viewer hashes and work URL hashes in a private GitHub file.
4. Every 10 minutes (or at shutdown) it attempts to publish a separate
   **public aggregate** to `TryTV-Client-Data`. This write happens via the
   authenticated GitHub Contents API; Github Raw only serves the result.
5. Published signals require at least 3 distinct work URLs, 3 pseudonymous
   viewers and 5 observations per source/provider. Each work has equal weight
   independent of episode count. Published fields are counts, success rate and
   `unverified:true`; **no viewer or work identifiers** leave the private repo.

The public file is `trytv/playback/source-provider-reputation.v2.json`.
It is **not** a signed trusted playback result and must be used only as a
low-priority ranking hint. The existing direct playback verification remains
mandatory on every attempt.

## Limitations to resolve before rollout

- Client reports can be forged; arbitrary viewer hashes are not proof of unique
  humans. Rate limits and minimum sample diversity reduce, but cannot remove,
  this risk. For stronger claims, introduce an authenticated contributor model
  and independent server-side spot checks.
- Render's free instance can sleep. Reports accepted but not yet written to
  GitHub may be lost if it shuts down suddenly. The endpoint therefore returns
  `persisted:false`. A durable queue would need separate storage or more
  frequent GitHub writes (with rate-limit consequences).
- GitHub commit updates are not atomic across the private evidence and public
  aggregate files. A failed public write is retried on the next flush.
- No production dashboard, signed approval pipeline, or end-to-end device
  tests have been completed. Keep the feature flag off until those are done.

## Tests

Run `node --test community-playback-*.test.cjs` (Node 20+). Test fixtures
simulate GitHub; they do not use a live token or modify production repositories.
