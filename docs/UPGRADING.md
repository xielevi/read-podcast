# Upgrade Guide

This guide describes how to upgrade a production Read Podcast deployment, how database migrations
work, and how breaking changes must be documented in release notes.

Architecture invariants are documented in [ARCHITECTURE.md](ARCHITECTURE.md); operational and setup
steps are in [DEPLOYMENT.md](DEPLOYMENT.md).

---

## Architecture and Upgrade Principles

A Read Podcast deployment consists of two decoupled components:

1. **Cloudflare Application**: Cloudflare Worker, D1 database, Workflows engine, and R2 object storage.
2. **Transcription Service Host**: An independent, stateless speech-to-text compute node (reference: macOS Apple Silicon running MLX Whisper).

When upgrading, the following core principles must be maintained:

- **Zero Data Loss for Published Manuscripts**: Articles recorded in D1 and saved as Markdown files in your GitHub repository are durable and must never be altered or cascade-deleted by an upgrade.
- **Graceful In-flight Task Handling**: Database migrations and workflow upgrades must handle active tasks gracefully. Completed raw transcripts in R2 are preserved so that upgrading never forces already-transcribed audio to be re-transcribed.
- **Idempotent and Tracked Migrations**: D1 migrations are sequential, version-controlled SQL files tracked in the `d1_migrations` table by Wrangler.

---

## Standard Upgrade Procedure

Follow these steps in order when upgrading an existing production deployment.

### 1. Preflight Check: Inspect In-flight Tasks

Before applying migrations or deploying new code, check whether any podcast episodes are currently
being processed:

```bash
# Check remote production D1 database
scripts/preflight_upgrade.sh

# Or for local development
scripts/preflight_upgrade.sh --local
```

`scripts/preflight_upgrade.sh` lists all tasks in active processing states (`waiting_worker`,
`downloading`, `transcribing`, `refining`).

> [!TIP]
> **Why wait for active tasks?**
> Schema migrations are designed to safely requeue active tasks rather than letting them fail
> silently or become orphaned. However, requeued tasks will re-run the current processing step.
> Waiting for in-flight tasks to complete avoids re-consuming transcription or LLM refinement compute.

### 2. Apply D1 Database Migrations

Apply any newly introduced database schema migrations:

```bash
npm run db:migrate:remote
```

For local development databases:
```bash
npm run db:migrate:local
```

Wrangler automatically checks which migrations have already been applied and executes only new
`migrations/*.sql` files in numerical order.

### 3. Verify Storage and R2 Lifecycle Rules

If the upgrade introduces new storage prefixes or changes retention policies (e.g. the addition of
the `refined/` checkpoint prefix in migration `0015`), ensure R2 bucket lifecycle rules match the current
requirements:

```bash
# List existing lifecycle rules
npx wrangler r2 bucket lifecycle list read-podcast-edge-raw

# Add required rules if missing:
# 1. Raw transcripts: retain 7 days
npx wrangler r2 bucket lifecycle add read-podcast-edge-raw raw-7d raw/ --expire-days 7
# 2. Refined text checkpoints: retain 7 days
npx wrangler r2 bucket lifecycle add read-podcast-edge-raw refined-7d refined/ --expire-days 7
# 3. Audio uploads: retain 1 day
npx wrangler r2 bucket lifecycle add read-podcast-edge-raw uploads-1d uploads/ --expire-days 1 --abort-multipart-days 1
```

### 4. Deploy Updated Cloudflare Application

Run local validation and deploy the updated Worker bundle:

```bash
# 1. Run local checks
npm run check && npm run check:frontend

# 2. Dry run: validate bundle and deployment variables without deploying
npm run deploy -- --dry-run

# 3. Deploy live Worker, Workflows, and cron triggers
npm run deploy
```

If the release introduces new environment variables or Wrangler secrets, set them prior to deploying:
```bash
npx wrangler secret put NEW_SECRET_NAME
```

### 5. Update the Transcription Service Host

On your macOS transcription host machine, update the service using the provided lifecycle script:

```bash
# From the repository root on the transcription host:
deploy/macos/update.sh
```

`deploy/macos/update.sh` executes the complete upgrade flow safely:
1. Verifies that the local checkout has no uncommitted changes (`git status`).
2. Pulls upstream changes with fast-forward only (`git pull --ff-only`).
3. Syncs Python dependencies strictly according to `uv.lock` (`uv sync --locked`).
4. Executes the service test suite (`pytest -q`).
5. Restarts the LaunchAgent background services (`com.readpodcast.transcription` and `com.readpodcast.mlx`).

### 6. Post-Upgrade Verification (Smoke Test)

