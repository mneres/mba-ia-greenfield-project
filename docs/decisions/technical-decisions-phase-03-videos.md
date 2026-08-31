---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-08-30
scope_description: "Backend foundation for video upload and processing: object storage, resumable 10GB ingest, background job queue and worker topology, FFmpeg metadata/thumbnail extraction, unique public video URL, video lifecycle states, streaming and download delivery."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — the only subproject with open decisions in this document. Receives the `videos` module (entity, migration, controller, service), the `storage` module (S3-compatible client + presigning), the `queue`/`processing` modules (BullMQ producer + worker), the tus ingest handler, new namespaced config factories + Joi keys, and the `minio` / `redis` / `video-worker` services in `nestjs-project/compose.yaml`.
- `next-frontend/` — **no open decision in this document.** Fase 03 is explicitly backend-only per the user's scope constraint: no screen, route, component, or BFF handler is built here. The upload UI, the player and the download button are Fase 04/05 capabilities and will be researched in their own documents. The four TDs marked `Cross-layer` below (TD-03, TD-06, TD-12, TD-13) define contracts the frontend will *later* consume — they are decided here because the backend implementation shape depends on them, and re-deciding them in Fase 05 would mean rewriting backend endpoints.

> Cross-doc anchors (already decided — do NOT reopen):
> - **Config system:** `@nestjs/config` global + Joi `validationSchema` + namespaced `registerAs()` factories, shared with the TypeORM CLI (`phase-01-configuracao-base/TD-01..TD-04`). New Fase 03 env keys follow that pattern verbatim (`storage.config.ts`, `queue.config.ts`) — applying an already-decided pattern is implementation, not a TD.
> - **Auth:** access JWT via `Authorization: Bearer` validated by custom `JwtAuthGuard` (`phase-02-auth/TD-02`), `@Public()` decorator for anonymous routes. Anonymous playback (Fase 05) relies on this existing mechanism.
> - **Error contract:** `{ statusCode, error, message }` with machine-readable `error` codes, emitted by `DomainExceptionFilter` (`phase-02-auth/TD-07`). All new video endpoints use it unchanged.
> - **Validation:** `class-validator` + `class-transformer` with the global `ValidationPipe` (`phase-02-auth/TD-06`).
> - **API documentation:** `@nestjs/swagger` + CLI plugin, `openapi.json` exported for FE codegen (`openapi-docs-nestjs/TD-01..TD-03`). New endpoints must be annotated so the artifact stays complete.
> - **Rate limiting:** `@nestjs/throttler` (`phase-02-auth/TD-08`).
> - **Testing conventions:** `*.spec.ts` / `*.integration-spec.ts` / `*.e2e-spec.ts` split, integration + e2e run `--runInBand` against real infrastructure in the compose network (`nestjs-project/CLAUDE.md`).
> - **Docker networking:** service names as hosts, never `localhost` (root `CLAUDE.md`).

> **Note on `**Decision:**` fields.** Per the user's explicit instruction for this run ("make sure all the open decisions are resolved and justified"), every TD below is emitted already decided rather than `_[pending]_`, and the frontmatter carries `status: decided`. Each `**Decision:**` line states the chosen option *and why that option beat the runner-up specifically* — not a restatement of the recommendation. Review and override any of them before running the plan pipeline; a changed choice at this stage is a one-line edit, whereas after `/plan-build` it is a Supersede.

---

## TD-01: Object Storage Backend and Client SDK

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The C4 diagram provisions an "Object Storage (S3 or MinIO)" container but leaves the client library open. This decision fixes the API surface every other storage-touching TD depends on (TD-02 layout, TD-03 ingest, TD-12 streaming, TD-13 download) and determines whether dev and production run the same code path.

**Options:**

### Option A: MinIO server in dev + `@aws-sdk/client-s3` v3 as the client
MinIO runs as a compose service speaking the S3 API; the application only ever knows the S3 protocol, pointed at a configurable endpoint.
- **Pros:** One code path for MinIO (dev) and S3/R2/Spaces (prod) — swapping is an env change. Modular v3 packages (`client-s3`, `s3-request-presigner`) keep only what is used. Already required transitively: `@tus/s3-store` declares `@aws-sdk/client-s3 ^3.1045.0` as a dependency, so it ships either way.
- **Cons:** Verbose command-object API. Some S3-compatible providers deviate on edge operations (`ListMultipartUploads` has known MinIO quirks).

### Option B: MinIO server + the official `minio` JS SDK (8.x)
Uses MinIO's own client, which also talks to AWS S3.
- **Pros:** Friendlier ergonomics (`fPutObject`, `presignedGetObject`). Guaranteed alignment with MinIO behaviour.
- **Cons:** Two S3 clients in the dependency tree, since `@tus/s3-store` pulls the AWS SDK regardless — two credential configurations, two endpoint configs, two presigners that must produce mutually compatible URLs. Smaller ecosystem and fewer NestJS examples.

### Option C: Local filesystem volume behind a `StorageService` interface
Files written to a Docker volume; the S3 implementation is deferred to a later phase.
- **Pros:** Zero new infrastructure. Trivial to test.
- **Cons:** Defers the real problem — no presigned URLs means TD-12 and TD-13 must proxy every byte through the API, which is the exact failure mode the phase exists to avoid. `@tus/s3-store` would be unusable, forcing `@tus/file-store` and a later rewrite. Nothing about the phase gets genuinely simpler.

**Recommendation:** Option A — the S3 protocol is the portable contract, and the AWS SDK is a non-negotiable transitive dependency anyway, so Option B would mean shipping two clients to solve a problem the first one already solves.

**Decision:** **A (MinIO service + `@aws-sdk/client-s3` v3)** — chosen over B on dependency arithmetic, not preference: `@tus/s3-store` (TD-03) hard-depends on `@aws-sdk/client-s3`, so picking the `minio` SDK adds a second client without removing the first, and creates a real hazard where the tus store and the application presigner disagree about endpoint/region/path-style configuration. Option C was rejected because it does not defer complexity, it relocates it into TD-12/TD-13 as a byte-proxy through the Nest process.

**Implementation consequence worth recording (cross-component, discovered during research):** MinIO signs URLs with SigV4, which covers the `Host` header. The API reaches MinIO at `http://minio:9000` (compose service name, per the root `CLAUDE.md` networking rule), but a URL signed for that host is unusable from the browser. Presigned URLs handed to clients must therefore be signed against a *separate* public endpoint. This requires two config keys, not one: `STORAGE_ENDPOINT` (internal, for server-side operations) and `STORAGE_PUBLIC_ENDPOINT` (used only by the presigner). Both go in the Joi schema, `compose.yaml`, and `.env.example`. `forcePathStyle: true` is required for MinIO.

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-02: Bucket Topology and Object Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Videos are private (Fase 04 adds `unlisted` visibility, enforceable only if the object itself is not publicly readable), while thumbnails are rendered by the dozen on anonymous pages (Fase 05 sidebar, Fase 07 home grid). Whether that difference is expressed in the storage layer or in application code is a cross-component decision: the API writes the keys, the worker writes the derived keys, and TD-12/TD-13 resolve them.

**Options:**

### Option A: Single bucket, access separated by key prefix (`videos/`, `thumbnails/`)
One bucket, one credential, prefixes as the only structure.
- **Pros:** Simplest provisioning. One bucket to create in the compose bootstrap.
- **Cons:** A single bucket has a single default access policy. Making thumbnails public then makes video sources public too, unless a prefix-scoped bucket policy is written and kept correct — the access rule lives in a JSON policy nobody reads.

