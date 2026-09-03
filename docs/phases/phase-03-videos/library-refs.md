---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1121.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-08-31T02:24:46Z"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1121.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-08-31T02:24:46Z"
  "@tus/server":
    version: "^2.4.4"
    context7_id: "/tus/tus-node-server"
    fetched_at: "2026-08-31T02:24:46Z"
  "@tus/s3-store":
    version: "^2.0.6"
    context7_id: "/tus/tus-node-server"
    fetched_at: "2026-08-31T02:24:46Z"
  "@nestjs/bullmq":
    version: "^12.0.0"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-08-31T02:24:46Z"
  "bullmq":
    version: "^6.3.2"
    context7_id: "/websites/bullmq_io"
    fetched_at: "2026-08-31T02:24:46Z"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-30T20:32:11Z"
---

# phase-03-videos — Library References

_Cache of Context7 documentation for the libraries decided in this slice, scoped to the surfaces the TDs actually use. None of these are installed in `nestjs-project/package.json` yet — versions below are the latest resolved at decision time._

> **Two API corrections surfaced by this fetch — read before implementing TD-11 and TD-17.** Both concern BullMQ 6.x, which changed the repeatable-job and deduplication APIs relative to the v5-era examples that dominate search results. See the `bullmq` section.

---

### @aws-sdk/client-s3

Used by: **TD-01** (S3-compatible client), **TD-02** (bucket/key layout), **TD-12** / **TD-13** (presigned delivery), **TD-17** (multipart abort during reaping).

#### MinIO compatibility — two required client options

```ts
new S3Client({
  endpoint: "http://minio:9000",   // custom endpoint (compose service name)
  forcePathStyle: true,
  region: "us-east-1",
  credentials: { accessKeyId, secretAccessKey },
});
```

`forcePathStyle` is defined in the S3 endpoint rule set as: _"When true, force a path-style endpoint to be used where the bucket name is part of the path."_ It defaults to `false`. **Required for MinIO** — the custom endpoint has no wildcard DNS for per-bucket subdomains, so virtual-host style resolution fails.

#### Response-header overrides on GetObject (TD-13's download filename)

`GetObjectCommand` accepts `ResponseContentDisposition` / `ResponseContentType`. From the command's own JSDoc:

> The response headers that you can override for the `GetObject` response are `Cache-Control`, `Content-Disposition`, `Content-Encoding`, `Content-Language`, `Content-Type`, and `Expires`. … **When you use these parameters, you must sign the request** by using either an Authorization header or a presigned URL. These parameters cannot be used with an unsigned (anonymous) request.

That signing requirement is why TD-13's download path must be presigned rather than a plain public URL.

---

### @aws-sdk/s3-request-presigner

Used by: **TD-12** (playback URL), **TD-13** (download URL).

```ts
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const url = await getSignedUrl(client, command, { expiresIn: 3600 });
```

`expiresIn` is seconds and **defaults to 900** — TD-12 sets it from `STORAGE_PLAYBACK_URL_TTL_SECONDS` (6h), so the default must be overridden explicitly.

**The response-header overrides ride along automatically.** `getSignedUrl` resolves the command through the normal middleware pipeline including the serializer, which converts `ResponseContentDisposition` into the `response-content-disposition` query parameter — so it is part of the signed URL with no extra work:

```ts
// TD-13: force download with a human-readable filename
const cmd = new GetObjectCommand({
  Bucket: videosBucket,
  Key: `videos/${video.id}/source${ext}`,
  ResponseContentDisposition: `attachment; filename="${sanitise(video.title)}${ext}"`,
});
```

