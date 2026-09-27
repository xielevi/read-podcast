# Read Podcast

**English** · [简体中文](README.zh-CN.md)

> [!NOTE]
> **Cloudflare Free target; some release boundary checks pending.** The maintainer's Cloudflare application runs on the Workers Free plan. Large RSS feeds and long episodes have been exercised; multi-task cron recovery and CPU/subrequest headroom still need documented verification in [issue #30](https://github.com/xielevi/read-podcast/issues/30). Transcription and refinement may incur separate provider charges. Alternatively, run the same application on one host with Docker / Node, SQLite, local storage and local manuscripts—no Cloudflare account required.
>
> **Relation to v0.x (Python / macOS App)**: Read Podcast was originally a native macOS desktop app (v0.x, Python, MLX Whisper and DMG packaging). Desktop development is paused; the v0.x code is archived on [`legacy/python`](https://github.com/xielevi/read-podcast/tree/legacy/python). Starting with v1.0, one TypeScript codebase supports both Cloudflare and single-host Docker / Node deployments, with a responsive browser interface.

**A personal podcast reading system for Cloudflare or Docker.** Pick the episodes worth keeping, and Read Podcast turns
each one into a complete, readable long-form manuscript — not a summary — that you can read on
any device, share as a public page, and keep as Markdown in a store you own.

<p align="center">
  <img src="docs/assets/readme/library.webp" alt="Read Podcast workspace: subscriptions, episodes and an episode being turned into a manuscript" width="920">
</p>

## Why

Podcasts are one of the best places to hear people think out loud, and one of the worst places
to keep what they said. Audio is linear: you can't skim it, search it or quote it, and three weeks
later you can't find the ten minutes that mattered. The usual fix — an AI summary — answers
"should I listen?", but compresses away the argument itself: the follow-up questions, the
examples, the hesitation.

Read Podcast takes the opposite approach. The output is a **manuscript**: the whole
conversation, with speakers labelled, verbal noise removed and topics given headings — about as
long as the transcript it came from. You read it instead of re-listening, and it stays yours.

## How you use it

**Subscribe → Generate → Read → Share.** The workspace has three areas — *Subscriptions*,
*Import* and *Manuscripts* — plus the reader.

1. **Subscribe or import.** Add a podcast by searching the Apple Podcasts directory or pasting
   an RSS URL. The episode list comes from the feed and refreshes when you browse it. You can
   also import your own audio file (up to 200 MiB) — a talk, a lecture, an interview.
2. **Generate.** Nothing is processed automatically: you choose an episode and click
   *Generate*. Progress is real, reported in four stages — fetching audio, transcribing,
   refining, saving — and you can close the browser meanwhile. Imports let you pick a manuscript
   style (magazine edit, clean verbatim, structured interview) and add your own instructions.
3. **Read.** A focused reader with an outline and typography and theme settings; the owner
   also gets reading progress and read/unread state. **Key concepts** are proposed by the model
   the first time the owner opens a manuscript and kept only if they match a real Chinese
   Wikipedia article, so every concept link points to a real page. Every manuscript can be
   downloaded as Markdown.
4. **Share.** The same workspace is read-only at `/`: visitors can browse subscriptions and published manuscripts. State-changing actions live under `/manage`; protect that path and `/api/control/*` with Cloudflare Access on Cloudflare, or optional Basic Auth on Docker (which binds to localhost by default).

<p align="center">
  <img src="docs/assets/readme/reader.webp" alt="Read Podcast reader: a manuscript with outline and Wikipedia-verified key concepts" width="920">
</p>

Every published manuscript is a Markdown file with YAML front matter (title, podcast, date,
duration, source links), stored in the **Canonical Manuscript Store**: your own GitHub
repository on a Cloudflare deployment, or a local directory on the host when running with
Docker (ready for Obsidian or any editor). Read Podcast is the reading
interface in front of it: the database only indexes manuscripts, and the store holds the one durable
copy of each.

> **Language.** Read Podcast currently targets Chinese-language podcasts: the interface, the
> built-in refinement prompts and concept verification (Chinese Wikipedia) are all Chinese.
> Transcription itself auto-detects the language.

## Why it is built this way

Turning a two-hour episode into a manuscript takes tens of minutes of transcription and one
long LLM call. A script that does this in one go works until something fails halfway. Read
Podcast is built so that every expensive step happens once:

- **A durable pipeline, not a script.** Cloudflare runs each generation in a Workflow with persistent checkpoints in R2. Docker uses an in-process runner with SQLite checkpoints and local object storage. A failed refinement can reuse the raw transcript; a failed publish can reuse refined output instead of repeating expensive work.
- **Bring your own compute.** Transcription runs on a machine you choose — the reference is a
  Mac with Apple Silicon running MLX Whisper locally — behind a small HTTP contract. It holds no
  credentials and no durable business state, and only needs to be online while an episode is being transcribed.
  Refinement uses any OpenAI-compatible API you configure.
- **Edited, not summarized.** The default editor aims for roughly 75–85% of the raw transcript:
  verbal redundancy is compressed while independent information and reasoning stay intact.
  A separate completeness guard rejects output below the configured hard floor (default 70%) or
  without basic manuscript structure. A rejected result is never published; the transcript is
  kept so you can retry.
- **You own the output.** Manuscripts live in a store you control — a GitHub repository (plain
  Markdown, versioned) on Cloudflare, or a local directory on Docker. Public readers are served
  the exact version recorded at publish time,
  cached at Cloudflare's edge, so anonymous traffic does not hit GitHub on every read.
- **Public reading, private control, no accounts.** Access control is Cloudflare Access on two
  path prefixes. The application itself has no users, passwords or sessions.

## Architecture at a glance

The diagram below is the Cloudflare deployment. Docker / Node uses the same application code with SQLite instead of D1, an in-process checkpointed runner instead of Workflows, local files instead of R2, and a local manuscript directory by default. See [Docker deployment](docs/DEPLOYMENT.md#7-local-docker-deployment).

```mermaid
flowchart LR
    Browser["Browser / Mobile"] <--> CF
    subgraph CF["Cloudflare application"]
        direction TB
        D1[("D1<br/>business state")]
        WF["ProcessingWorkflow<br/>execution owner"]
        R2[("R2<br/>raw / refined / upload checkpoints")]
    end
    CF -->|"submit and poll"| TS["Transcription Service<br/>(your machine)"]
    TS -->|"raw transcript"| CF
    CF -->|"refine request"| RP["Refinement Provider<br/>(OpenAI-compatible API)"]
    RP -->|"refined text"| CF
    CF -->|"publish"| CMS["Canonical Manuscript Store<br/>(your GitHub repository)"]
```

In the Cloudflare path, Cloudflare owns every task from creation to publication; the other three boxes are replaceable dependencies it calls. Readers only talk to the application. In Docker, the local Node process owns the lifecycle instead.

**Where your data lives (Cloudflare path unless noted)**

| What | Where | Kept for |
|---|---|---|
| Subscriptions, episode lists, tasks, read state, settings, the index of published manuscripts | Cloudflare D1 | until you delete it |
| Uploaded audio | Cloudflare R2 `uploads/` | 1 day |
| Raw transcripts | Cloudflare R2 `raw/` | 7 days |
| Refined text checkpoints | Cloudflare R2 `refined/` | 7 days |
| Published manuscripts | Canonical Manuscript Store: your GitHub repository (Cloudflare) or a local directory (Docker) | durable — until you delete them |
| Podcast audio | not stored — the Transcription Service downloads it into a working directory for the job | deleted after the job |
| Credentials (GitHub, LLM, R2 signing, Access service token) | Wrangler secrets on Cloudflare | — |

The Transcription Service keeps only per-job working files and finished transcripts until
Cloudflare has collected them (at most a day); it has no database and no credentials. No API ever
returns a secret. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the invariants behind this.

## What you need to run it

Choose one deployment path:

- **Cloudflare:** a Cloudflare account with a domain on Cloudflare DNS, a transcription machine or provider, an OpenAI-compatible LLM API key, and a GitHub manuscript repository with a fine-grained write token. Workers (with static assets), D1, R2, Workflows, Cron, Access and optionally Tunnel are used. See [Cloudflare deployment](docs/DEPLOYMENT.md#2-cloudflare-application).
- **Docker / Node:** a single host with Docker Compose, an OpenAI-compatible LLM API key, and local disk space for SQLite, temporary objects and manuscripts. The Compose stack includes a Faster-Whisper transcription container; no Cloudflare account, domain or GitHub repository is required. See [Docker deployment](docs/DEPLOYMENT.md#7-local-docker-deployment).

**Cloudflare cost.** The maintainer's production deployment uses Workers Free; some release boundary checks remain. Free limits include 10 ms CPU per invocation (I/O waiting does not
count), 50 external subrequests and 1,000 Cloudflare service subrequests per invocation,
3,000 Workflow steps/day, five Cron Triggers per account, and three-day Workflow instance
state retention after completion. This application uses one Cron Trigger. Large RSS feeds
and long episodes have been exercised in production; that alone does not quantify
CPU/subrequest headroom. Multi-task cron recovery still needs a production boundary
check. See Cloudflare's current
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/) and
[Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/). The LLM cost is driven
by the transcript sent as input plus a manuscript of about the same length as output, billed by
your provider. Transcribing on your own machine adds no speech-to-text API fees (hardware and
electricity aside).

## Boundaries and trade-offs

- **One owner.** There is no multi-user model: whoever passes Cloudflare Access controls the
  workspace.
- **Public by default for reading.** Your subscription list (names and feed hosts only) and all
  published manuscripts are visible at `/`. To keep everything private, put the whole hostname
  behind Access instead of just the two control paths.
- **Publish snapshots.** Public pages serve the version recorded at publish time. If you edit a
  manuscript in your store (repository or local directory), the owner view shows the edit, but
  public readers keep seeing the published version until you generate the episode again.
- **The transcription machine must be reachable while transcribing.** Once the raw transcript
  is in R2 it can go offline; tasks already past transcription are unaffected.
- **Manual, per-episode generation.** New episodes are not processed automatically.
- **One manuscript store.** One store per deployment — GitHub on Cloudflare, a local directory
  by default on Docker. There is no cloud-drive export, OAuth
  connector or chat assistant, by design.

## Try it locally

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev                       # http://localhost:8787 (public) and /manage (owner view)
```

Locally there is no Access in front of `/manage`, and D1 and R2 are simulated. To generate a
manuscript end to end you also need a running Transcription Service, a Refinement Provider key and
a GitHub token, plus your manuscript repository in `.dev.vars`. The example already points
`TRANSCRIPTION_SERVICE_URL` at a local service on `http://127.0.0.1:28100`, which needs no Access
token.

The reference Transcription Service (Apple Silicon, local MLX Whisper) is zero-configuration —
no config file, no token:

```bash
deploy/macos/install.sh           # checks, uv sync, LaunchAgents for 127.0.0.1:28100 and :21567, health check

# or run the two processes directly while developing:
cd transcription_service && uv sync --locked
bin/run-service                   # 127.0.0.1:28100
bin/run-mlx                       # 127.0.0.1:21567
```

## Deploy

[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) walks through a production deployment: D1 and R2,
deployment values, secrets, Cloudflare Access, the Transcription Service and its Tunnel, and a
smoke test.

## Development

```bash
npm run check                     # TypeScript + Vitest
npm run check:frontend            # frontend syntax + bundle drift
UV_CACHE_DIR=/tmp/read-podcast-edge-uv-cache uv run --directory transcription_service pytest -q
npx wrangler deploy --dry-run
```

The repository is self-contained: runtime, build, test, deployment and upgrade depend on this
repository only.

## Documentation

| Document | What it covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, invariants, task lifecycle, security boundaries |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production setup, smoke test and operations |
| [docs/UPGRADING.md](docs/UPGRADING.md) | Upgrade paths, schema migrations, and breaking change handling |
| [docs/design.md](docs/design.md) | WebUI product language and visual system (Chinese) |
| [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) | Local development, validation commands, and PR guidelines |
| [.github/SECURITY.md](.github/SECURITY.md) | Vulnerability reporting and security architecture boundaries |
| [CHANGELOG.md](CHANGELOG.md) | Release history and version migration notes |
| [AGENTS.md](AGENTS.md) | Maintainer and agent guide |

## License

[MIT](LICENSE)