### Option B: Two buckets — private `streamtube-videos`, public-read `streamtube-thumbnails`
Access policy is a property of the bucket; key layout inside each is `{videoId}/...`.
- **Pros:** The security rule is structural and unmissable: a video object cannot be leaked by a coding mistake, because its bucket denies anonymous reads. Thumbnails are plain cacheable URLs — no presigning per image, so a 40-video grid costs zero signing work and is CDN/browser-cacheable. Trivially maps to two buckets or two prefixes-with-CDN in production.
- **Cons:** Two buckets to provision and two config keys.

### Option C: Bucket per channel
Each channel gets its own bucket.
- **Pros:** Natural per-tenant isolation and per-channel usage accounting.
- **Cons:** AWS S3 caps buckets per account (100 by default, 1000 hard); a platform with thousands of channels cannot use this. Bucket creation on the signup path couples Fase 02 to storage. IAM policy count explodes.

**Recommendation:** Option B — the public/private split is a real, permanent property of the two asset kinds, and encoding it in the bucket makes the wrong thing impossible rather than merely discouraged.

**Decision:** **B (two buckets: private videos, public-read thumbnails)** — chosen over A because thumbnail delivery volume is what settles it: Fase 07's home grid renders dozens of thumbnails per page view, and under Option A every one of them needs a presigned URL (a signing operation per image, per request, with an expiry that defeats HTTP caching). Option B makes them ordinary cacheable URLs. Option C is disqualified outright by S3's per-account bucket limit — it cannot survive contact with production. Key layout: `videos/{video_id}/source{ext}` in the private bucket, `thumbnails/{video_id}/auto.jpg` in the public one, keyed by the internal UUID (never the public id from TD-06, so that a leaked public id reveals nothing about storage paths). Keys are deterministic, which is what makes retried jobs idempotent in TD-11. The `videos/{video_id}/` prefix leaves room for `videos/{video_id}/hls/` if the deferred HLS work in TD-12 is ever picked up — no migration needed.

---

## TD-03: Upload Ingest Protocol for 10GB Files

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** This is the phase's defining constraint. "Sem impacto na performance" plus the project-plan's attention point ("permita retomar em caso de falha de conexão") means the ingest path must (i) never buffer a multi-GB body in the Nest process, and (ii) resume after a dropped connection. This is `Cross-layer` because the handshake sequence is a wire protocol the Fase 04 upload UI must implement against — deciding it later would mean rewriting the backend ingest.

**Options:**

### Option A: tus resumable protocol server-side (`@tus/server` 2.x + `@tus/s3-store` 2.x)
The API exposes a tus endpoint; the store streams incoming chunks straight into an S3 multipart upload. `onUploadCreate` / `onUploadFinish` hooks bracket the transfer.
- **Pros:** Resume is the protocol's entire purpose — free, and standardised (any tus client works, including `tus-js-client` and Uppy). Bytes never accumulate in the process: `@tus/s3-store` forwards parts to S3 as they arrive. Ingest stays same-origin, so no CORS grant to the storage host. Hooks land exactly on capabilities 4 and 5.
- **Cons:** New protocol surface to operate. The tus handler owns its route and bypasses the Nest pipeline (guards/pipes/filters), so auth must be re-wired inside the hooks — see TD-04. Node body parsing must be disabled for that path.

### Option B: Presigned S3 multipart, browser uploads parts directly to storage
API creates the multipart upload, signs part URLs on demand, and completes it; bytes go browser → storage.
- **Pros:** Shortest possible byte path — the API never sees a single video byte. Native S3 feature, no extra dependency.
- **Cons:** Resume is not free: the client must persist `uploadId` + the ETag of every completed part, and the API must expose list/complete/abort endpoints — a hand-rolled reimplementation of what tus standardises. Requires a CORS grant on the bucket and the browser talking directly to the storage host, which sits badly with the strict-BFF rule in `next-frontend-config-base/TD-03`. Orphaned multipart uploads accumulate and bill until a lifecycle rule reaps them.

### Option C: `multipart/form-data` streamed through the Nest API
Classic single-request upload, piped to storage.
- **Pros:** Trivial client, one endpoint, nothing new to learn.
- **Cons:** No resume whatsoever — a dropped connection at 9.8GB restarts from zero, which directly violates the plan's stated attention point. One request occupies a connection for the full transfer duration.

**Recommendation:** Option A — resumability is a stated requirement, and tus is the only option where it is a protocol guarantee rather than application code the team writes and maintains.

**Decision:** **A (tus via `@tus/server` + `@tus/s3-store`)** — Option C is eliminated by the requirement itself (no resume). Against Option B, the deciding factor is *where the resume state machine lives*: B's byte path is genuinely better, but it buys that by making the API own multipart part-accounting, resume queries, and abort/cleanup — roughly the surface tus already specifies and tests. B also requires the browser to call the storage origin directly, which contradicts the strict-BFF posture already decided for the frontend. A keeps ingest same-origin and still avoids buffering, because `@tus/s3-store` translates the tus chunk stream into an S3 multipart upload internally. Configuration for the 10GB ceiling: `partSize: 50 * 1024 * 1024` yields ~200 parts for a 10GB file — comfortably inside AWS's 10,000-part limit and inside the 1,000-part limit some S3-compatible providers impose (MinIO included), while keeping per-part memory bounded.

**Consequence flagged for the Fase 04/05 frontend research (not decided here):** a Next.js Route Handler is a poor proxy for a 10GB tus stream. The FE phase will have to choose between a reverse-proxy path that keeps the upload same-origin without traversing the Next runtime, or an explicit exception to the strict-BFF rule for the upload endpoint only. Recording it here so it is not discovered mid-implementation.

**Libraries:** @tus/server, @tus/s3-store

**Revisions:**
- 2026-08-30 — Upload reaches the API through a same-origin reverse proxy that forwards straight to Nest without traversing the Next runtime; strict-BFF's actual invariant (the browser talks only to same-origin) is preserved and the 10GB streaming problem is solved at the deployment layer. Resolves the consequence this TD flagged for the Fase 04/05 frontend research. Rationale: Same-origin reverse proxy, bypassing the Next runtime.

---

## TD-04: Upload Authorization, Size and Content-Type Enforcement Seam

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** TD-03's tus handler owns its own route and never passes through the Nest guard/pipe/filter chain — `JwtAuthGuard` (`phase-02-auth/TD-02`) simply does not run on it. Where the 10GB ceiling, the JWT check and the file-type check are enforced is therefore a genuine architectural seam, not a detail: get it wrong and an unauthenticated client can fill the bucket.

**Options:**

### Option A: Enforce inside the tus lifecycle hooks + authoritative `ffprobe` check in the worker
`onIncomingRequest` verifies the JWT; `onUploadCreate` validates metadata and creates the draft row; `maxSize` caps the declared `Upload-Length`; the worker's `ffprobe` run is the authoritative content check.
- **Pros:** Every gate runs before bytes are stored — tus declares `Upload-Length` in the creation request, so an oversized upload is rejected at handshake. Single enforcement point, co-located with the handler that owns the route.
- **Cons:** Auth logic is invoked from hooks rather than from the guard, so the JWT verification service must be callable outside the DI request scope.