**MinIO signing caveat (TD-01's two-endpoint requirement):** SigV4 covers the `Host` header, so a URL signed against the internal endpoint (`http://minio:9000`) is invalid from a browser. Presigning must use a separate client configured with `STORAGE_PUBLIC_ENDPOINT`.

---

### @tus/server

Used by: **TD-03** (ingest protocol), **TD-04** (enforcement seam), **TD-16** (quota in hooks, Nest controller mounting), **TD-17** (expiry reaping).

> **Correção (2026-09-02, durante SI-03.6): esta seção foi escrita contra a v2, mas o projeto usa a v1.** `@tus/server@2` e `@tus/s3-store@2` são ESM puro — o campo `exports` é uma string, sem sequer condição `require` — e não carregam sob o transform CommonJS do ts-jest. Manter a v2 exigiria transformar `node_modules`, e a árvore de dependências puxa `srvx` com `.mjs`, de modo que a lista de exceções cresce a cada dep ESM nova. Versões instaladas: **`@tus/server@1.10.2`** e **`@tus/s3-store@1.9.1`**, ambas CJS, com toda a API que TD-03/TD-04/TD-16/TD-17 exigem. É a mesma restrição que TD-06 já havia ratificado ao recusar o `nanoid` v6.
>
> **A diferença de assinatura importa:** na v1 os hooks recebem **e devolvem** o `res`. As linhas da tabela abaixo estão na forma da v2.

#### Mounting (TD-16 — inside a Nest controller, guards active)

`server.handle(req, res)` takes Node's `http.IncomingMessage`/`ServerResponse`, so it works from a Nest controller taking `@Req()`/`@Res()`. Requires `NestFactory.create({ bodyParser: false })` with JSON parsing re-applied to non-tus routes.

```ts
app.all('/upload', (req, res) => tusServer.handle(req, res));
app.all('/upload/*', (req, res) => tusServer.handle(req, res));
```

`handleWeb(req: Request)` is the web-standard-`Request` variant (Next App Router, Bun) — not needed here.

**Do not wrap `handle()` in try/catch** — the server owns its own response lifecycle; catching after the fact means the response was already sent.

#### Lifecycle hooks (TD-04, TD-16)

| Hook | Signature | Use here |
|---|---|---|
| `onIncomingRequest` | `(req, uploadId) => Promise<void>` | Access control. **Per TD-04's Revision, JWT moved to `JwtAuthGuard`** — this hook is no longer the auth point. |
| `onUploadCreate` | v2: `(req, upload) => Promise<{metadata?}>` — **v1 (em uso): `(req, res, upload) => Promise<{res, metadata?}>`** | TD-16 quota check + TD-05 draft-row creation. Throw `{status_code, body}` to abort before any byte is stored. |
| `onUploadFinish` | v2: `(req, res, upload) => Promise<{status_code?, headers?, body?}>` — **v1 (em uso): o retorno precisa carregar `res`** | Enqueue the processing job (TD-11). |
| `onResponseError` | v2: `(req, err) => Promise<{status_code, body} \| void>` — **v1 (em uso): `(req, res, err) => ...`** | Map to the `{ statusCode, error, message }` envelope (`phase-02-auth/TD-07`). O tus não define `Content-Type` ao escrever o corpo: sem `res.setHeader('Content-Type', 'application/json')` o cliente recebe JSON rotulado como texto. |

`maxSize` accepts an async function `(req, uploadId) => number`, so TD-16's per-user ceiling can be dynamic rather than a constant.

#### Expiry reaping (TD-17)

```ts
async cleanUpExpiredUploads(): Promise<number>   // returns count deleted
```

Requires datastore support for the expiration extension. TD-17's Revision has the **worker** construct its own `S3Store` + `Server` (no route mounted) purely to call this.

#### Multi-instance note

`options.locker` defaults to an in-memory `MemoryLocker`. Running more than one API instance requires a shared locker (e.g. Redis-backed) — not needed at current single-instance scale, but it is the thing that breaks first when the API scales out.

---

### @tus/s3-store

Used by: **TD-03** (part sizing for 10GB), **TD-17** (expiration).

```ts
new S3Store({
  s3ClientConfig: { bucket, region, endpoint, forcePathStyle: true, credentials },
  partSize: 50 * 1024 * 1024,     // TD-03: ~200 parts for a 10GB file
  maxMultipartParts: 10000,
  expirationPeriodInMilliseconds: UPLOAD_EXPIRATION_HOURS * 3600 * 1000,  // TD-17: 48h
  useTags: true,
})
```

| Option | Note |
|---|---|
| `partSize` | Cannot be below 5MiB or above 5GiB. The store may raise it to stay under `maxMultipartParts`. |
| `maxMultipartParts` | Defaults to 10,000 (the AWS limit). **Some S3-compatible providers cap at 1,000** — TD-03's 50MB part size keeps a 10GB upload at ~200 parts, inside both. |
| `expirationPeriodInMilliseconds` | Enables the expiration extension. Once passed, the upload URL returns **410 Gone**. |
| `useTags` | **The expiration extension is implemented with object tagging.** Set `false` on providers without tagging support — which silently disables expiry. MinIO supports tagging, so TD-17 keeps the default `true`. |
| `cache` | Defaults to `MemoryKvStore`. Multiple server instances need a shared `RedisKvStore` (exported from `@tus/server`). |

Storage structure: temporary part objects during upload; on completion the final object plus a separate JSON metadata object. Incomplete multiparts are cleaned by `deleteExpired` based on the expiration period.

---

### @nestjs/bullmq

Used by: **TD-07** (queue registration), **TD-08** (worker topology).

Peer range is `@nestjs/core ^10 || ^11 || ^12` and `bullmq ^3 || ^4 || ^5 || ^6` — compatible with the installed NestJS 11 and with bullmq 6.

```ts
@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>) { /* ffmpeg */ }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) { /* … */ }
}
```

**TD-08 producer/consumer split.** The API process registers only the producer:

```ts
BullModule.registerQueue({ name: 'video-processing' })
```

To guarantee the API never spawns a Worker, `BullModule.forRoot({ extraOptions: { manualRegistration: true } })` suppresses automatic worker registration. The `video-worker` container hosts the `@Processor` via `NestFactory.createApplicationContext(WorkerModule)`.

Note: `registerQueue` also accepts an inline `processors` array, which spawns a Worker per processor in the *same* process — **avoid it here**, it defeats TD-08's CPU isolation.

---

### bullmq

Used by: **TD-11** (job reliability/idempotency), **TD-17** (repeatable reaper).

#### ⚠️ Correction 1 — repeatable jobs are Job Schedulers in v6 (TD-17)

TD-17 says "BullMQ repeatable job". In **v6 that API is `upsertJobScheduler`**; the v5 `{ repeat: … }` option on `queue.add` is legacy (BullMQ ships a dedicated v5→v6 migration guide for exactly this). Use:

```ts
await queue.upsertJobScheduler(
  'abandoned-upload-reaper',
  { every: 60 * 60 * 1000 },              // hourly, per TD-17
  { name: 'reap', data: {}, opts: { attempts: 3 } },
);
```

`upsertJobScheduler` is idempotent by scheduler id, so calling it on every worker boot is safe. Remove with `queue.removeJobScheduler('abandoned-upload-reaper')`.

Also note: older docs show `import { Queue, QueueScheduler } from 'bullmq'` — **`QueueScheduler` no longer exists**; delayed/repeatable handling moved into the Worker. Ignore any snippet importing it.

#### ⚠️ Correction 2 — deduplication is a first-class option (TD-11)

TD-11 decided `jobId = videoId` to make a repeated `onUploadFinish` a no-op. v6 has an explicit mechanism that expresses that intent directly:

```ts
// Simple Mode — no new job with this id until the current one completes or fails
await queue.add('process-video', { videoId }, { deduplication: { id: videoId } });

// Throttle Mode — ignore duplicates for a TTL window
await queue.add('process-video', { videoId }, { deduplication: { id: videoId, ttl: 5000 } });
```

Simple Mode is the exact semantics TD-11 describes. Custom `jobId` still works, but `deduplication` is the intent-revealing form and does not collide with BullMQ's own id handling.

#### Retry policy (TD-11)

```ts
await queue.add('process-video', { videoId }, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30_000 },   // 30s → 60s → 120s
  removeOnComplete: { count: 1000 },
  removeOnFail: false,                                // retained for diagnostics
});
```

Stalled-job recovery (a worker OOM-killed mid-transcode) is handled by the Worker's lock-renewal heartbeat and is **separate from the `attempts` counter** — the job is requeued, not counted as a failed attempt. This is the property TD-07 chose BullMQ over pg-boss for.
