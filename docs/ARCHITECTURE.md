# Architecture

Read Podcast is a cloud-first personal podcast reading system: it turns episodes the owner
chooses into complete long-form manuscripts, publishes them to a store the owner controls, and
serves them through one workspace that is publicly readable and privately controlled. The
product story is in the [README](../README.md). This document keeps only the long-lived
architectural facts; behavior at the level of endpoints and functions lives in the code and its
tests.

## Topology

```text
Browser / Mobile
      ↕
Cloudflare application
  ├─ D1                 durable business record
  ├─ ProcessingWorkflow execution owner + durable checkpoints
  └─ R2                 raw / refined / upload payload checkpoints
      │        ▲
      ▼        │ raw transcript
Transcription Service   replaceable external transcription compute
      │
Cloudflare ──▶ Refinement Provider ──▶ Cloudflare      replaceable external LLM compute
      │
      ▼
Canonical Manuscript Store   final manuscript persistence
```

| Component | Owns | Current implementation |
|---|---|---|
| **D1** | user-visible durable business state: subscriptions, episodes, tasks, read state, article index (what Public Browse Mode lists), refinement settings, UI preferences, concept cache | Cloudflare D1 |
| **ProcessingWorkflow** | execution of a task from creation to publication, with durable step checkpoints | Cloudflare Workflows |
| **R2** | expensive intermediate payloads: uploaded audio, raw transcripts and refined text (temporary) | Cloudflare R2 |
| **Transcription Service** | turning audio into a raw transcript; no business state, no credential, no user-maintained configuration | `transcription_service/` |
| **Refinement Provider** | turning a raw transcript into refined text | any OpenAI-compatible API |
| **Canonical Manuscript Store** | the durable, canonical published manuscript | a user-configured GitHub repository |

Cloudflare owns the task lifecycle from creation to publication. The Transcription
Service is a replaceable compute dependency used during the transcription stage; once the
raw transcript is in R2 it can be offline, restarted or replaced without affecting the task.

Readers always go through the Cloudflare application. The Canonical Manuscript Store is a
persistence layer that Cloudflare reads internally, never a browser-facing entry point.
A deployment has exactly one Canonical Manuscript Store per manuscript; any future export
is a secondary copy, not a second source of truth. Introduce an abstraction (an
`OutputBackend` interface, a selector, a D1 column, a Settings switch) only when a second
concrete store exists.

## Platform Interfaces and Abstraction Boundary

