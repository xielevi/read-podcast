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
