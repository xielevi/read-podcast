# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] - 2026-09-28

> Cloudflare production runs on Workers Free, but spare CPU/subrequest capacity
> is workload-dependent. A local Docker run with Faster-Whisper and a test
> refiner exercised storage and restart recovery; it is not a blanket guarantee
> for every external LLM provider. See [deployment](docs/DEPLOYMENT.md).

### Overview

Read Podcast 1.0.0 is the first major release of the personal podcast reading system. It turns selected podcast episodes into complete, readable long-form manuscripts—not compressed summaries—that you can read on any device and preserve as plain Markdown in a store you own. The same code supports Cloudflare (Workers / D1 / Workflows / R2, publishing to GitHub) and single-host Docker / Node (SQLite, local storage and local manuscripts by default).

The maintainer runs the Cloudflare application on **Cloudflare Workers Free**. Large feeds and long episodes have been exercised in production; this does not quantify CPU/subrequest headroom for other workloads. Transcription compute and the LLM refinement API may be billed separately by their providers.

### Relation to v0.x (Python / macOS App)

- **Legacy Desktop App (v0.x)**: Read Podcast was originally built as a native macOS desktop application written in Python and distributed as a DMG, with local storage and local MLX Whisper transcription. Desktop packaging and app development are currently paused. The complete v0.x codebase has been archived on the [`legacy/python`](https://github.com/xielevi/read-podcast/tree/legacy/python) branch.
- **Cloudflare / Docker Architecture (v1.0+)**: v1.0 is a TypeScript rewrite with two deployments: Cloudflare Workers / D1 / Workflows / R2, or Docker / Node with SQLite and local storage. Both use a responsive WebUI for phone, tablet and desktop reading.

### Supported Transcription Backends

v1.0 implements transcription backends conforming to the stateless [Transcription Service Contract](docs/ARCHITECTURE.md#transcription-service-contract). Provider availability depends on your own configuration; see [deployment](docs/DEPLOYMENT.md):

1. **Local Apple Silicon Mac (Reference Service)**:
   - Local MLX Whisper running natively on Apple Silicon (`transcription_service/`).
   - Zero-configuration deployment via `deploy/macos/install.sh` running as background `LaunchAgent` daemons (`127.0.0.1:28100` and `127.0.0.1:21567`).
   - Remotely managed Cloudflare Tunnel connector connecting the host to Cloudflare Edge without opening firewall ports.
2. **Cross-Platform / Docker (Faster-Whisper)**:
   - Built-in `faster-whisper` engine for Linux, Docker, NAS, or Windows hosts supporting both CPU and NVIDIA CUDA GPU acceleration.
   - Containerized deployment ready for homelabs and remote servers.
3. **Cloud Transcription (Alibaba Cloud Model Studio / 百炼 DashScope Paraformer)**:
   - Built-in cloud transcription adapter (`READ_PODCAST_TRANSCRIPTION_PROVIDER=dashscope`).
   - Direct Worker-to-cloud invocation passing audio URLs (including presigned R2 URLs for manual audio uploads), eliminating the need for a self-hosted transcription machine. Check provider-specific limits before use.
4. **OpenAI-compatible upload proxy (`READ_PODCAST_TRANSCRIPTION_ENGINE=openai-proxy`)**:
   - The Transcription Service proxies any OpenAI-compatible `/audio/transcriptions` API (OpenAI, Groq, SiliconFlow), transcoding with ffmpeg and splitting on silence to stay under upload limits.

### Key Capabilities in v1.0.0

- **Cloud-First Durable Execution**:
  - Task execution driven by Cloudflare Workflows with persistent step checkpoints.
  - Raw speech-to-text transcripts stored in R2 immediately upon completion: failed refinement retries without re-transcribing; failed manuscript commits retry without re-calling the LLM.
  - Automated recovery via scheduled Cron Trigger: reclaims queued tasks and detects failed workflows so tasks never hang silently.
- **Dual-Mode WebUI**:
  - **Public Browse Mode (`/` and `/api/public/*`)**: Read-only, unauthenticated, side-effect-free reading interface for browsing subscriptions and reading published manuscripts. Cloudflare deployments cache published manuscript snapshots at the edge; Docker serves them from the local app.
  - **Authenticated Control Mode (`/manage*` and `/api/control/*`)**: Protected by Cloudflare Access with Zero Trust email/OTP or SSO authentication. Manages subscriptions, triggers episode generation, configures settings, and tracks reading progress.
- **Bring-Your-Own Compute & Storage**:
  - **Refinement Provider**: Works with any OpenAI-compatible LLM API (e.g. DeepSeek, OpenCode Go, OpenAI, Qwen, etc.).
  - **Canonical Manuscript Store**: Published articles are saved as Markdown with YAML front matter in a GitHub repository (Cloudflare) or a local directory with version snapshots (Docker). D1 or SQLite maintains the index; the chosen store holds the durable manuscript.
  - **Localized Wikipedia-Verified Key Concepts**: Nominates key entities and verifies them against Chinese or English Wikipedia according to the UI language.
- **Cloudflare Setup (`npm run setup`)**:
  - Idempotent CLI provisions D1, applies migrations, creates R2 lifecycle rules and prompts for secrets without echoing or writing them to disk.
  - Automated smoke test (`npm run setup -- --smoke`) validating the Cloudflare Access security boundary.
- **Docker / Node Deployment**:
  - `docker compose up -d` starts a Node web app with SQLite, in-process task recovery, local object storage and a bind-mounted manuscript directory; the transcription container uses Faster-Whisper by default.
- **Comprehensive Quality and Test Suite**:
  - 800+ automated tests covering Cloudflare Workers, D1 / SQLite migrations, RSS parsing, Markdown generation, local runtime behavior, and frontend invariants.
  - 190+ transcription-service tests covering engine contracts and service endpoints.
