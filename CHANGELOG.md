# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased] — planned as 1.0.0

> Release is pending #47 (import wrap-up) and the Free-plan boundary checks in
> `docs/DEPLOYMENT.md`; the version number stays 0.1.0 until then.

### Overview

Read Podcast 1.0.0 will be the first major release of the cloud-native personal podcast reading system. It turns selected podcast episodes into complete, readable long-form manuscripts—not compressed summaries—that you can read on any device, share via a public reading URL, and preserve as plain Markdown in your own GitHub repository.

The entire Cloudflare application (Workers, D1, Workflows, R2) is designed to fit the **Cloudflare Workers Free plan**. Transcription compute and the LLM refinement API are billed separately by whoever provides them.

### Relation to v0.x (Python / macOS App)

- **Legacy Desktop App (v0.x)**: Read Podcast was originally built as a native macOS desktop application written in Python and distributed as a DMG, with local storage and local MLX Whisper transcription. Desktop packaging and app development are currently paused. The complete v0.x codebase has been archived on the [`legacy/python`](https://github.com/xielevi/read-podcast/tree/legacy/python) branch.
- **Cloud-Native Architecture (v1.0+)**: v1.0 is a ground-up rewrite in TypeScript targeting Cloudflare Workers. It replaces local application state with durable cloud primitives (D1, Workflows, R2) and brings the reading interface to all devices (iOS, Android, macOS, Windows) through a mobile-optimized responsive WebUI.

### Supported Transcription Backends

v1.0 supports flexible transcription compute backends conforming to the stateless [Transcription Service Contract](docs/ARCHITECTURE.md#transcription-service-contract):

1. **Local Apple Silicon Mac (Reference Service)**:
   - Local MLX Whisper running natively on Apple Silicon (`transcription_service/`).
   - Zero-configuration deployment via `deploy/macos/install.sh` running as background `LaunchAgent` daemons (`127.0.0.1:28100` and `127.0.0.1:21567`).
   - Remotely managed Cloudflare Tunnel connector connecting the host to Cloudflare Edge without opening firewall ports.
2. **Cross-Platform / Docker (Faster-Whisper)**:
   - Built-in `faster-whisper` engine for Linux, Docker, NAS, or Windows hosts supporting both CPU and NVIDIA CUDA GPU acceleration.
   - Containerized deployment ready for homelabs and remote servers.
3. **Cloud Transcription (Alibaba Cloud Model Studio / 百炼 DashScope Paraformer)**:
   - Built-in cloud transcription adapter (`READ_PODCAST_TRANSCRIPTION_PROVIDER=dashscope`).
   - Direct Worker-to-cloud invocation passing audio URLs (including presigned R2 URLs for manual audio uploads), eliminating the need for a self-hosted transcription machine.
4. **OpenAI-compatible upload proxy (`READ_PODCAST_TRANSCRIPTION_ENGINE=openai-proxy`)**:
   - The Transcription Service proxies any OpenAI-compatible `/audio/transcriptions` API (OpenAI, Groq, SiliconFlow), transcoding with ffmpeg and splitting on silence to stay under upload limits.

### Key Capabilities in v1.0.0

- **Cloud-First Durable Execution**:
  - Task execution driven by Cloudflare Workflows with persistent step checkpoints.
  - Raw speech-to-text transcripts stored in R2 immediately upon completion: failed refinement retries without re-transcribing; failed manuscript commits retry without re-calling the LLM.
  - Automated recovery via scheduled Cron Trigger: reclaims queued tasks and detects failed workflows so tasks never hang silently.
- **Dual-Mode WebUI**:
  - **Public Browse Mode (`/` and `/api/public/*`)**: Read-only, unauthenticated, side-effect-free reading interface for browsing subscriptions and reading published manuscripts, cached at Cloudflare's global edge.
  - **Authenticated Control Mode (`/manage*` and `/api/control/*`)**: Protected by Cloudflare Access with Zero Trust email/OTP or SSO authentication. Manages subscriptions, triggers episode generation, configures settings, and tracks reading progress.
- **Bring-Your-Own Compute & Storage**:
  - **Refinement Provider**: Works with any OpenAI-compatible LLM API (e.g. DeepSeek, OpenCode Go, OpenAI, Qwen, etc.).
  - **Canonical Manuscript Store**: Published articles are saved as standard Markdown with YAML front matter in your personal GitHub repository. D1 maintains an index; the GitHub repository remains the sole durable source of truth.
  - **Wikipedia-Verified Key Concepts**: Automatically nominates key entities and verifies them against Chinese Wikipedia articles, providing instant encyclopedic context for readers.
- **One-Command Automated Setup (`npm run setup`)**:
  - Idempotent CLI script that provisions Cloudflare D1 databases, runs remote migrations, creates R2 storage buckets with strict lifecycle expiration rules (`raw-7d`, `refined-7d`, `uploads-1d`), safely prompts for secrets without echoing or disk writing, and validates deployment configuration.
  - Automated smoke test (`npm run setup -- --smoke`) validating the Cloudflare Access security boundary.
- **Comprehensive Quality and Test Suite**:
  - Over 760 automated tests covering Cloudflare Workers, D1 schema migrations, RSS parsing, Markdown generation, and frontend invariants.
  - Over 160 unit tests verifying transcription engine contracts and service endpoints.
