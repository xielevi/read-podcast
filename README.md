# Read Podcast

**English** · [简体中文](README.zh-CN.md)

Pick a podcast episode you want to keep. Read Podcast turns it into a readable, long-form manuscript with speakers and sections, then saves the Markdown in storage you control. Read it on your phone, search for a passage later, or share the published page.

<p align="center">
  <img src="docs/assets/readme/library.webp" alt="Read Podcast subscriptions and manuscripts" width="920">
</p>

[Try it locally](#try-it-locally) · [Deploy on Cloudflare](docs/DEPLOYMENT.md#2-cloudflare-application) · [Run with Docker](docs/DEPLOYMENT.md#7-local-docker-deployment)

## From episode to manuscript

Add a podcast from Apple Podcasts or an RSS URL, or import an audio file (up to 200 MiB). Choose an episode and start generation; new episodes are **never processed automatically**. You can leave the browser while it fetches, transcribes, edits and saves the piece.

The editor removes verbal repetition while keeping the conversation's arguments and examples. The result is a substantial article, with headings and speaker labels, rather than a short recap. Read it in the browser with an outline and reading settings, or download the Markdown. The interface is available in Chinese and English; editorial prompts follow the spoken language, while Wikipedia concept links follow the reader's UI language. Custom editorial instructions take precedence.

<p align="center">
  <img src="docs/assets/readme/reader.webp" alt="Manuscript reader with outline" width="920">
</p>

Published manuscripts live in your own GitHub repository on Cloudflare, or in a local directory with Docker. The application keeps an index and serves the reading pages; your Markdown remains in the chosen manuscript store.

## Choose where it runs

| | Cloudflare | Docker / Node |
|---|---|---|
| Application | Worker, D1, Workflows and R2 | Single host, SQLite and local files |
| Manuscripts | Your GitHub repository | Local directory by default |
| Transcription | Your own service or configured cloud backend | Compose includes Faster-Whisper |
| Owner access | Cloudflare Access | Localhost by default; optional Basic Auth |

The reference local transcription service runs MLX Whisper on Apple Silicon. The service also implements Faster-Whisper and an opt-in OpenAI-compatible upload proxy; the Cloudflare Worker has a DashScope adapter. Availability and cost of external providers depend on your own configuration and account; see [deployment](docs/DEPLOYMENT.md). Refinement requires an OpenAI-compatible LLM API.

The maintainer runs the Cloudflare application on Workers Free, but that does not establish spare CPU, subrequest or Workflow capacity for every workload. Check [deployment limits](docs/DEPLOYMENT.md#resource-names-and-free-plan-boundary-checks) against your usage. LLM and cloud transcription providers may charge separately.

This is a single-owner workspace. Reading at `/` is public by default: visitors can browse subscriptions and published manuscripts. Protect the whole hostname if those should be private. On Cloudflare, `/manage*` and `/api/control/*` **must** be protected by Access before exposing the site; Docker binds to localhost by default. Generation is manual per episode.

## Try it locally

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev                       # http://localhost:8787; owner view at /manage
```

Local development has no Access gate. To generate a manuscript you also need a transcription service, LLM key and GitHub manuscript repository configured in `.dev.vars`. The example points to a local transcription service at `http://127.0.0.1:28100`; see [deployment](docs/DEPLOYMENT.md) for a production setup. For a single-host installation, use the [Docker guide](docs/DEPLOYMENT.md#7-local-docker-deployment) instead.

## Further reading

- [Deployment](docs/DEPLOYMENT.md) — setup, credentials, security boundaries, smoke tests and Free-plan limits
- [Architecture](docs/ARCHITECTURE.md) — task lifecycle, checkpoints and manuscript storage
- [Upgrading](docs/UPGRADING.md) — backups and schema migrations
- [Contributing](.github/CONTRIBUTING.md) · [Security](.github/SECURITY.md) · [Changelog](CHANGELOG.md)

The earlier Python/macOS desktop app is archived on [`legacy/python`](https://github.com/xielevi/read-podcast/tree/legacy/python); v1.0 is the TypeScript browser application with Cloudflare and Docker deployments. [MIT license](LICENSE).