### Option B: A separate pre-registration endpoint guards everything, then hands off to tus
`POST /videos` (guarded normally) returns an upload ticket; the tus endpoint trusts the ticket.
- **Pros:** Auth stays in the familiar guard pipeline.
- **Cons:** The tus endpoint still receives raw bytes and must validate the ticket itself — the seam is not removed, only moved. A client can declare a small `Upload-Length` and then stream more; without `maxSize` on the tus server nothing stops it mid-stream.

### Option C: Accept everything, validate only in the worker
No upload-time gates; the processing job rejects bad files.
- **Pros:** Simplest handler.
- **Cons:** An unauthenticated attacker can write arbitrary multi-GB objects into the bucket before any check runs. Storage cost is incurred before validity is known.

**Recommendation:** Option A — the only option where every check happens before storage is consumed, which is the property that matters when the resource being protected is 10GB of paid storage.

**Decision:** **A (enforcement in tus hooks, `ffprobe` as the authoritative content check)** — Option C is rejected on abuse grounds alone. Option B is rejected because it does not actually eliminate the seam it was proposed to eliminate: the tus route still needs its own guard for the ticket, so the team ends up maintaining both a pre-registration endpoint *and* hook-level validation, for no gain. Client-declared `Content-Type` is treated as advisory only and never trusted — the authoritative decision is `ffprobe`'s stream list in the worker, which transitions the video to `failed` (TD-05) when no video stream is present. `maxSize` is set from a `STORAGE_MAX_UPLOAD_BYTES` env key (default 10 GiB) so the ceiling is one configured value referenced by the Joi schema, `compose.yaml` and the tus server options rather than a literal in three files.

**Revisions:**
- 2026-08-30 — JWT verification moves from the tus `onIncomingRequest` hook to the ordinary `JwtAuthGuard`: mounting tus as a Nest controller route (per TD-16) keeps the guard pipeline active for the request, so the hook-level check is no longer required. `Upload-Length`, metadata and content-type validation stay in the hooks, where a guard cannot see them. Option A is unchanged. Rationale: Guard pipeline restored by controller mounting.

---

## TD-05: Video Lifecycle State Model

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** The capability requires a video row to exist *before* the bytes finish arriving, and TD-11 needs a terminal state for permanently failed processing. Fase 04 then layers `rascunho → publicação` and `público/unlisted` on top of whatever is decided here, so the shape has to accommodate that without a rewrite.

**Options:**

### Option A: Single `status` enum column with explicit transitions
`draft → uploading → processing → ready | failed`, plus a nullable `processing_error`.
- **Pros:** One source of truth; "what state is this video in" is a single column read and a single index for Fase 04's dashboard listing. Illegal states are unrepresentable. Transitions are auditable in one service method.
- **Cons:** Adding a state later requires a migration on the Postgres enum type.

### Option B: Independent boolean flags
`is_uploaded`, `is_processed`, `is_published`.
- **Pros:** No migration to add a new flag.
- **Cons:** Permits contradictory combinations (`is_processed = true` with `is_uploaded = false`). Every query becomes a multi-predicate filter that must be kept consistent across call sites. There is no place to express `failed`.

### Option C: Append-only `video_processing_events` table, status derived
Each transition is a row; current status is a query.
- **Pros:** Full audit history for free.
- **Cons:** Every read needs an aggregate or a materialised column — reintroducing A's column anyway. BullMQ already persists attempt counts, timestamps and failure reasons per job (TD-07), so this duplicates an existing log for a pipeline with exactly one processing step.

**Recommendation:** Option A — a single enum is the smallest model that makes the illegal states unreachable and serves the Fase 04 dashboard query directly.

**Decision:** **A (single `status` Postgres enum + nullable `processing_error`)** — Option B is rejected specifically because `failed` has nowhere to live in a boolean model without adding a fourth flag whose relationship to the others is undocumented. Option C is rejected as duplicated bookkeeping: BullMQ's own job records already provide the history it would add, and the pipeline has one step, not a workflow. Deliberate exclusion: **`visibility` (`public` / `unlisted`) is a separate column owned by Fase 04, not a value in this enum.** Visibility and processing state are orthogonal axes — a video can be `ready` + `unlisted`, or `processing` + `public`-intended — and collapsing them would produce a combinatorial enum that Fase 04 would then have to unpick.

**Revisions:**
- 2026-08-30 — Draft payload at pre-registration fixed: `title` is NOT NULL, seeded from the sanitised upload filename with the extension stripped. Satisfies TD-13's download-filename dependency without a null branch and gives the Fase 04 dashboard a value to render; the user overwrites it when editing in Fase 04. Rationale: Title NOT NULL, seeded from upload filename.

---

## TD-06: Public Video Identifier and URL Strategy

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** The project-plan's attention point asks for "uma URL curta e única que nunca conflite". The identifier appears in the Fase 05 route (`/watch/{id}` or equivalent) and in every share link, so it is a contract the frontend routes on — and it must be immutable, because Fase 04 allows editing the video title.

**Options:**