Verify that the upgrade succeeded:

1. **Transcription Service**:
   ```bash
   curl -fsS http://127.0.0.1:28100/health
   curl -fsS http://127.0.0.1:21567/health
   ```
2. **WebUI and Access**:
   Open `https://your-domain.example/manage`, log in via Cloudflare Access, and trigger a test in
   **Settings → Refinement Provider** and **Settings → Test Transcription**.
3. **Browse Mode**:
   Open `https://your-domain.example/` in a private window to verify that Public Browse Mode loads
   without requiring authentication.

---

## Docker / Node Upgrade Procedure

The Cloudflare D1 / R2 / Wrangler steps above do **not** apply to Docker. On a single-host
Docker deployment, stop creating new tasks and wait for active tasks to finish where possible.
Back up the Compose `web-data` volume (SQLite database, signing key and temporary checkpoints),
`./manuscripts/` (including `.versions/`), and your `.env` securely before changing images or
schema. Keep `transcription-data` if you do not want Faster-Whisper to download its models again.

Update the checkout, then run `docker compose up -d --build` to rebuild the web image and
recreate services while retaining the existing volumes and bind mount. The Node server applies
SQLite migrations on startup and resumes unfinished local workflows. Check
`docker compose ps`, `docker compose logs web`, and
`curl -fsS http://127.0.0.1:3000/api/public/health`, then verify existing manuscripts are
readable and a newly started task progresses. Never run `docker compose down -v` during an
upgrade: it removes the named data volumes. If changing the manuscript store from local to
GitHub, plan a separate data migration; switching configuration alone does not move manuscripts.

---

## Database Migration Guidelines for Contributors

When introducing changes that require database alterations:

1. **File Location and Naming**: Place migration files under `migrations/`. Use sequential, 4-digit
   zero-padded prefixes followed by snake_case names:
   ```text
   migrations/0022_add_new_feature_table.sql
   ```
2. **Backward Compatibility and Safety**:
   - Never drop or truncate the `articles` table or cascade-delete published records.
   - When altering existing tables (e.g. rebuilding tables to update `CHECK` constraints or drop columns),
     copy existing rows cleanly and preserve primary and foreign keys.
   - When modifying task statuses, ensure that active states map to valid new states (e.g. `queued`)
     and assign new attempt IDs so old workflow executions cannot write to updated tasks.
3. **Automated Testing**:
   Every new migration must have corresponding regression and migration tests added to
   `test/migrations.test.ts`. Tests must execute against SQLite with `PRAGMA foreign_keys = ON;`
   to replicate D1 behavior.

---

## Marking Breaking Changes in Release Notes

Whenever a release contains changes that require user action, downtime planning, or non-backward-compatible
behavior, maintainers must explicitly format the release notes as follows.

### Structure of Release Notes with Breaking Changes

Release notes must place a prominent warning banner at the top, followed by structured subsections:

```markdown
# Release v1.x.0

> [!WARNING]
> **BREAKING CHANGES**: This release requires running D1 database migrations and updating
> R2 bucket lifecycle rules before restarting workflows. Please read the upgrade notes below.

## ⚠️ Breaking Changes & Upgrade Steps

### 1. Database Migrations (Required)
- Migration `migrations/0022_xyz.sql` alters table `tasks`.
- **Action**: Run `npm run db:migrate:remote` before starting new tasks.
- **In-flight Tasks**: Active tasks in state `refining` will be safely requeued. We recommend
  running `scripts/preflight_upgrade.sh` and waiting for in-flight tasks to finish before applying.

### 2. Configuration & Secrets
- Added new optional secret: `NEW_FEATURE_KEY`.
- **Action**: Run `npx wrangler secret put NEW_FEATURE_KEY` if using the feature.

### 3. Storage & R2 Rules
- Introduced new R2 object prefix `refined/`.
- **Action**: Run `npx wrangler r2 bucket lifecycle add read-podcast-edge-raw refined-7d refined/ --expire-days 7`.

### 4. Transcription Service
- Updated dependencies in `transcription_service/pyproject.toml`.
- **Action**: Run `deploy/macos/update.sh` on the transcription host.

## What's Changed
- feat: ... (#...)
- fix: ... (#...)
```

### Checklist for Maintainers Before Tagging a Release

- [ ] Has `scripts/preflight_upgrade.sh` been tested against the new migration?
- [ ] Are all new migration files covered in `test/migrations.test.ts`?
- [ ] Are any new deployment variables documented in `.deploy.env.example` and `docs/DEPLOYMENT.md`?
- [ ] Are all secret names and placeholders compliant with project redaction standards?
- [ ] Does the release note include clear step-by-step upgrade instructions?