In accordance with the project rule that abstractions are introduced only when a second concrete
implementation exists, the platform interfaces (`Database`, `ObjectStore`, `TaskWorkflow`, and
`Scheduled`) are introduced to support both the Cloudflare deployment and the self-hosted Docker
deployment (#27: SQLite + local volume + in-process task executor; #28: local manuscript persistence).

The interface boundary is drawn strictly between platform runtimes and business domain logic:

- **Database interface (`Database`, `Statement`)**:
  Minimal prepared statement semantics: `prepare`, `bind`, `first`, `all`, `run`, and `batch`.
  D1 and SQLite directly satisfy these semantics without translation layers.
- **Object Storage interface (`ObjectStore`, `MultipartUpload`)**:
  Object lifecycle primitives: `get`, `put`, `delete`, `head`, `list`, multipart uploads
  (`createMultipartUpload`, `resumeMultipartUpload`), and generating signed access URLs
  (`createPresignedUrl`). Implemented by Cloudflare R2 (+ S3 SigV4 presign) and local/S3-compatible
  storage in Docker.
- **Task Workflow interface (`TaskWorkflowEngine`, `WorkflowStepLike`, `NonRetryableError`)**:
  Durable step execution (`step.do`), delay/retry calculation, non-retryable error semantics, and
  instance lifecycle management (`create`, `get`, `status`, `terminate`). Implemented by Cloudflare
  Workflows in edge deployments and an in-process step runner in Docker.
- **Scheduled Maintenance interface**:
  Trigger for background reconciliation (`runMaintenance`), invoked by Cloudflare Cron Triggers or
  container task runners.

**Boundary Rule & Thin Adapter**:
Business layer code (`src/*` outside `src/platform/`) depends exclusively on these minimal interfaces
via `Env` (`env.db`, `env.storage`, `env.workflows`), with zero imports of `cloudflare:workers` or
`cloudflare:workflows` and zero references to Cloudflare binding types (`D1Database`, `R2Bucket`,
`Workflow`, etc.). The Cloudflare adapter (`src/platform/cloudflare.ts`) provides a thin wrapper
around Cloudflare runtime bindings with unchanged behavior. An architecture test enforces that
no business files bypass the adapter or reference Cloudflare binding types.

## Local Runtime (Docker / Node.js)

To support self-hosted operation without dependency on Cloudflare services (#27), the application
provides a first-class local runtime running on Node.js 22+. The exact same TypeScript business
logic is executed by pairing the platform interfaces with local implementations:

| Interface | Cloudflare Implementation | Local / Docker Implementation |
|---|---|---|
| `Database` | Cloudflare D1 | SQLite (`node:sqlite` DatabaseSync), WAL mode, foreign keys enabled, running `migrations/*.sql` |
| `ObjectStore` | Cloudflare R2 | Local directory volume (`uploads/`, `raw/`, `refined/`), temporary HMAC-signed download URLs (`/storage/download`), automated lifecycle retention (1d uploads, 7d raw/refined) |
| `TaskWorkflowEngine` | Cloudflare Workflows | In-process step runner with SQLite checkpoint tables (`_workflow_instances`, `_workflow_checkpoints`), matching replay, retry, backoff, and non-retryable semantics; recovers running workflows across process restarts |
| `ScheduledHandler` | Cloudflare Cron Trigger (every 5 min) | In-process timer (every 5 min) invoking `runMaintenance` (recovery and liveness reconciliation) and object store retention sweep |
| Static Assets | Cloudflare Assets | Node HTTP server serving `public/` files with MIME mapping and SPA fallback |
| Access Control | Cloudflare Access | Optional HTTP Basic Auth on `/manage*` and `/api/control/*`; Public Browse Mode (`/` and `/api/public/*`) remains open and side-effect free; defaults to listening on `127.0.0.1` |
| Secrets / Vars | Wrangler secrets / vars | Environment variables and `.env` |

In Docker Compose, the Web application container runs alongside the containerized Transcription
Service (`transcription_service/docker-compose.yml`), communicating over an internal container network.
Manuscript persistence uses the Canonical Manuscript Store (GitHub repository) as in the Cloudflare deployment;
local directory persistence is planned for #28.

### Internal Service Topology and Security Boundaries

In the reference production deployment, the Cloudflare application communicates with the Transcription
Service across public networks through a Cloudflare Tunnel protected by Cloudflare Access service tokens.
The Transcription Service in turn enforces outbound SSRF protection (`validate_public_url`), forbidding
downloads of audio files from local or private IP addresses.

In the local Docker Compose topology, both services reside on an isolated internal container bridge network.
This requires explicit security boundary trade-offs:

1. **Trusted Internal Transcription (`TRUSTED_INTERNAL_TRANSCRIPTION`)**:
   Instead of relaxing `isLocalServiceEndpoint` to treat arbitrary network hostnames as local, the platform
   `Env` explicitly declares `TRUSTED_INTERNAL_TRANSCRIPTION=true` when running in a trusted internal network.
   When enabled, outbound calls to `TRANSCRIPTION_SERVICE_URL` omit the Cloudflare Access service token check,
   allowing direct communication between the `web` container and the `transcription` container.
2. **Audio Source SSRF Allowlist (`ALLOWED_AUDIO_SOURCE_HOSTS`)**:
   When users process uploaded audio files, the Web application generates an HMAC-signed download URL pointing
   to `http://web:3000/storage/download`. The sibling Transcription Service resolves `web` to a Docker internal
   bridge IP (RFC 1918 private network), which standard SSRF protection would reject.
   Rather than disabling SSRF checks or permitting private networks globally, the Transcription Service supports
   an explicit opt-in allowlist `ALLOWED_AUDIO_SOURCE_HOSTS` (configured as `web` in `docker-compose.yml`).
   Only hostnames in this allowlist are permitted to resolve to private network addresses for audio downloading.
   Per-hop redirect validation in `safe_get` remains active: even if `web` is in the allowlist, any redirect
   to unlisted internal targets or cloud metadata endpoints (`169.254.169.254`, loopback, or LAN) is strictly rejected.
3. **Storage Signing Key Persistence**:
   Temporary download URLs are signed with HMAC-SHA256. If `INTERNAL_SIGNING_SECRET` is not provided via
   environment variables, the local runtime generates a cryptographically random secret on first startup and
   persists it to `/data/signing.key` with `0600` permissions. Fixed public default keys are forbidden.
4. **Multipart Path Traversal Defense**:
   Multipart upload IDs are strictly validated against `^localmp-\d+-[a-z0-9]+$` and constrained within the
   storage root's `.multiparts/` directory, preventing arbitrary directory deletion or file creation.
5. **Workflow Execution & Replay Semantics**:
   The in-process `LocalWorkflowStepRunner` persists step results in `_workflow_checkpoints`. Steps executed
   in prior attempts are restored directly from SQLite, guaranteeing that expensive operations (transcription,
   LLM refinement, GitHub commits) are never re-run during retry or recovery. When step `retries` is omitted,
   it defaults to Cloudflare Workflows semantics (5 retries), and step `timeout` is enforced.


## Public Browse Mode and Authenticated Control Mode

> **Read / browse is public. Mutations and execution are private. Authentication belongs to Cloudflare Access.**

One frontend serves one product surface at two capability levels, split by path so that
Cloudflare Access can enforce the boundary before a request reaches the application:

| Mode | Pages | API | Who |
|---|---|---|---|
| **Public Browse Mode** | `/` | `/api/public/*` | anyone |
| **Authenticated Control Mode** | `/manage*` | `/api/control/*` | the owner, through Cloudflare Access |

- Both modes render the same workspace (subscriptions, import, manuscripts, episode
  inspector, reader). Public Browse Mode keeps control affordances visible; activating one
  navigates to `/manage` (with a lightweight intent), where Access authenticates. There is no
  login modal and no client-side identity.
- Actions are classified by **side effect**, not by HTTP method or control type: anything that
  mutates D1/R2, starts or controls a workflow, refreshes external state (RSS), calls the
  Refinement Provider, changes settings or writes reader state is control-plane only.
- `/api/public/*` is strictly side-effect free: it accepts only `GET`/`HEAD` and never writes
  D1 or R2, refreshes RSS, starts tasks or calls the Refinement Provider. It serves
  subscriptions, the **D1 episode snapshot as-is** (no RSS fetch, no background refresh, no
  `force`; a stale snapshot stays stale), query-only podcast search, cover art
  (subscription covers proxied by podcast name, search-result covers by Apple CDN URL), and
  published articles (content, download, cached concepts). Episodes expose only whether a
  published article exists and its id — never task progress, status, failures, read state,
  settings, Store paths or commits.
- Public reading serves the **publish snapshot**: the Store file at `articles.commit_sha` (the
  same version key as `article_concepts`), not the branch head. A new version reaches readers
  only by re-publishing. Because that content is immutable, it is edge-cached by
  `content_path@commit_sha`; search results and cover art are edge-cached as well, so anonymous
  traffic does not reach upstream origins or spend the Store's API quota. The edge cache is a
  read optimization of the public handlers only — never a second manuscript store; control and
  publishing paths read the Store branch directly.
- Episode lists are paged, filtered, searched and counted in D1 (`…/episodes/page`, the same
  handler on both planes); a browser only ever holds the current page, never a whole back
  catalogue. Lists never carry show notes — a single episode's summary is read on demand
  (`…/episodes/summary`). On the control plane the same request applies the RSS
  stale-while-revalidate policy to a bounded number of subscriptions in scope.
- Business identity is stable ids, never names or titles: tasks are created from an
  `episode_id`; read state is keyed by the manuscript's `episode_id` (RSS episodes, stable
  across re-generation) or its `task_id` (imported audio, which has no episode); whether an
  episode has a manuscript is the page item's `article_task_id`.
- Public responses are explicit allowlist DTOs, never raw D1 rows. Source URLs (RSS feed,
  audio, cover image, episode link) can carry credentials for private feeds, so they stay on
  the control plane; a subscription is exposed only as its name, its feed host and whether it
  has a cover.
- Every other API — settings, subscription writes, the refreshing episode read, uploads,
  tasks, read state, concept extraction — lives under `/api/control/*`. No other API prefix
  exists, so there is no alias that bypasses Access.
- Public Browse Mode persists no reader state: no read state, no reading progress, no saved
  scroll position, no task queue. UI and reader typography preferences follow a dual-track model:
  Authenticated Control Mode (`/manage`) persists preferences to Cloudflare D1 (local zero
  configuration) and syncs via `/api/control/preferences`; Public Browse Mode (`/`) uses
  `localStorage` to persist the visitor's appearance preferences, initializing from cloud
  defaults without mutating D1.
- The application has no users, sessions, JWTs, OAuth or account tables; it trusts the
  path boundary that Access enforces. `workers_dev` and preview URLs stay disabled so the
  Worker is reachable only through the Access-protected hostname.

## Task lifecycle

```text
queued → transcribing → refining → finalizing → success
                                  or error / cancelled
```

`finalizing` is the window in which the manuscript is committed to the Canonical Manuscript
Store. A task enters it by a compare-and-set from `refining`; from then on it can no longer
be cancelled.

The workflow instance id is derived deterministically as `process-<taskId>-<attemptId>` and
is not stored in D1. Steps run in this order:

```text
resolve-raw
→ resolve-source-N → submit-transcription-N → poll-transcription-N
→ persist-raw-N → release-transcription-N
→ claim-refinement → refine + completeness guard → validate-and-publish → success
```

`resolve-raw` skips the transcription steps when a plausible raw transcript already exists
in R2 (retry, recovery). Each `N` is a submission number.

## Durable boundaries and idempotency

- **Attempts.** Every task has a current attempt id, rotated by create and retry. Workflow
  steps write D1 only while their attempt is current and the task is still active, so an old
  execution can never revive a cancelled or retried task.
- **Transcription submission** is idempotent on `<task>:<attempt>`. The audio source of a
  submission (a public URL, or a presigned R2 URL) is resolved once in a durable step and
  reused by every submit retry; only a genuinely lost provider request opens a new submission.
- **Raw transcript.** The transcript body is fetched from the service exactly once, checked
  for plausibility, and written to R2 (`raw/<task>/<attempt>.txt`, 7-day lifecycle). After
  that, refinement failures retry entirely on Cloudflare and never re-transcribe.
- **Refinement.** The only expensive LLM call is its own durable step; a publish failure
  retries publishing without calling the model again. The refiner configuration is
  snapshotted when the workflow is created. After the completeness guard passes, refined text
  is written to R2 (`refined/<task>/<attempt>.md`, 7-day lifecycle); the step returns only
  the object key. Each publish attempt reads that checkpoint, without isolate-local caching.
  Keep it after publication so a replay after the Store / D1 write can finish idempotently.
  A missing or empty checkpoint fails explicitly; it never publishes an empty manuscript.
- **Completeness guard.** Two checks keep a degraded run from being published as a manuscript.
  Before refining, a raw transcript with fewer than 200 non-whitespace characters fails the
  task (transcription degraded; the model must not invent an article from show notes). After
  refining, the output must keep at least `min_output_ratio` (Settings, default `0.7`) of the
  raw transcript's non-whitespace characters and show at least two structural features
  (headings, speaker labels, bold emphasis, an outline); otherwise the task fails with `refine_quality_gate`,
  nothing is published and the raw transcript stays in R2 for a retry. The built-in editorial
  prompt normally targets roughly 75–85%; the ratio setting is a safety floor, not the editing target.
- **Finalization.** The manuscript is committed to the Canonical Manuscript Store first
  (same path and same content is a no-op), and only then is D1 marked `success`. A replay of
  the publish step for the same attempt resumes finalization; a stale attempt is rejected.
  Cancellation is honored until finalization begins.
- **Cancel.** Cancel marks the task `cancelled`, terminates the workflow, and best-effort
  asks the Transcription Service to release its compute; a `finalizing` task returns 409.
- **Recovery** is owned by Cloudflare and needs no external node. A cron trigger runs
  `recoverQueuedTasks` (start workflows for queued tasks that have none) and
  `reconcileWorkflowLiveness` (fail tasks whose workflow ended unexpectedly). `GET /tasks`
  is a pure read.

## Transcription Service contract

Cloudflare calls the service over a neutral HTTP contract (`src/transcription/contract.ts`)
authenticated by **Cloudflare Access** at the tunnel ingress — the service itself validates no
application token. The model is asynchronous because real transcription can outlast proxy read
timeouts:

```text
POST   /v1/transcriptions        submit, idempotent on request_id → 202 + provider_request_id
GET    /v1/transcriptions/:id    status and progress metadata (long poll)
GET    /v1/transcriptions/:id/result   raw transcript body, fetched once
DELETE /v1/transcriptions/:id    best-effort cancel and release
GET    /health                   the only health endpoint (host curl; from Cloudflare it is
                                 also an Access-authenticated probe)
```

The service reports facts (status, progress, error code); whether to retry is decided by
Cloudflare. Any machine or remote service implementing the contract can replace it;
replaceability comes from this contract rather than from an in-process backend registry.

The reference implementation (`transcription_service/`) ships three built-in engines behind one
in-process `Transcriber` protocol. On Apple Silicon the default engine is the local MLX
Whisper HTTP service (`mlx_service/`, loopback only, no credential); everywhere else — Linux,
Windows, NAS and the container image — the default is an in-process Faster-Whisper engine on
CPU or CUDA. Selection is built in (`core.config.resolve_engine`): platform default first,
`READ_PODCAST_TRANSCRIPTION_ENGINE` to force an engine. The third option is `openai-proxy`
(opt-in via `READ_PODCAST_TRANSCRIPTION_ENGINE=openai-proxy`): instead of running local inference,
it proxies any OpenAI-compatible `/audio/transcriptions` API (OpenAI, Groq, SiliconFlow, etc.),
handling file transcoding to low-bitrate mono via ffmpeg, silence-based chunking with overlap for
files exceeding upstream size limits, per-chunk retry with backoff, and overlap deduplication.

The reference service is **zero-configuration**: built-in runtime defaults (download limits,
timeouts, concurrency, result TTL), platform data/log directories, no user-maintained
configuration file, and remote authentication is Cloudflare Access.

### Architectural Decision: Credentials in `openai-proxy`

The local MLX and Faster-Whisper engines hold no application credential. The `openai-proxy`
engine introduces a scoped exception to this rule:

- **Scope:** Only the `openai-proxy` engine holds upstream API credentials (`READ_PODCAST_OPENAI_API_KEY`,
  configured alongside upstream base URL and model through process environment variables).
- **Invariants:** The upstream key is strictly confined to outgoing HTTP requests to the upstream
  transcription API. It is **never** echoed in status endpoints (`/v1/transcriptions/*`),
  health probes (`/health`), or error responses, and is **never** written to logs. The external
  HTTP contract (`/v1/transcriptions`) is completely unchanged: Cloudflare Worker and callers
  do not know or care whether the service runs local Whisper or proxies an upstream provider.

## Cloud transcription adapter

The neutral HTTP contract above stays the external protocol for self-hosted transcription
compute. A cloud provider is integrated **inside the Worker** as a protocol translation
adapter: `src/transcription/dashscope.ts` maps the same submit / poll / fetch / release
semantics onto Alibaba Cloud Model Studio's Paraformer recorded-speech API, and
`src/transcription/client.ts` dispatches on the `TRANSCRIPTION_PROVIDER` deploy variable
(`self-hosted` | `dashscope`, default `self-hosted` — existing deployments are unaffected).
There are exactly these two implementations and no provider registry, per the
no-abstraction-before-a-second-implementation rule. The Workflow's step structure
(`resolve-source → submit → poll → persist → release`) is identical for both providers;
only the client layer differs.

Selection between them is currently an assumption, not a measured conclusion: the provider
evaluation issue (#31) had no verified comparison results when this adapter was built, so
DashScope Paraformer was implemented as the first cloud provider per issue #32's default.
`TRANSCRIPTION_PROVIDER` stays a deployment choice; if #31 later favors another provider,
it becomes the second cloud adapter — the trigger to generalize, not before.

Facts that differ from the self-hosted path and are accepted by design:

- **Audio is fetched by the provider.** The Worker hands the provider a URL and never
  carries audio bytes: for RSS episodes it follows redirects hop by hop first (each hop
  re-checked against public-URL rules, every response body canceled immediately) so that
  statistic-redirect and hotlink-protected links resolve to the final audio URL; for custom
  uploads it reuses the presigned R2 GET URL, whose 2-hour validity covers provider-side
  queueing plus download.
- **Submission idempotency has one honest gap.** DashScope has no idempotency key, so the
  submit step reuses the provider handle already written to D1 whenever it re-executes
  without a checkpoint (isolate crash between the D1 write and the step checkpoint) — a
  replay never creates a second task. The only remaining gap is a submission that the
  provider accepted but whose response was lost: the durable retry then creates a second
  task and the first becomes an orphan. It pollutes no business state (results expire after
  24 hours) and consumes one paid transcription; `MAX_SUBMISSIONS` bounds the blast radius.
- **Progress and cancellation are degraded.** The provider reports no percent and no
  phases, and offers no cancel API: running tasks map to an indeterminate transcribing
  progress, the client paces polling itself (the provider has no long-poll), and the
  release step is a no-op. Raw-transcript plausibility, stale-result rejection and the
  D1/R2 persistence guards are provider-independent and unchanged.
- **Error mapping is provider-side.** Provider fetch failures (hotlink protection, dead
  link, unsupported format) map to `provider_fetch_failed` → task error
  `provider_audio_fetch_failed`, whose user-facing message suggests switching to the
  self-hosted service; quota exhaustion maps to `provider_quota_exhausted`. Both are
  deterministic (no retry). Everything else stays retryable and flows through the normal
  submission loop. The Settings probe for `dashscope` verifies key configuration only and
  never calls the provider (no billed side effects).

## Storage

| Data | Where | Lifetime |
|---|---|---|
| Business state and indexes | D1 | durable |
| Uploaded audio | R2 `uploads/*` | 1 day |
| Raw transcript | R2 `raw/*` | 7 days |
| Refined text checkpoint | R2 `refined/*` | 7 days |
| Published manuscript | Canonical Manuscript Store | durable |

Refined checkpoints are temporary execution payloads, never a reader-facing manuscript store.
Published manuscripts remain canonical only in the Canonical Manuscript Store.
Manuscripts and raw transcripts are never stored in D1, and raw transcripts never enter the
Canonical Manuscript Store. Custom uploads are capped at 200 MiB, enforced by Cloudflare at
every entry point.

## Security boundaries

- Owner access is Cloudflare Access on `/manage*` and `/api/control/*`; `/` and
  `/api/public/*` are public and read-only (see *Public Browse Mode and Authenticated Control Mode*).
- Cloudflare reaches the service through Cloudflare Access (a service token on the tunnel
  ingress). The service holds no application token and no R2, Cloudflare or LLM credentials.
- Uploaded audio reaches the service through a short-lived, single-object, read-only
  presigned R2 URL; the audio is not proxied through the Worker.
- Outbound URLs are validated against private and reserved ranges on both Cloudflare and
  the service, which re-checks every redirect hop; audio is fetched by direct link only.
- Secrets live in Wrangler secrets and are never returned by any API. The Transcription Service
  stores no Cloudflare or customer credentials; for the `openai-proxy` engine, upstream API credentials
  are passed via process environment variables and strictly scoped to upstream requests, never exposed or logged.
- Cloud-drive export, OAuth connectors and a conversational assistant do not exist, by design.