### Option A: Expose the UUID primary key directly
`/watch/9f1c2e5a-...` — no extra column.
- **Pros:** Zero additional work. Uniqueness guaranteed by the PK.
- **Cons:** 36 characters — not "curta" by any reading. Exposes the internal primary key in every URL, coupling the public contract to the storage model (TD-02's keys use the same UUID).

### Option B: Separate short public id — 11 chars from a base62 alphabet, `UNIQUE`, generated app-side
Internal UUID PK stays internal; `public_id` is the only thing that appears in URLs and API paths.
- **Pros:** ~65 bits of entropy — collision probability stays negligible far beyond any realistic catalogue size, and a `UNIQUE` constraint with retry-on-conflict makes "never conflict" a database guarantee rather than a probability argument. Short and shareable (the format YouTube itself uses). Immutable and decoupled from both the title and the storage key.
- **Cons:** One extra indexed column; one generation utility to write and unit-test.

### Option C: Slug derived from the title, with a numeric disambiguation suffix
`/watch/meu-video-2`.
- **Pros:** Human-readable and marginally better for SEO.
- **Cons:** Conflicts by construction — two videos titled "Meu Vídeo" is the normal case, so the suffix logic runs constantly. Worse, Fase 04 makes the title editable: either the URL changes (breaking every existing share link) or the slug diverges from the title it was supposed to describe. Directly contradicts "sem conflito".

**Recommendation:** Option B — the only option that satisfies both "curta" and "nunca conflite" while surviving Fase 04's title editing.

**Decision:** **B (11-character base62 `public_id` column, `UNIQUE`, retry on collision)** — Option C is eliminated by the immutability requirement that Fase 04 imposes; a title-derived URL cannot be both stable and accurate once titles are editable. Option A is rejected less on aesthetics than on coupling: TD-02 keys storage objects by the internal UUID, so publishing that UUID would make the storage layout partially inferable from a share link. Generation uses `node:crypto.randomBytes` with a base62 alphabet rather than `nanoid`, because **nanoid v6 is ESM-only** and this backend compiles and tests as CommonJS (`ts-node --compiler-options '{"module":"CommonJS"}'`, ts-jest CJS transform) — the alternative would be pinning the legacy `nanoid@3` line, which is a worse trade than ~15 lines of `randomBytes` + modulo-bias-free alphabet mapping that the project can unit-test directly.

---

## TD-07: Background Processing Queue Infrastructure

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The C4 diagram provisions a "Message Queue (TBD)" container as an explicit architectural element and routes `API → publishes job → Queue → delivers job → Worker`. The jobs are FFmpeg runs over multi-GB files — minutes long, CPU-bound, and killable mid-flight — which is what the queue technology has to be chosen for.

**Options:**

### Option A: BullMQ + Redis, via `@nestjs/bullmq` 12.x
Redis-backed queue with atomic Lua state transitions.
- **Pros:** Purpose-built for exactly this job profile: per-job `updateProgress()`, per-worker concurrency limits, exponential backoff, and — critically — a stalled-job heartbeat that automatically requeues work whose worker died mid-execution. First-party NestJS integration (`@nestjs/bullmq` 12.0.0 declares `@nestjs/core ^10 || ^11 || ^12`, so NestJS 11 is supported). Rich, current documentation.
- **Cons:** Adds Redis as a second stateful service to run and operate.

### Option B: pg-boss on the existing PostgreSQL
Queue implemented over `SKIP LOCKED` in the database already in the stack.
- **Pros:** No new infrastructure. Job enqueue can share a transaction with the video row insert — genuinely attractive for the draft-creation path.
- **Cons:** A minute-long job holds a connection against the same Postgres instance serving application queries, so transcodes compete with OLTP for connections. No stalled-job heartbeat equivalent — a worker killed by the OOM killer mid-transcode leaves work in an ambiguous state until a timeout sweep. Progress reporting has to be hand-rolled.

### Option C: RabbitMQ via `@nestjs/microservices`
Classic broker with ack/nack semantics.
- **Pros:** Mature, language-agnostic, strong routing primitives.
- **Cons:** Heaviest operational footprint of the three. Ack/nack gives delivery semantics but not job *state* — retry counts, progress, and failure reasons all have to be persisted separately. Routing topologies are capability the project does not need for one queue with one consumer.

**Recommendation:** Option A — the job profile (long, CPU-bound, killable) maps onto BullMQ's stalled-job recovery and progress model, and the architecture already budgets for a dedicated queue container.

**Decision:** **A (BullMQ + Redis via `@nestjs/bullmq`)** — the real contest is against Option B, and the deciding property is worker-death recovery. A 10GB transcode is exactly the kind of work that gets OOM-killed or evicted mid-run; BullMQ's lock-renewal heartbeat detects that and requeues automatically, whereas pg-boss requires a timeout sweep and leaves a window where a video is stuck in `processing` with nothing scheduled. The secondary argument is resource contention: pg-boss puts minute-long job execution on the same connection pool as the request path, which reintroduces "impacto na performance" at the database layer. The Redis container is accepted as a deliberate cost, consistent with the C4 diagram already reserving a queue container. Option C is rejected as operationally heavier while providing *less* of what this workload needs (no persisted job state or progress). Compose gets a `redis` service; the connection host is `redis` (service name), never `localhost`.

**Libraries:** @nestjs/bullmq, bullmq

---

## TD-08: Video Worker Deployment Topology

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The C4 diagram draws the Video Worker as its own container. This TD confirms or overrides that, and decides what runs inside it — the answer determines the Docker image, how config and entities are shared, and whether a transcode can degrade API latency.

**Options:**

### Option A: Separate `video-worker` container running a NestJS standalone application context
`NestFactory.createApplicationContext(WorkerModule)` — no HTTP server, same codebase, its own image with FFmpeg installed.
- **Pros:** CPU isolation: a saturating FFmpeg run cannot starve the API's event loop or inflate request latency. The API image stays slim while only the worker image carries FFmpeg. Full DI reuse — `ConfigModule` + Joi validation, TypeORM entities, and the storage service are shared verbatim, with zero duplicated bootstrapping. Scales independently. Matches the documented architecture.
- **Cons:** A second Dockerfile and compose service; two processes to observe in development.

### Option B: In-process worker inside the API container
BullMQ `Worker` registered in `AppModule`, same process as HTTP.
- **Pros:** One container, one process, simplest compose file.
- **Cons:** FFmpeg spawned from the API container means the API image must ship FFmpeg, and a transcode competes for the same CPU as request handling — reintroducing the performance impact the phase exists to prevent. A worker OOM kill takes the API down with it.

### Option C: Standalone non-Nest Node script
A plain `worker.ts` with its own BullMQ worker and its own DB/S3 clients.
- **Pros:** Minimal startup, no framework overhead.
- **Cons:** Re-implements config loading, env validation, the TypeORM data source and the storage client outside DI — four things that then drift from the API's versions. Contradicts the Single Responsibility / shared-module principle in the root `CLAUDE.md`.

**Recommendation:** Option A — CPU isolation is the whole point of moving processing off the request path, and a standalone Nest context buys that without giving up code sharing.

**Decision:** **A (separate `video-worker` container, NestJS standalone application context)** — Option B is rejected because it undoes the phase's core objective: putting FFmpeg in the API process means a single 10GB transcode measurably degrades every concurrent request, which is the failure the queue was introduced to prevent. Option C is rejected on the Single Responsibility grounds in the root `CLAUDE.md` — duplicating config, env validation, entities and the storage client outside DI creates four drift surfaces, and `createApplicationContext` avoids all of them at the cost of a few hundred milliseconds of startup. Concretely: the API process registers only the producer (`BullModule.registerQueue`) and never instantiates a `Worker`; the worker process boots `WorkerModule` and hosts the `@Processor`. The worker image extends the same `node:25.6.0-slim` base with `apt install -y ffmpeg` (the current `Dockerfile.dev` has no FFmpeg — the API image deliberately keeps it that way).

---

## TD-09: FFmpeg Invocation Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Both processing capabilities are FFmpeg calls. How the worker invokes the binary determines the dependency risk on the single most critical path in the phase.

**Options:**

### Option A: `node:child_process.spawn` of the system `ffmpeg` / `ffprobe`, behind a small typed wrapper
Direct process invocation; `ffprobe -v quiet -print_format json -show_format -show_streams` returns metadata as JSON.
- **Pros:** Zero dependencies, zero abstraction drift — any FFmpeg flag is available immediately. `ffprobe`'s JSON output *is* capability 5's deliverable, parsed directly. `stderr` streams progress lines that map onto `job.updateProgress()`. Nothing to go unmaintained.
- **Cons:** The team writes and tests the wrapper (arg construction, exit-code handling, stderr parsing) — perhaps 80–120 lines.

### Option B: `fluent-ffmpeg`
The long-standing chainable Node wrapper.
- **Pros:** Familiar chainable API and a large body of tutorials.
- **Cons:** **Deprecated by its author and the repository archived in May 2025**, with an explicit notice that it "no longer works properly with recent ffmpeg versions". No TypeScript support, callback-based, unmaintained since 2020 in practice.

### Option C: `ffmpeg.wasm`
WebAssembly build, no system binary needed.
- **Pros:** No binary to install; identical behaviour across platforms.
- **Cons:** Roughly an order of magnitude slower than native and constrained by the WASM memory ceiling — categorically unusable on multi-GB inputs.

**Recommendation:** Option A — the only option that is neither unmaintained nor performance-disqualified, and the wrapper it requires is small and directly testable.

**Decision:** **A (direct `spawn` of `ffmpeg` / `ffprobe`)** — Option B is disqualified on a hard fact rather than a preference: adopting a package its own author has deprecated and archived, into the most critical path of a greenfield 2026 project, is knowingly taking on abandonware. Option C is disqualified by the 10GB input size. Newer typed wrappers (e.g. `mediaforge`) were considered and set aside — they solve fluent-ffmpeg's ergonomics problem, but their adoption and maintenance track record is too short to justify placing them on this path when the wrapper being replaced is ~100 lines of `spawn` the project can own outright. The binary is installed via `apt install -y ffmpeg` in the worker image (TD-08), pinned by the base image tag, so there is no runtime download and no native compilation step.

**Revisions:**
- 2026-08-30 — Persisted metadata set fixed: `duration`, `width` and `height` become typed columns (the fields Fase 04/05/07 query); the full `ffprobe` output is retained verbatim in a `jsonb` column. Costs ~5KB per video and removes the backfill hazard — no later-discovered field requires re-downloading a multi-GB source to re-run ffprobe. Rationale: Typed columns for queried fields, raw ffprobe JSON retained.

---

## TD-10: Thumbnail Extraction Policy

**Scope:** Backend

**Capability:** Geração automática de thumbnail a partir de um frame do vídeo

**Context:** "A partir de um frame" leaves open *which* frame, at what dimensions, and in what format. The answer is cross-component — the worker produces it, TD-02 stores it, and Fase 05/07 render it at fixed sizes — and it is not resolvable from FFmpeg documentation alone, since it is a product judgement about what a good default frame is.

**Options:**

### Option A: Single frame at 10% of duration, scaled to 1280×720, JPEG
`ffmpeg -ss <0.1 * duration> -i input -frames:v 1 -vf scale=1280:-2 -q:v 3`.
- **Pros:** Deterministic and cheap — input-side `-ss` seeks directly, so cost is ~1s regardless of file size. 10% skips the near-universal black frame / logo intro that a fixed 2–3s offset lands on. One image per video.
- **Cons:** Can still land on an uninteresting frame; no quality heuristic.

### Option B: FFmpeg `thumbnail` filter over an initial window
`-vf thumbnail=N` scores frames and picks the most representative.
- **Pros:** Meaningfully better frame selection on average.
- **Cons:** Must decode a window of frames to score them, so cost scales with the decode window rather than being a single seek — minutes of extra CPU per video on large sources, for a marginal aesthetic gain.

### Option C: Multiple candidates (10% / 30% / 50%), one marked default
Three frames stored; the user later picks.
- **Pros:** Sets up a "choose your thumbnail" UX.
- **Cons:** 3× the thumbnail storage and 3× the extraction cost for a feature nobody has asked for — Fase 04's capability is explicitly *"thumbnail customizada"* (upload your own), not candidate selection.

**Recommendation:** Option A — the cheapest option that reliably avoids the failure mode (black intro frame), with a deterministic cost that does not grow with file size.

**Decision:** **A (single frame at 10% of duration, 1280×720 JPEG, quality 3)** — Option B is rejected on cost asymmetry: it pays a decode window measured in CPU-minutes on a 10GB source to improve a default image the user can replace in Fase 04 anyway. Option C is rejected because it pre-builds for a UX that Fase 04 does not actually specify, and pays storage for it on every video forever. Format is JPEG rather than WebP because FFmpeg's WebP encoder is a build-time option not guaranteed present in Debian's packaged `ffmpeg`, and the byte-size advantage is irrelevant at one image per video. 1280×720 is the largest size any Fase 05/07 surface renders — downscaling in the browser is free, upscaling is not. The output key is deterministic (`thumbnails/{video_id}/auto.jpg`, TD-02), which is what makes a retried job overwrite rather than duplicate (TD-11).

---

## TD-11: Processing Job Reliability and Idempotency

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** Two failure classes have to be told apart: transient (storage timeout, worker OOM-kill, network blip) and permanent (corrupt or non-video input). Treating them identically either burns CPU forever on a corrupt file or gives up on a recoverable one. The tus `onUploadFinish` hook can also fire more than once, since tus clients retry the final PATCH — so double-enqueue is a real, not theoretical, case.

**Options:**

### Option A: `jobId = videoId`, bounded retries with exponential backoff, terminal `failed` state
Three attempts, exponential backoff from 30s, `removeOnFail` retained for diagnostics; deterministic output keys make retries overwrite.
- **Pros:** BullMQ deduplicates by `jobId`, so a repeated `onUploadFinish` is a no-op rather than a second transcode. Transient failures self-heal within three attempts; permanent ones land in `failed` (TD-05) with `processing_error` set, so the state is always legible. Idempotency is structural — TD-02/TD-10 keys are derived from `video_id`, so a retry overwrites the same objects instead of accumulating orphans.
- **Cons:** A genuinely transient failure that outlasts three attempts needs a manual requeue.

### Option B: Unbounded retries into a dead-letter queue
Retry forever with backoff; park in a DLQ after a long horizon.
- **Pros:** Nothing is ever silently dropped.
- **Cons:** A corrupt upload — the common permanent case — is retried indefinitely, each attempt costing a full FFmpeg run on a multi-GB file. Optimises for the rarer failure class at the expense of the common one.

### Option C: Fire-and-forget, manual reprocess only
One attempt; failures require operator action.
- **Pros:** Trivial.
- **Cons:** Any transient blip strands the video in `processing` with nothing scheduled and no signal, which is the worst possible user-visible state.

**Recommendation:** Option A — bounded retries plus a terminal failed state is the only option that handles both failure classes correctly and keeps the state model of TD-05 truthful.

**Decision:** **A (`jobId = videoId`, 3 attempts, exponential backoff from 30s, terminal `failed`)** — Option B is rejected on the cost of its common case: corrupt input is the failure mode that actually occurs, and retrying an FFmpeg run over a 10GB file forever is an unbounded CPU liability for zero chance of success. Option C is rejected because it makes TD-05's `processing` state a lie — a video sits there permanently with no job behind it. Setting `jobId` to the video id is the specific mechanism that makes tus's retried final PATCH safe, which is why this is a decision rather than default queue configuration. BullMQ's stalled-job lock renewal (TD-07) covers the OOM-kill case separately from the attempt counter: a worker killed mid-transcode has its job requeued rather than counted as a failed attempt.

---

## TD-12: Streaming Delivery Strategy

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** The plan's attention point requires playback to start without downloading the whole file. The C4 diagram already draws `Frontend → Object Storage: Streams, HTTPS`, i.e. the byte path is meant to bypass the API. This is `Cross-layer` because it fixes what the Fase 05 player receives from the API, but no frontend code is written in this phase.

**Options:**

### Option A: API issues a short-lived presigned GET URL; the client streams directly from storage
`GET /videos/{publicId}/playback` returns a signed URL; S3 and MinIO both serve HTTP Range on GET natively.
- **Pros:** Zero API involvement per byte — the phase's performance requirement is met by construction. A plain `<video src>` seeks correctly with no client-side work, because Range is handled by the storage server. Matches the documented architecture. Access control stays with the API, which is where Fase 04's `unlisted` rule will live.
- **Cons:** URL expiry has to outlast a viewing session, since each Range request re-presents the same signed URL. The signed URL must be issued against the public endpoint (TD-01), not the internal one.

### Option B: API proxies bytes, parsing `Range` and emitting `206` / `Content-Range`
NestJS `StreamableFile` with manual Range handling.
- **Pros:** One origin; per-request authorization on every chunk; no presigning concerns.
- **Cons:** Every byte of every view traverses the Nest process — precisely the "impacto na performance" the phase exists to eliminate, and worse than the upload case because reads vastly outnumber writes. Requires a hand-written Range parser.

### Option C: Transcode to HLS segments + manifest during processing
Adaptive-bitrate ladder produced by the worker.
- **Pros:** The correct answer for a production video platform — adaptive quality, fast start, CDN-friendly.
- **Cons:** Requires per-resolution transcoding, multiplying processing CPU and storage by roughly 4×. The phase's stated deliverable is "streaming funcionando", not adaptive bitrate.

**Recommendation:** Option A — it satisfies the requirement with the byte path the architecture already specifies, and leaves the door open to Option C later.

**Decision:** **A (short-lived presigned GET, Range served by the storage layer)** — Option B is rejected as directly contrary to the phase's premise; proxying reads is a heavier load than proxying writes, since a single upload is amortised over many views. Option C is deferred rather than rejected: it is the right long-term answer, but a 4× CPU and storage multiplier is not justified by a deliverable that asks only for progressive streaming, and TD-02's `videos/{video_id}/` prefix already leaves room for `hls/` siblings so adopting it later needs no migration or URL change. Presigned URL TTL is set to **6 hours** — long enough that a viewing session never sees a mid-playback 403 (each Range request re-validates the same signature), short enough that a leaked link is not a permanent public mirror; it goes in config as `STORAGE_PLAYBACK_URL_TTL_SECONDS` rather than a literal.

**Cross-doc note:** this has the browser fetching bytes from the storage origin, which is a narrow exception to the strict-BFF posture in `next-frontend-config-base/TD-03`. It is consistent with that decision's intent rather than in conflict with it — the BFF still mediates *authorization* (it is the API that decides whether to issue a URL, and Fase 04's `unlisted` rule is enforced there), and what the browser receives is an opaque signed resource URL, not an API endpoint. Recorded explicitly so the Fase 05 research does not re-litigate it.

