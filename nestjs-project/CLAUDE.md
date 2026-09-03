# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **MinIO:** `docker compose exec minio mc ready local` — expect no error
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **Video worker:** `docker compose logs video-worker` — expect `Video worker started`

`minio`, `redis` and `video-worker` are part of "start the environment": the API declares `depends_on` with `condition: service_healthy` on the first two, and the worker is what drains the processing queue.

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP capture, SMTP `1025`, web UI `8025`
- `minio` — S3-compatible object storage, API `9000`, console `9001`, user/password `streamtube`
- `redis` — Redis 8, port `6379`, backs the BullMQ queue
- `video-worker` — background processor built from `Dockerfile.worker`; no HTTP port. **FFmpeg is installed only in this image**

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Tests that require the video-worker container

`src/worker/ffmpeg.util.integration-spec.ts` invokes the real `ffprobe` and `ffmpeg` binaries, which exist **only in the `video-worker` image** — the API image deliberately does not have them (`phase-03-videos/TD-08`). The spec is excluded from the default suite via `testPathIgnorePatterns` and has its own command, run in the other container:

```bash
docker compose exec video-worker npm run test:worker
```

Once a change touches the FFmpeg wrapper or the worker, `npm test` alone does not satisfy the Definition of Done — this command must pass too.

### Integration tests run against the migrated schema

`createTestDataSource` defaults to `synchronize: false`. Suites read the schema the migrations produced, so **the migrations must have been applied before running them**:

```bash
docker compose exec nestjs-api npm run migration:run
```

A missing migration now surfaces as a plain `relation "..." does not exist`. The previous default (`synchronize: true`) hid that by synthesising a schema from the entities at connect time — which also let the dev database drift into having tables with an empty `migrations` table, a state whose recovery destroys data. See `.claude/rules/typeorm-migrations.md`.

### Do not add `--forceExit`

All three suites exit on their own. If a run hangs, that is a signal worth chasing, not something to paper over: `--forceExit` also hides genuinely leaked handles, and it truncates any `afterAll` still in flight — including the one in `migrations.integration-spec.ts` that restores the schema.

A hang almost always means a query is stuck. The known instance was a deadlock from concurrent `DROP TABLE ... CASCADE` on FK-linked tables; the symptom was a Jest process surviving for days. Diagnose with `--detectOpenHandles` before reaching for a flag.

### Test execution

Integration and e2e suites share a single test database, so they must run serially. **This is now enforced by config** (`maxWorkers: 1` in the `jest` block of `package.json` and in `test/jest-e2e.json`) rather than by remembering a flag:

```bash
docker compose exec nestjs-api npm test
docker compose exec nestjs-api npm run test:e2e
docker compose exec video-worker npm run test:worker
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently. Both configs previously lacked the setting and the plain commands failed; do not remove `maxWorkers`.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Videos (Phase 03)

Upload, background processing and delivery of videos. Every video belongs to a channel, and every user has exactly one channel.

### Module layout — `src/videos/`

| File | Role |
|---|---|
| `entities/video.entity.ts` | `Video` entity; `VideoStatus` enum (`draft`, `uploading`, `processing`, `ready`, `failed`) |
| `videos.service.ts` | State machine (`canTransition`, `transition`, `markUploading`), `create` with retry-on-conflict, `resolveForDelivery` |
| `videos.controller.ts` | `GET /videos/:publicId/playback` and `/download` |
| `upload.controller.ts` | tus protocol surface, `@All(['videos/upload', 'videos/upload/*splat'])` |
| `upload.service.ts` | tus `Server` + lifecycle hooks (`onUploadCreate`, `onUploadFinish`, `onResponseError`) |
| `upload-quota.service.ts` | Per-channel concurrency and aggregate-bytes limits |
| `video-queue.service.ts` | Producer side of the `video-processing` queue |
| `tus-store.factory.ts` | Single source for the `S3Store` config, shared with the worker |
| `public-id.util.ts` | 11-char base62 id with rejection sampling |
| `delivery-filename.util.ts` | Sanitised filename for the download `Content-Disposition` |
| `videos.constants.ts` | Queue/job names, tus mount path, part sizing, job options |

The worker lives in `src/worker/` (`worker.module.ts`, `main.worker.ts`, `video.processor.ts`, `reaper.processor.ts`, `ffmpeg.util.ts`) and runs in its own container.

### Endpoints

| Method | Route | Auth | Notes |
|---|---|---|---|
| `POST` / `HEAD` / `PATCH` / `DELETE` | `/videos/upload[/:id]` | Bearer required | tus 1.0.0. Excluded from Swagger (`@ApiExcludeController`) — the contract is the tus protocol, not REST. Carries `@SkipThrottle()` |
| `GET` | `/videos/:publicId/playback` | Optional | Presigned GET URL + `expiresIn` |
| `GET` | `/videos/:publicId/download` | Optional | Presigned URL with a signed `attachment` disposition |

Both delivery endpoints are `@Public()` + `@OptionalAuth()`: anonymous callers reach any `ready` video, and the owner also reaches their own videos that are not ready yet. Anything else answers `404 VIDEO_NOT_FOUND` — never `403`, so unpublished videos cannot be enumerated.

### Upload path

Bytes never buffer in memory: `@tus/s3-store` translates the tus chunk stream into an S3 multipart upload (50 MB parts, ~200 for a 10 GB file). The route is mounted as a Nest controller so the global guard pipeline stays active, which is why `main.ts` creates the app with `bodyParser: false` and re-applies JSON parsing to every other route through `src/bootstrap.ts`.

`onUploadCreate` is where the defence lives — size ceiling, quota, and the draft row — because it is the only point that runs *before* any byte is stored.

### Processing

`onUploadFinish` transitions the video to `processing` and enqueues `video.process` on the `video-processing` queue with `deduplication: { id: videoId }`, so a retried final `PATCH` does not trigger a second transcode.

The `video-worker` container consumes it: `ffprobe` for duration/dimensions/full metadata, then a thumbnail at 10% of the duration scaled to 1280 wide, written to the public bucket. Success → `ready`; a file with no video stream → `failed` immediately (unrecoverable); transient failures retry three times before `failed`.

The same queue carries the hourly `reap` job, dispatched by `job.name` inside `VideoProcessor` — a second `@Processor` on the same queue would create a competing Worker.

### Storage layout

- `streamtube-videos` (private): `videos/{videoId}/source{ext}` — the tus upload id **is** this key
- `streamtube-thumbnails` (public-read): `thumbnails/{videoId}/auto.jpg`

Keys derive from the internal UUID, never from `public_id`, so a shared link reveals nothing about storage paths. They are deterministic, which is what makes a retried job overwrite instead of duplicate.

Presigned URLs are signed against `STORAGE_PUBLIC_ENDPOINT`, not the Compose-internal one — SigV4 signs the `Host` header, so a URL signed against `minio:9000` is invalid outside the Compose network. The reverse also holds: **a presigned URL is not reachable from inside a container**, which is why the delivery integration spec signs against the internal endpoint to exercise Range and `Content-Disposition`.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
