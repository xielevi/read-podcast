# Security Policy

## Supported version

Security fixes are applied to the latest code on `main`.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability reporting feature on this repository. Include the affected
version, reproduction steps, expected impact, and any suggested mitigation.

Do not include API keys, private podcast feeds, audio, transcripts, local paths,
or other personal data in a report.

## Deployment boundary

Read Podcast is designed as a single-user local application. The WebUI and MLX
backend bind to loopback by default. If you intentionally expose either service,
use HTTPS, configure authentication, restrict the trusted network, and keep the
host and container dependencies updated.

## Known SSRF residual boundaries

Outbound fetches for user-supplied RSS and media URLs go through
`modules/network_security.py`, which rejects non-HTTP(S) schemes, embedded
credentials, and hosts that resolve to non-global addresses, and re-validates
every redirect hop (`safe_get`). Two residual limitations are known and
accepted for the loopback-only single-user deployment model:

- **DNS-rebinding (TOCTOU).** `validate_public_url` resolves the hostname and
  checks the addresses at validation time, but the subsequent `requests` /
  `httpx` / `yt-dlp` fetch resolves the hostname again independently. An
  attacker controlling DNS could return a public address during validation and
  a private one at fetch time. Closing this fully requires pinning the
  validated IP and connecting to it with an explicit `Host` header. The
  loopback-only default and the absence of internal services to pivot to keep
  the practical exposure low.
- **yt-dlp fallback.** The audio downloader validates the initial media URL,
  but when it falls back to `yt-dlp`, that tool performs its own redirects and
  extractor network I/O outside this guard. Treat feed/media URLs from
  untrusted sources accordingly, especially if you expose the service beyond
  loopback.
