# Read Podcast — Maintainer and Agent Guide

## Sources of truth

- Architecture invariants: `docs/ARCHITECTURE.md`. Operations: `docs/DEPLOYMENT.md`.
  User-facing overview: `README.md` (canonical) and `README.zh-CN.md` (translation; keep the
  two structurally identical).
- Feature-level behavior lives in the code and its tests; there is no separate capability index.
- `docs/design.md` is the WebUI visual system.

## Product boundary

Read Podcast is a cloud-first personal podcast subscription, processing and reading system for
personal and small private deployments. Cloudflare owns the task lifecycle from creation to
publication.

| Concept | Current implementation |
|---|---|
| Cloudflare application (D1, ProcessingWorkflow, R2) | Worker / D1 / Workflows / R2 |
| Transcription Service — replaceable transcription compute | `transcription_service/` |
| Refinement Provider — replaceable LLM compute | any OpenAI-compatible API |
| Canonical Manuscript Store — final manuscript persistence | user-configured GitHub repository |

## Invariants

- D1 is the durable business record; the ProcessingWorkflow is the execution owner with
  durable checkpoints; R2 holds raw / refined / upload payload checkpoints; published manuscripts live only in the
  Canonical Manuscript Store.
- The Transcription Service holds no business state and no Cloudflare, R2 or LLM credential —
  and no application token or user-maintained configuration. The macOS reference deployment is
  zero-configuration (`deploy/macos/install.sh` creates runtime directories only); remote
  authentication is Cloudflare Access. After the raw transcript is in R2 nothing depends on it
  being online.
- Recovery is Cloudflare-owned (cron); `GET /tasks` is a pure read.
- Read / browse is public, mutations and execution are private, authentication belongs to
  Cloudflare Access. `/` + `/api/public/*` is Public Browse Mode of the same workspace: GET-only,
  side-effect free (episodes are the D1 snapshot, never an RSS refresh), no reader state or task
  status. Actions are classified by side effect; anonymous clicks on them navigate to `/manage`. Everything else is under `/manage*` + `/api/control/*`, protected by Access
  by path; no other API prefix may exist. No users, sessions, JWTs, OAuth or account tables.
- Readers reach articles only through the Cloudflare application; the Canonical Manuscript
  Store is never a browser-facing entry point. One store per manuscript; exports are secondary.
- No cloud-drive export, OAuth connectors or conversational assistant — removed by design.
- The repository is self-contained: runtime, build, test, deployment and upgrade depend on this
  repository only.
- Secrets live in Wrangler secrets only: Cloudflare holds the transcription endpoint, the Access
  service token, R2, GitHub and refinement credentials. The Transcription Service holds none, and
  no API ever returns a secret value. Documentation and examples use placeholders
  (`your-domain.example`, `your-github-username`, `your-manuscript-repository`,
  `podcasts/transcripts`), never personal domains, repositories or paths.
- Deployment-specific values (custom domain, D1 database id, transcription URL, Store repository)
  never live in the repository: `wrangler.jsonc` stays deployment-neutral and `scripts/deploy.mjs`
  (`npm run deploy`, also used by CI) injects them from `.deploy.env` or environment variables.

## Concept versus implementation

Do not add abstractions before a second concrete implementation exists: no `OutputBackend`
interface, backend selector, `output_backend` column or Settings backend switch. Keep
implementation identifiers stable (`transcription_service/`, `TRANSCRIPTION_SERVICE_*`, D1
columns, API paths, `deploy/macos/`) instead of renaming them for vocabulary.

Architecture changes update `docs/ARCHITECTURE.md` first. Do not introduce Durable Objects,
Queues or permanent polling without a real need.

## Validation

```bash
npm run check
npm run check:frontend
UV_CACHE_DIR=/tmp/read-podcast-edge-uv-cache uv run --directory transcription_service pytest -q
npx wrangler deploy --dry-run
```
