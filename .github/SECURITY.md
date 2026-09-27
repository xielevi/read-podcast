# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| Latest 1.x release | Yes |
| Older 1.x releases | No — upgrade to the latest 1.x release first |
| 0.x | No — legacy Python/macOS App has been paused and archived under `legacy/python` |

Security fixes land on `main` and are tagged as releases. Read Podcast is a self-hosted cloud-first application;
to apply fixes to your deployment, update your checkout to the latest release tag, deploy the Cloudflare
application via `npm run deploy`, and update your Transcription Service host via `deploy/macos/update.sh`
(see [`docs/UPGRADING.md`](../docs/UPGRADING.md) for details).

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting
feature on this repository. Include the affected version or commit, clear reproduction steps, expected impact,
and any suggested mitigations.

**Do not include API keys, tokens, account IDs, private podcast feeds, audio, transcripts, local paths, or other personal data in a report.**

## Deployment and architecture security boundaries

Read Podcast operates on a cloud-first personal reading model with strict separation of privileges:

- **Public Browse vs. Authenticated Control**:
  - Public Browse Mode (`/` and `/api/public/*`) is strictly GET-only and side-effect free, serving cached published manuscripts and public subscription snapshots.
  - Authenticated Control Mode (`/manage*` and `/api/control/*`) owns all state mutations, generation tasks, and settings. It must be protected by **Cloudflare Access** on those two path prefixes.
  - Keep `workers_dev: false` and `preview_urls: false` in `wrangler.jsonc` so that the Worker is never reachable on an unauthenticated hostname.
- **Secrets Management**:
  - Application secrets (`GITHUB_TOKEN`, `REFINER_API_KEY`, `R2_*`, `CF_ACCESS_*`) live exclusively in **Cloudflare Wrangler secrets**.
  - No secret is ever written to git, stored in the database, or returned by any API.
- **Transcription Service Isolation**:
  - The Transcription Service holds no business database, no Cloudflare or R2 credentials, and no LLM API keys.
  - It binds locally to loopback (`127.0.0.1:28100` and MLX on `127.0.0.1:21567`). Remote communication is routed through a Cloudflare Tunnel protected by a Cloudflare Access Service Token.
- **Audio Uploads and Size Caps**:
  - Uploaded audio files are stored in R2 (`uploads/` prefix with a 1-day lifecycle). The Transcription Service fetches uploaded audio through short-lived, single-object, read-only presigned URLs; audio is never proxied through the Worker.
  - Uploads are capped at 200 MiB, enforced by Cloudflare at all entry points.
- **Canonical Manuscript Store**:
  - The manuscript store is a private GitHub repository accessed via a fine-grained Personal Access Token stored in Wrangler secrets. It is never exposed directly to browser clients.

## Outbound network security and SSRF defense

Outbound fetches for user-supplied RSS feeds, podcast covers, and audio streams implement defense-in-depth:

1. **Edge URL Guard (`src/net/url_guard.ts`)**:
   Every outbound URL received by the Cloudflare Worker is validated before any request is made. The guard rejects non-HTTP(S) schemes, embedded user credentials, single-label hostnames, `.localhost` / `.local` / `.internal` suffixes, private IPv4 ranges (RFC 1918, RFC 3927, RFC 2544, etc.), loopback, IPv6 unique local (ULA) and link-local ranges, as well as IPv4-mapped IPv6 (`::ffff:x.x.x.x`), NAT64 (`64:ff9b::/96`), and 6to4 (`2002::/16`) addresses.
2. **Hop-by-hop Transcription Service Validation (`transcription_service/core/network_security.py`)**:
   When the Transcription Service fetches podcast audio (`downloader.py`), it uses `safe_get()`, which re-validates DNS resolution against private and reserved IP blocks **before every single connection and every redirect hop**.
3. **Direct HTTP Streams Only**:
   Audio downloads use direct HTTP(S) stream requests only. The application deliberately contains no fallback to third-party web scrapers or `yt-dlp` to ensure that unvalidated extractor network I/O cannot occur.
4. **Known Residual Boundary (DNS Rebinding / TOCTOU)**:
   In the Transcription Service, hostname resolution is checked prior to issuing the HTTP request. An attacker controlling a DNS server with low TTL could theoretically return a public address during the check and a private address during socket connection. Because the service binds to loopback without local privilege-escalation endpoints or intranet access, practical risk is minimal. Pinning validated IP addresses at the socket layer remains a future hardening candidate.