---

## TD-13: Download Delivery Strategy

**Scope:** Cross-layer

**Capability:** Download do vídeo pelo usuário

**Context:** Download shares TD-12's byte path but has a different requirement: the browser must save the file, under a human-readable name, rather than play it inline.

**Options:**

### Option A: Separate presigned GET with a `response-content-disposition` override
`GET /videos/{publicId}/download` returns a URL signed with `response-content-disposition=attachment; filename="<title>.mp4"`.
- **Pros:** S3 and MinIO both honour the response-header override in the signature, so the storage layer itself forces the download and sets the filename — no API in the data path, and the internal storage key is never exposed. A distinct endpoint gives Fase 04's visibility rules and any future quota gate a clean hook.
- **Cons:** A second presigning path, near-identical to TD-12's.

### Option B: API proxies the bytes with `Content-Disposition: attachment`
Nest streams the object and sets the header itself.
- **Pros:** Full control over the header; per-request authorization.
- **Cons:** Puts the full file through the Nest process — the same cost TD-12 rejected, and a download is by definition the full 10GB rather than a seek window.

### Option C: Reuse the playback URL with `<a download>` on the frontend
No new endpoint.
- **Pros:** Zero backend work.
- **Cons:** **The `download` attribute is ignored for cross-origin URLs** — which is exactly this case, since the URL points at the storage origin. The browser navigates to the video instead of saving it. The mechanism does not work.

