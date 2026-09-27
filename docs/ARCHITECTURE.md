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
Cloudflare. Any machine or remote service implementing the contract can replace it; the
reference implementation (`transcription_service/`) uses the local MLX Whisper engine, and
replaceability comes from this contract rather than from an in-process backend registry.

The reference service is **zero-configuration**: built-in runtime defaults (download limits,
timeouts, concurrency, result TTL), platform data/log directories, no user-maintained
configuration file and **no application credential** — request-scoped options (language) travel
with each request, and remote authentication is Cloudflare Access.

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
  stores no credential and no user-maintained configuration.
- Cloud-drive export, OAuth connectors and a conversational assistant do not exist, by design.