**Recommendation:** Option A — the only option that produces an actual download without putting the file through the API.

**Decision:** **A (dedicated `/download` endpoint returning a presigned URL with `response-content-disposition`)** — Option C is eliminated on a factual browser constraint rather than a trade-off: `<a download>` is a same-origin-only mechanism, so it silently fails against a storage-origin URL. Option B is rejected for the same reason as TD-12 Option B, amplified — a download transfers the entire file, so proxying it is the single most expensive thing the API could do. The endpoint is kept separate from `/playback` rather than parameterised, because Fase 04 will very likely gate them differently (a video can be watchable but not downloadable) and splitting them later would be a breaking contract change. The download filename is derived from the video title, sanitised, with the source extension — the storage key (TD-02) is never revealed.

---

## TD-14: Integration-Test Strategy for Storage and Queue

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The project's Definition of Done requires the full suite to pass, and `nestjs-project/CLAUDE.md` already fixes a testing model: integration and e2e suites run `--runInBand` against the real `db` service inside the compose network. Fase 03 introduces two more stateful dependencies, and whether they follow that model or a different one has to be decided once rather than per-suite.

**Options:**

### Option A: Real `minio` and `redis` compose services, shared by dev and the test suites
Same pattern as the existing `db` service; isolation via per-suite key prefixes and queue-name namespacing plus `--runInBand`.
- **Pros:** One uniform rule ("integration tests hit real infrastructure in the compose network") instead of two divergent mechanisms. Catches the failures that actually occur here — presigned-signature/host mismatches under MinIO, Range semantics, multipart part-size limits — none of which a fake reproduces. No change to the existing test commands.
- **Cons:** Test runs depend on two more services being healthy.

### Option B: Testcontainers, spinning MinIO and Redis per suite
Programmatic container lifecycle inside the tests.
- **Pros:** Full per-suite isolation; suites are self-contained.
- **Cons:** The project's strict container-only command rule means tests run *inside* `nestjs-api`, so Testcontainers would need Docker-in-Docker or a mounted Docker socket. Container startup per suite adds substantial wall-clock time. It would also be a second, divergent infrastructure model alongside the existing shared `db`.

### Option C: In-memory fakes (S3 mock, in-process BullMQ)
No real infrastructure in tests.
- **Pros:** Fastest; no service dependencies.
- **Cons:** Fakes cannot reproduce the class of bug this phase is most exposed to — SigV4 host mismatches, `forcePathStyle` behaviour, Range responses, multipart part limits. Tests would pass while production breaks, which is worse than not having them.

**Recommendation:** Option A — it extends the model the project already uses rather than introducing a second one, and it is the only option that exercises the S3-compatibility surface where this phase's real bugs live.

**Decision:** **A (real `minio` + `redis` compose services, shared with dev, `--runInBand`)** — Option C is rejected because the specific failures this phase risks are all in the protocol layer that a fake replaces; a green suite built on mocks would provide false confidence about exactly the parts most likely to be wrong. Option B is rejected on friction with an existing, already-decided constraint: the project mandates that every `npm`/`npx`/test command runs inside the `nestjs-api` container, and Testcontainers from inside a container requires Docker-socket plumbing that buys isolation the project already achieves more cheaply. Isolation follows the established approach — suites namespace their object keys by prefix and their queues by name, and `--runInBand` (already mandatory for the shared DB) prevents cross-suite interference. Unit tests (`*.spec.ts`) continue to mock the storage and queue clients entirely, per the existing suffix contract; FFmpeg is exercised only in integration tests, against a small committed fixture video rather than a generated 10GB file.

---

## TD-15: Access-Control Policy for the Playback and Download Endpoints

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** TD-12 and TD-13 fix *how* bytes are delivered (presigned GET) but deliberately left *who may ask for a URL* undecided — TD-13 explicitly deferred it. The backend cannot ship either endpoint without an answer, and the answer is constrained from two directions: Fase 05 requires "Acesso anônimo à visualização de vídeos" **and** places "Botão de download do vídeo" on that same anonymous page, while Fase 04 introduces `unlisted` visibility (reachable by direct link, absent from listings). `Cross-layer` because the policy determines whether the Fase 05 player and download button must carry a session at all.

**Options:**

### Option A: Both endpoints `@Public()`, no gating in this phase
Anyone with a `publicId` gets a URL; all authorization deferred to Fase 04.
- **Pros:** Smallest surface now; nothing to unwind when Fase 04 lands visibility.
- **Cons:** A `publicId` is guessable-by-leak, and with no state check a video still in `uploading` or `failed` would hand out a presigned URL to a zero-byte or partial object. Fase 04 would have to retrofit gating into two endpoints already in use.

### Option B: Both `@Public()`, gated on **resource state** rather than identity, with an owner bypass
Anonymous access is allowed only when `status = ready`; the owner (authenticated, channel matches) may also fetch URLs for their own non-`ready` videos. Fase 04's `visibility` slots into the same guard as a second predicate.
- **Pros:** Satisfies Fase 05's anonymous requirement literally while making draft/processing videos non-enumerable. The check is on the resource, so `unlisted` in Fase 04 is one added condition in one place, not a new gate. Owner bypass gives the uploader a preview path with no extra endpoint.
- **Cons:** Requires optional-authentication on a public route (parse the JWT when present, do not reject when absent) — a third mode alongside the existing `@Public()` / guarded pair.

### Option C: Playback `@Public()`, download requires authentication
Watching is anonymous; saving the file requires an account.
- **Pros:** A defensible product stance — download is the expensive operation, so tie it to an identity.
- **Cons:** Contradicts Fase 05, which puts the download button on the anonymous watch page with no stated auth condition. Adopting it is a product decision this phase is not entitled to make.

**Recommendation:** Option B — it is the only option that satisfies Fase 05's anonymous access as written while preventing a presigned URL from ever being issued for an object that does not yet exist.

**Decision:** **B (both `@Public()`, gated on resource state, with owner bypass)** — Option A is rejected on a concrete failure rather than a principle: with no state predicate, a `GET /playback` on a video still in `uploading` returns a signed URL to an object that is absent or partial, so the client gets a storage 404 instead of a meaningful API error. Option C is rejected because it silently overrides a Fase 05 capability from inside a Fase 03 TD — if the team wants download gated on identity, that belongs in the project plan, not here. Concretely: both endpoints are `@Public()`; the service resolves the video by `public_id` and returns `404` (not `403`) for anything not `ready`, so non-ready videos are indistinguishable from non-existent ones and cannot be enumerated. The owner bypass reads an **optional** JWT — a new `@OptionalAuth()` decorator that populates `request.user` when a valid `Authorization` header is present and leaves it undefined otherwise, never rejecting. This is deliberately additive to `phase-02-auth/TD-02`'s custom guards and does not modify them. The `visibility` predicate from Fase 04 lands in the same resolver method.

---

## TD-16: Upload Abuse Prevention — Concurrency and Storage Quota

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** TD-04 caps a single upload at 10 GiB but nothing bounds how many uploads a user starts, concurrently or over time. Two inherited facts leave this surface completely unthrottled: `phase-02-auth/TD-08` scopes `@nestjs/throttler` to `AuthModule` via a module-level `APP_GUARD`, and TD-04 asserts the tus handler bypasses the Nest guard pipeline. The second fact turns out to be a property of *how tus is mounted*, not of tus — see the note below — which materially widens the option set.

**Options:**

### Option A: Per-user quota checked once in `onUploadCreate`
Enforce (i) max concurrent uploads in `uploading` status and (ii) max total stored bytes per user, via one indexed `COUNT`/`SUM` against the `videos` table at upload creation. tus is mounted inside a Nest controller so `JwtAuthGuard` and `ThrottlerGuard` also apply to the creation request.
- **Pros:** Bounds the resource that actually costs money — bytes and concurrent transfers — rather than request count. One check, at the only moment where refusing is cheap (before any byte is stored). Mounting inside a controller restores the whole Nest pipeline (guards, filters, Swagger annotation) for the creation request.
- **Cons:** The quota query runs per upload creation; needs an index on `(channel_id, status)`. Requires `bodyParser: false` at bootstrap with JSON parsing re-applied to the non-tus routes.

### Option B: `@nestjs/throttler` with Redis storage applied to the upload route
Extend the inherited throttler to cover uploads, swapping in a Redis-backed `ThrottlerStorage` now that Redis exists per TD-07.
- **Pros:** Reuses an already-decided library; Redis storage survives restarts and would scale to multiple API instances.
- **Cons:** Throttles the wrong quantity. One tus upload is 1 `POST` plus ~200 `PATCH` requests at TD-03's 50MB part size, so any request-rate limit tight enough to deter abuse also breaks a single legitimate 10GB upload, and any limit loose enough to permit it deters nothing. It also does not bound stored bytes at all.

### Option C: No enforcement beyond TD-04's per-upload cap; accept and document the risk
Ship as-is; revisit if abuse appears.
- **Pros:** Zero work now.
- **Cons:** Leaves an authenticated user able to consume unbounded paid storage, on the project's most expensive resource, with no ceiling and no alert.

**Recommendation:** Option A — the unit of abuse here is bytes and concurrent transfers, and only A measures those; B measures requests, which is uncorrelated with the cost being defended.

**Decision:** **A (per-user concurrency + storage quota enforced in `onUploadCreate`, tus mounted inside a Nest controller)** — Option B is rejected on an arithmetic argument, not a preference: at TD-03's 50MB `partSize` a single 10GB upload issues roughly 200 `PATCH` requests, so a request-rate limit cannot separate one legitimate large upload from abuse, and it leaves aggregate stored bytes entirely unbounded. Option C is rejected because the exposure is unbounded paid storage behind a single authenticated account. Limits are configuration, not literals: `UPLOAD_MAX_CONCURRENT_PER_USER` (default 3) and `UPLOAD_MAX_TOTAL_BYTES_PER_USER` (default 50 GiB), both added to the Joi schema, `compose.yaml` and `.env.example` per the `phase-01-configuracao-base/TD-01..TD-04` config pattern. Exceeding either fails the tus creation request through `onUploadCreate`, which per TD-04 aborts before any byte is stored, surfaced as the standard `{ statusCode, error, message }` envelope from `phase-02-auth/TD-07`.

**Note — this narrows a premise of TD-04, without flipping its decision.** TD-04 states that tus "requests never pass through the Nest guard pipeline". That holds only when the handler is mounted with `app.use(...)` in `main.ts`. Mounting it instead as a Nest controller route (`@All('videos/upload/*')` taking `@Req`/`@Res` and delegating to `tusServer.handle(req, res)`, with `NestFactory.create({ bodyParser: false })` and JSON parsing re-applied to the other routes) keeps guards, filters and Swagger metadata active for the request — the same pattern `@thallesp/nestjs-better-auth` uses to mount a catch-all raw-body route under a Nest guard. TD-04's chosen option (enforcement in tus hooks, `ffprobe` as the authoritative content check) is unchanged and still correct: the hooks remain the enforcement point for `Upload-Length` and metadata, because a guard cannot see the declared length. What changes is that the JWT check does **not** have to live in `onIncomingRequest` — the ordinary `JwtAuthGuard` covers it. This is a parameter-level correction to TD-04's rationale and should be recorded there as a Revision by `/plan-resolve`, not as a Supersede.

---

## TD-17: Abandoned-Upload Expiry and Orphaned-Draft Reaping

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** A user who abandons a 10GB upload leaves two pieces of durable garbage that nothing in TD-01..TD-14 reaps: an incomplete S3 multipart upload, whose accumulated parts are billed until aborted, and a `videos` row stranded in `uploading` forever (TD-05's enum has no path out of it without a completion event). TD-11 covers retry idempotency for *processing* jobs, which is a different lifecycle. TD-03 named orphaned multiparts as a drawback of the rejected Option B and never addressed it for the chosen Option A, where it is equally true.

**Options:**

### Option A: tus expiration extension + a BullMQ repeatable job that reaps both layers
Set `expirationPeriodInMilliseconds` on `S3Store`; a repeatable BullMQ job calls `server.cleanUpExpiredUploads()` and, in the same run, transitions the matching stranded `videos` rows.
- **Pros:** One scheduled operation keeps storage and the database in sync, so the two can never disagree about what was reaped. `cleanUpExpiredUploads()` is first-party and aborts the underlying multipart. Reuses the BullMQ scheduler already introduced by TD-07 — no new dependency, and the worker container (TD-08) is the natural host. Expired upload URLs return `410 Gone`, which is a resumable client's signal to restart rather than a silent failure.
- **Cons:** The S3Store expiration extension is implemented with **object tagging**; a storage backend without tagging support requires `useTags: false` and loses the feature. MinIO supports tagging, so this is a portability caveat rather than a present limitation.

### Option B: S3 bucket lifecycle rule (`AbortIncompleteMultipartUpload`) + an independent DB sweep
Let the storage layer expire multiparts; a separate scheduled query cleans the stranded rows.
- **Pros:** Reaping runs in the storage layer with zero application involvement and no scheduled job for that half.
- **Cons:** Two mechanisms with two independent clocks that must be reasoned about jointly — AWS evaluates lifecycle rules asynchronously roughly once a day, and MinIO's ILM implementation differs in timing, so the window where storage and DB disagree is real and not directly observable. Still needs the DB sweep anyway, so it does not remove a scheduled job, it adds a second uncoordinated mechanism.

### Option C: No automated reaping; manual operator cleanup
Document the growth and clean up by hand.
- **Pros:** Nothing to build.
- **Cons:** Storage cost grows monotonically with every abandoned upload, and videos accumulate in `uploading` where the Fase 04 dashboard will render them as permanently stuck.

**Recommendation:** Option A — it is the only option where the storage object and its database row are reaped by the same operation, and it reuses the scheduler the phase already introduced.

**Decision:** **A (tus expiration extension + BullMQ repeatable reaper job)** — Option B is rejected because it does not actually save the scheduled job it appears to save: the stranded `videos` row still needs a sweep, so B ends up with two reapers on two clocks (one of them a once-daily, asynchronously-evaluated lifecycle rule whose exact firing time is not observable) that can disagree about what has been cleaned. Option C is rejected because the cost is unbounded and the symptom is user-visible in Fase 04's dashboard. Concretely: `expirationPeriodInMilliseconds` is set from `UPLOAD_EXPIRATION_HOURS` (default **48**) — deliberately generous, since a resumable 10GB upload on a poor connection may legitimately span more than a day, and the point of choosing tus in TD-03 was to survive exactly that. The reaper is a BullMQ repeatable job running hourly in the `video-worker` container (TD-08), calling `server.cleanUpExpiredUploads()` and then transitioning every `videos` row whose upload expired to `failed` with `processing_error` set, rather than deleting it — the row is the user's only evidence that an upload was attempted, and TD-05 already has a terminal state for exactly this. `useTags` stays at its default `true` (MinIO supports object tagging); the flag is recorded here because switching to a storage backend without tagging support silently disables expiry.

**Revisions:**
- 2026-08-30 — Reaper placement resolved: the `video-worker` container constructs its own `S3Store` + tus `Server` with no route mounted, purely to call `cleanUpExpiredUploads()`. The tus `Server` that TD-16 mounts as a Nest controller route lives in the API process and is not reachable from the worker. Keeps tus the single authority on upload expiry and keeps scheduled work out of the request process per TD-08. Rationale: Worker builds its own tus Server for cleanup.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Object Storage Backend and Client SDK | A — MinIO + `@aws-sdk/client-s3` v3 | **A** |
| TD-02 | Backend | Bucket Topology and Object Key Layout | B — two buckets (private videos, public thumbnails) | **B** |
| TD-03 | Cross-layer | Upload Ingest Protocol for 10GB Files | A — tus (`@tus/server` + `@tus/s3-store`) | **A** |
| TD-04 | Backend | Upload Authorization, Size and Content-Type Enforcement Seam | A — tus lifecycle hooks + `ffprobe` authority | **A** |
| TD-05 | Backend | Video Lifecycle State Model | A — single `status` enum + `processing_error` | **A** |
| TD-06 | Cross-layer | Public Video Identifier and URL Strategy | B — 11-char base62 `public_id`, UNIQUE | **B** |
| TD-07 | Backend | Background Processing Queue Infrastructure | A — BullMQ + Redis via `@nestjs/bullmq` | **A** |
| TD-08 | Backend | Video Worker Deployment Topology | A — separate container, Nest standalone context | **A** |
| TD-09 | Backend | FFmpeg Invocation Strategy | A — direct `spawn` of `ffmpeg`/`ffprobe` | **A** |
| TD-10 | Backend | Thumbnail Extraction Policy | A — frame at 10%, 1280×720 JPEG | **A** |
| TD-11 | Backend | Processing Job Reliability and Idempotency | A — `jobId = videoId`, 3 attempts, terminal `failed` | **A** |
| TD-12 | Cross-layer | Streaming Delivery Strategy | A — presigned GET, Range served by storage | **A** |
| TD-13 | Cross-layer | Download Delivery Strategy | A — presigned GET + `response-content-disposition` | **A** |
| TD-14 | Backend | Integration-Test Strategy for Storage and Queue | A — real `minio`/`redis` compose services | **A** |
| TD-15 | Cross-layer | Access-Control Policy for Playback and Download | B — public, gated on resource state + owner bypass | **B** |
| TD-16 | Backend | Upload Abuse Prevention — Concurrency and Storage Quota | A — quota in `onUploadCreate`, tus in a Nest controller | **A** |
| TD-17 | Backend | Abandoned-Upload Expiry and Orphaned-Draft Reaping | A — tus expiration + BullMQ repeatable reaper | **A** |

### Capability traceability (per-TD; aggregate coverage is assembled by `plan-context`)

| Capability (Fase 03) | Covering TDs |
|---|---|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | TD-01, TD-02, TD-14, TD-17 |
| Serviço de processamento em segundo plano (filas) | TD-07, TD-08, TD-11, TD-14 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | TD-03, TD-04, TD-16 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | TD-04, TD-05, TD-17 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | TD-08, TD-09, TD-11, TD-14 |
| Geração automática de thumbnail a partir de um frame do vídeo | TD-08, TD-09, TD-10, TD-14 |
| URL única por vídeo, sem conflito com outros vídeos | TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | TD-12, TD-15 |
| Download do vídeo pelo usuário | TD-13, TD-15 |
