---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-08-31T02:24:46Z"
  docs/phases/phase-03-videos/library-refs.md: "2026-08-31T02:38:18Z"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-30T20:32:11Z"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-26T03:15:09Z"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the backend for large-file video ingest and automatic processing in `nestjs-project/`: an S3-compatible file storage service for vídeos e thumbnails, a background job queue, resumable upload of arquivos de até 10GB sem impacto na performance with automatic pré-cadastro do vídeo como rascunho, automatic post-upload extração de duração e metadados plus geração automática de thumbnail a partir de um frame do vídeo, a URL única por vídeo sem conflito, and reprodução via streaming and download do vídeo pelo usuário — so that upload de até 10GB, processamento automático, streaming and unique URLs are all functional.

---

## Step Implementations

### SI-03.1 — Provisionar infraestrutura de storage e fila

**Description:** Subir os serviços `minio` e `redis` no Compose e expor suas configurações pelo padrão de config namespaced já estabelecido, para que todos os SIs seguintes tenham storage e fila disponíveis.

**Technical actions:**

1. Adicionar serviços `minio` e `redis` a `nestjs-project/compose.yaml`, com healthcheck e `depends_on` em `nestjs-api` — hosts sempre pelo nome de serviço do Compose, nunca `localhost` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-07`, `phase-03-videos/TD-14`)
2. Criar `src/config/storage.config.ts` com `registerAs('storage', ...)` expondo `endpoint`, `publicEndpoint`, `videosBucket`, `thumbnailsBucket`, `maxUploadBytes`, `playbackUrlTtlSeconds`, `uploadExpirationHours` (per `phase-03-videos/TD-01`, `## Inherited Conventions`)
3. Criar `src/config/queue.config.ts` com `registerAs('queue', ...)` expondo `host` e `port` do Redis (per `phase-03-videos/TD-07`)
4. Estender `src/config/env.validation.ts` com as chaves Joi correspondentes — `STORAGE_ENDPOINT`, `STORAGE_PUBLIC_ENDPOINT`, `STORAGE_MAX_UPLOAD_BYTES`, `STORAGE_PLAYBACK_URL_TTL_SECONDS`, `UPLOAD_EXPIRATION_HOURS`, `UPLOAD_MAX_CONCURRENT_PER_USER`, `UPLOAD_MAX_TOTAL_BYTES_PER_USER`, `REDIS_HOST`, `REDIS_PORT` — e registrar ambos os factories em `AppModule`
5. Atualizar `nestjs-project/.env.example` com as mesmas chaves e seus defaults

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `env.validation.ts` | Integration: schema aceita o conjunto completo de chaves e rejeita ausência das obrigatórias | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` deixa `minio` e `redis` com status `running` e healthcheck passando.
- A aplicação sobe com o `.env.example` preenchido e falha no boot, com mensagem do Joi, quando uma chave obrigatória de storage ou fila está ausente.
- `STORAGE_ENDPOINT` e `STORAGE_PUBLIC_ENDPOINT` são lidos como valores distintos — o interno resolve pelo nome de serviço do Compose e o público pelo host acessível ao browser.

---

### SI-03.2 — Implementar módulo de storage S3

**Description:** Encapsular o acesso ao object storage atrás de um `StorageService` que fala apenas o protocolo S3, com os dois buckets e o layout de chaves fixados, para que upload, processamento e entrega compartilhem um único cliente.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` (per `phase-03-videos/TD-01`)
2. Criar `src/storage/storage.service.ts` com **dois** `S3Client`: um interno (`STORAGE_ENDPOINT`) para operações server-side e um de presign (`STORAGE_PUBLIC_ENDPOINT`), ambos com `forcePathStyle: true` — a assinatura SigV4 cobre o header `Host`, então uma URL assinada contra o endpoint interno é inválida no browser (per `phase-03-videos/TD-01`)
3. Criar `src/storage/storage.keys.ts` com os helpers de layout `videos/{videoId}/source{ext}` e `thumbnails/{videoId}/auto.jpg` (per `phase-03-videos/TD-02`)
4. Criar `src/storage/storage.module.ts` exportando `StorageService`, registrá-lo em `AppModule`, e garantir no bootstrap a existência do bucket privado de vídeos e do bucket público de thumbnails (per `phase-03-videos/TD-02`)
5. Criar `src/test/create-test-storage.ts` — helper que cria os buckets e isola cada suíte por prefixo de chave (per `phase-03-videos/TD-14`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: put/get e presign contra o MinIO real do Compose, incluindo `forcePathStyle` e divergência de host entre endpoint interno e público | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilation test | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — o serviço `minio` e o `storage.config` precisam existir antes do cliente.

**Acceptance criteria:**

- Um objeto gravado no bucket privado não é legível por requisição anônima direta ao storage; um objeto gravado no bucket de thumbnails é.
- Uma URL presignada gerada pelo serviço é resolvível a partir do host público sem erro de assinatura.
- O bootstrap é idempotente — subir a aplicação duas vezes não falha por bucket já existente.

---

### SI-03.3 — Criar entidade Video e migration

**Description:** Materializar a tabela `videos` com o enum de ciclo de vida, as colunas de metadados e os índices que sustentam quota, reaping e a listagem do painel da Fase 04.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com todos os campos de `## Technical Specifications` → `### Data Model` → `#### Video` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`, `phase-03-videos/TD-09`)
2. Gerar migration `CreateVideos` — cria o tipo enum `video_status`, a tabela, a FK para `channels`, e os três índices (unique em `public_id`, composto em `(channel_id, status)`, índice em `status`) (per `phase-03-videos/TD-06`, `phase-03-videos/TD-16`, `phase-03-videos/TD-17`)
3. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e registrá-lo em `AppModule`
4. Criar `src/videos/videos.service.ts` com as transições de estado `draft → uploading → processing → ready | failed`, recusando transições fora dessa ordem (per `phase-03-videos/TD-05`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, defaults, valores do enum, unicidade de `public_id`, FK para `channels` | `src/videos/entities/video.entity.integration-spec.ts` |
| `CreateVideos` migration | Integration: up/down aplicam e revertem limpo | `src/database/migrations.integration-spec.ts` |
| `VideosService` | Unit: matriz de transições de estado válidas e inválidas | `src/videos/videos.service.spec.ts` |
| `VideosModule` | Unit: compilation test | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.1 — a migration roda contra o `db` já configurado.

**Acceptance criteria:**

- Inserir dois vídeos com o mesmo `public_id` viola a constraint unique.
- Inserir um vídeo com `channel_id` inexistente viola a FK.
- Um vídeo recém-criado tem `status = draft` e `processing_error` nulo sem que o caller informe qualquer um dos dois.
- Uma transição direta de `draft` para `ready` é recusada pelo serviço.
- `visibility` não existe como coluna nem como valor do enum nesta fase.

---

### SI-03.4 — Implementar gerador de identificador público

**Description:** Gerar o `public_id` base62 de 11 caracteres que aparece na URL de cada vídeo, com garantia de unicidade pelo banco e retry em colisão.

**Technical actions:**

1. Criar `src/videos/public-id.util.ts` — `crypto.randomBytes` mapeado sobre um alfabeto base62 com rejeição de amostras que introduziriam viés de módulo. Não usar `nanoid`: a v6 é ESM-only e este backend compila e testa como CommonJS (per `phase-03-videos/TD-06`)
2. Integrar em `VideosService.create` com retry-on-conflict — em violação da unique de `public_id`, regerar e tentar de novo, com número de tentativas limitado (per `phase-03-videos/TD-06`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `public-id.util.ts` | Unit: comprimento fixo de 11, alfabeto restrito a base62, ausência de viés de módulo sobre amostra grande | `src/videos/public-id.util.spec.ts` |
| `VideosService.create` | Integration: retry gera um id alternativo quando o primeiro colide | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.3 — a coluna e a constraint unique precisam existir.

**Acceptance criteria:**

- Todo `public_id` gerado tem exatamente 11 caracteres, todos dentro do alfabeto base62.
- Criar um vídeo cujo primeiro `public_id` sorteado já existe ainda resulta em um vídeo persistido, com id diferente.
- O `public_id` de um vídeo não muda quando seu `title` é alterado.
- O `id` interno (uuid) não aparece em nenhuma resposta de API desta fase.

---

### SI-03.5 — Registrar fila de processamento (lado produtor)

**Description:** Registrar a fila BullMQ no processo da API apenas como produtor, com as opções de deduplicação e retry que tornam o enfileiramento idempotente.

**Technical actions:**

1. Instalar `@nestjs/bullmq` e `bullmq` (per `phase-03-videos/TD-07`)
2. Registrar `BullModule.forRoot` em `AppModule` com a connection vinda de `queue.config` e `extraOptions: { manualRegistration: true }` — impede que o processo da API instancie qualquer Worker (per `phase-03-videos/TD-08`)
3. Registrar `BullModule.registerQueue({ name: 'video-processing' })` em `VideosModule`, sem o array `processors` (que criaria Worker no mesmo processo e anularia o isolamento de CPU do TD-08)
4. Criar `src/videos/video-queue.service.ts` — enfileira `video.process` com `deduplication: { id: videoId }`, `attempts: 3`, `backoff: { type: 'exponential', delay: 30_000 }`, `removeOnFail: false` (per `phase-03-videos/TD-11`, `## Technical Specifications` → `### Events/Messages`)
5. Criar `src/test/create-test-queue.ts` — helper que isola cada suíte por nome de fila (per `phase-03-videos/TD-14`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoQueueService` | Integration: enfileiramento real contra o Redis do Compose; segunda chamada com o mesmo `videoId` não cria job adicional enquanto o primeiro não termina | `src/videos/video-queue.service.integration-spec.ts` |
| `VideosModule` | Unit: compilation test com `BullModule` registrado | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.1 (serviço `redis` e `queue.config`), SI-03.3 (`VideosModule` existe).

**Acceptance criteria:**

- Enfileirar duas vezes o mesmo `videoId` com o primeiro job ainda em execução resulta em um único job na fila.
- O processo da API não instancia nenhum Worker — a fila só recebe jobs, nunca os processa.
- Um job que falha é retido na fila de falhas para diagnóstico, em vez de ser removido.

---

### SI-03.6 — Expor ingest tus com autorização, quota e pré-cadastro

**Route:** ALL /videos/upload/*
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Authenticated (per `## Technical Specifications` → `### Authorization Matrix`)

**Description:** Montar o servidor tus como rota de controller Nest, de modo que o pipeline de guards continue ativo, e usar os hooks do protocolo para criar o rascunho e barrar uploads acima da cota antes que qualquer byte seja gravado.

**Technical actions:**

1. Instalar `@tus/server` e `@tus/s3-store`; trocar o bootstrap para `NestFactory.create(AppModule, { bodyParser: false })` e reaplicar o parsing JSON nas demais rotas, preservando o `ValidationPipe` global herdado (per `phase-03-videos/TD-16`, `## Inherited Decisions Detail` → `phase-02-auth/TD-06`)
2. Criar `src/videos/upload.controller.ts` com `@All('videos/upload/*')` sob `JwtAuthGuard`, delegando a `tusServer.handle(req, res)` sem envolver a chamada em try/catch — o servidor tus é dono do próprio ciclo de resposta (per `phase-03-videos/TD-04` Revision, `phase-03-videos/TD-16`)
3. Configurar o `S3Store` com `partSize: 50 * 1024 * 1024`, `expirationPeriodInMilliseconds` derivado de `UPLOAD_EXPIRATION_HOURS` e `useTags: true` — ~200 partes para 10GB, dentro do limite de 10.000 da AWS e do limite menor de provedores compatíveis (per `phase-03-videos/TD-03`, `phase-03-videos/TD-17`)
4. Implementar `onUploadCreate` — validar `Upload-Length` contra `STORAGE_MAX_UPLOAD_BYTES` via a opção `maxSize`, checar concorrência e bytes agregados do canal, e criar a row em `status = draft` com `title` derivado do `filename` do `Upload-Metadata` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-16`, `phase-03-videos/TD-05`)
5. Implementar `onUploadFinish` — persistir `size_bytes`, `source_ext` e `upload_id`, transicionar para `processing` e enfileirar `video.process` via `VideoQueueService`; mapear erros dos hooks para o envelope `{ statusCode, error, message }` em `onResponseError` (per `phase-03-videos/TD-11`, `## Inherited Decisions Detail` → `phase-02-auth/TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `UploadQuotaService` | Unit: limites de concorrência e de bytes agregados, incluindo os valores de fronteira | `src/videos/upload-quota.service.spec.ts` |
| `onUploadCreate` / `onUploadFinish` | Integration: handshake real contra MinIO — rascunho criado, quota recusada com o código correto, job enfileirado ao concluir | `src/videos/upload.controller.integration-spec.ts` |

Cenários E2E do protocolo tus completo são authored externamente por `/plan-test-specs` no arquivo referenciado em `**Test Specs:**` — nenhuma linha E2E é emitida nesta tabela.

**Dependencies:** SI-03.2 (storage), SI-03.3 (entidade), SI-03.5 (fila).

**Acceptance criteria:**

- `POST /videos/upload` sem header `Authorization` retorna `401` e não cria row em `videos`.
- `POST /videos/upload` com `Upload-Length` acima de `STORAGE_MAX_UPLOAD_BYTES` retorna `413` com `error: "UPLOAD_TOO_LARGE"` e nenhum byte é gravado no bucket.
- `POST /videos/upload` com o usuário já no limite de uploads concorrentes retorna `409` com `error: "UPLOAD_QUOTA_EXCEEDED"`.
- Um `POST` bem-sucedido cria exatamente uma row em `videos` com `status = draft` e `title` derivado do nome do arquivo enviado.
- Concluir o upload transiciona a row para `processing` e deixa exatamente um job `video.process` na fila.
- Reenviar o `PATCH` final não cria um segundo job para o mesmo vídeo.

---

### SI-03.7 — Provisionar container video-worker

**Description:** Criar o processo separado que hospeda o processamento pesado, com FFmpeg na imagem e contexto NestJS standalone, para que uma transcodificação nunca dispute CPU com o event loop da API.

**Technical actions:**

1. Criar `nestjs-project/Dockerfile.worker` — mesma base `node:25.6.0-slim` acrescida de `apt install -y ffmpeg`; a imagem da API permanece sem FFmpeg (per `phase-03-videos/TD-08`, `phase-03-videos/TD-09`)
2. Adicionar o serviço `video-worker` a `compose.yaml`, com `depends_on` em `db`, `redis` e `minio`
3. Criar `src/worker/worker.module.ts` importando `ConfigModule`, `TypeOrmModule`, `StorageModule` e a fila — reaproveitando as mesmas entidades e factories da API, sem bootstrap duplicado (per `phase-03-videos/TD-08`)
4. Criar `src/worker/main.worker.ts` com `NestFactory.createApplicationContext(WorkerModule)` — sem servidor HTTP — e adicionar o script `start:worker` ao `package.json`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilation test — resolve `ConfigModule`, `TypeOrmModule`, `StorageModule` e a fila fora do contexto HTTP | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.1 (Compose e configs), SI-03.5 (fila registrada).

**Acceptance criteria:**

- `docker compose exec video-worker ffmpeg -version` responde com uma versão instalada; o mesmo comando no container `nestjs-api` falha.
- O container `video-worker` sobe e permanece `running` sem expor porta HTTP.
- Derrubar `video-worker` não afeta a disponibilidade dos endpoints da API.

---

### SI-03.8 — Implementar wrapper FFmpeg

**Description:** Encapsular as invocações de `ffprobe` e `ffmpeg` num wrapper tipado sobre `child_process.spawn`, sem biblioteca intermediária, cobrindo extração de metadados e de thumbnail.

**Technical actions:**

1. Criar `src/worker/ffmpeg.util.ts` — `spawn` dos binários do sistema, com tratamento de exit code e captura de `stderr`; nenhuma dependência npm de wrapper, já que `fluent-ffmpeg` foi descontinuado e arquivado pelo próprio autor (per `phase-03-videos/TD-09`)
2. Implementar `probe(path)` — executa `ffprobe -v quiet -print_format json -show_format -show_streams` e devolve o JSON parseado, de onde saem `duration`, `width` e `height` (per `phase-03-videos/TD-09` Revision)
3. Implementar `extractThumbnail(path, atSeconds)` — `-ss` posicionado antes do `-i` para seek no input, `-frames:v 1 -vf scale=1280:-2 -q:v 3`, saída JPEG (per `phase-03-videos/TD-10`)
4. Adicionar fixture `src/test/fixtures/sample.mp4` — vídeo curto e pequeno, suficiente para exercitar ambos os caminhos (per `phase-03-videos/TD-14`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ffmpeg.util.ts` | Integration: `ffprobe` e `ffmpeg` reais contra a fixture — metadados extraídos, thumbnail gerado, exit code não-zero propagado como erro | `src/worker/ffmpeg.util.integration-spec.ts` |

**Dependencies:** SI-03.7 — os binários só existem na imagem do worker.

**Acceptance criteria:**

- `probe()` sobre a fixture devolve duração, largura e altura coerentes com o arquivo.
- `probe()` sobre um arquivo sem stream de vídeo devolve uma lista de streams sem entrada de vídeo, em vez de lançar exceção genérica.
- `extractThumbnail()` sobre a fixture produz um JPEG legível com largura 1280.
- Um binário ausente ou um exit code não-zero resulta em erro contendo o `stderr` capturado.

---

### SI-03.9 — Implementar job de processamento de vídeo

**Description:** Consumir `video.process` no worker, extrair metadados e thumbnail, e levar o vídeo a `ready` — ou a `failed` com motivo registrado quando a entrada é inválida.

**Technical actions:**

1. Criar `src/worker/video.processor.ts` — `@Processor('video-processing')` estendendo `WorkerHost`, registrado apenas no `WorkerModule` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`)
2. Rodar `probe()` sobre o source e persistir `duration`, `width`, `height` em colunas tipadas mais o output integral do `ffprobe` em `ffprobe_metadata` — os ~5KB por vídeo eliminam o risco de rebaixar um arquivo de vários GB para recomputar um campo descoberto depois (per `phase-03-videos/TD-09` Revision)
3. Recusar como falha permanente a entrada cuja lista de streams não contém vídeo — o `Content-Type` declarado pelo cliente nunca é a fonte de verdade (per `phase-03-videos/TD-04`)
4. Extrair o thumbnail a 10% da duração e gravá-lo em `thumbnails/{videoId}/auto.jpg` no bucket público — chave determinística, de modo que um retry sobrescreve em vez de acumular (per `phase-03-videos/TD-10`, `phase-03-videos/TD-02`, `phase-03-videos/TD-11`)
5. Transicionar para `ready` ao final; em falha após as 3 tentativas, transicionar para `failed` gravando o motivo em `processing_error` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-11`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Integration: pipeline completo contra MinIO e Redis reais — vídeo válido chega a `ready` com metadados e thumbnail; arquivo sem stream de vídeo chega a `failed` com `processing_error` preenchido | `src/worker/video.processor.integration-spec.ts` |

**Dependencies:** SI-03.8 (wrapper FFmpeg), SI-03.2 (storage), SI-03.3 (entidade), SI-03.5 (fila).

**Acceptance criteria:**

- Processar a fixture leva o vídeo a `status = ready` com `duration`, `width` e `height` preenchidos e `ffprobe_metadata` não nulo.
- Um objeto que não é vídeo leva a `status = failed` com `processing_error` descrevendo a ausência de stream de vídeo, sem esgotar as 3 tentativas em erro genérico.
- Após o processamento existe exatamente um objeto em `thumbnails/{videoId}/auto.jpg`, legível anonimamente.
- Reexecutar o job para o mesmo vídeo sobrescreve o thumbnail em vez de criar um segundo objeto.
- Um vídeo em `failed` conserva sua row e seu `public_id` — nada é apagado.

---

### SI-03.10 — Expor endpoints de playback e download

**Route:** GET /videos/{publicId}/playback, GET /videos/{publicId}/download
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Anonymous quando `status = ready`; Owner em qualquer status (per `## Technical Specifications` → `### Authorization Matrix`)

**Description:** Entregar as duas URLs presignadas que colocam o cliente em contato direto com o storage, com o acesso barrado por estado do recurso em vez de identidade.

**Technical actions:**

1. Criar `src/auth/decorators/optional-auth.decorator.ts` e estender `JwtAuthGuard` para popular `request.user` quando houver token válido, sem nunca rejeitar por ausência de header — modo aditivo, sem alterar o comportamento das rotas existentes (per `phase-03-videos/TD-15`, `## Inherited Decisions Detail` → `phase-02-auth/TD-02`)
2. Implementar `VideosService.resolveForDelivery(publicId, user?)` — devolve o vídeo apenas se `status = ready` ou se o requisitante é o dono; caso contrário lança o erro que vira `404 VIDEO_NOT_FOUND`, nunca `403`, para que vídeos não prontos não sejam enumeráveis (per `phase-03-videos/TD-15`)
3. Criar `src/videos/videos.controller.ts` com `GET :publicId/playback` e `GET :publicId/download`, ambos `@Public()` + `@OptionalAuth()`, anotados com `@ApiOperation` / `@ApiResponse` / `@ApiParam` explícitos (per `## Inherited Decisions Detail` → `openapi-docs-nestjs/TD-01`)
4. Gerar a URL de playback com `getSignedUrl` passando `expiresIn` explicitamente a partir de `STORAGE_PLAYBACK_URL_TTL_SECONDS` — o default da lib é 900s e deixaria a URL expirar no meio da sessão (per `phase-03-videos/TD-12`)
5. Gerar a URL de download com `ResponseContentDisposition: attachment; filename="{title sanitizado}{source_ext}"` no `GetObjectCommand` — o serializer converte em query param assinado, e a AWS exige requisição assinada para overrides de header (per `phase-03-videos/TD-13`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.resolveForDelivery` | Unit: matriz completa de `status` × (anônimo, autenticado não-dono, dono) | `src/videos/videos.service.spec.ts` |
| `OptionalAuthGuard` | Unit: popula `request.user` com token válido, deixa indefinido sem header, não rejeita em nenhum dos dois | `src/auth/guards/jwt-auth.guard.spec.ts` |
| Presign de entrega | Integration: URL de playback resolve contra MinIO; URL de download devolve `Content-Disposition: attachment` com o filename esperado | `src/videos/videos.controller.integration-spec.ts` |

Cenários E2E dos dois endpoints são authored externamente por `/plan-test-specs` no arquivo referenciado em `**Test Specs:**` — nenhuma linha E2E é emitida nesta tabela.

**Dependencies:** SI-03.2 (presigner), SI-03.3 (entidade), SI-03.4 (`public_id` na rota).

**Acceptance criteria:**

- `GET /videos/{publicId}/playback` de um vídeo `ready`, sem autenticação, retorna `200` com `url` e `expiresIn`.
- `GET /videos/{publicId}/playback` de um vídeo em `processing`, sem autenticação, retorna `404` com `error: "VIDEO_NOT_FOUND"` — resposta idêntica à de um `publicId` inexistente.
- O mesmo vídeo em `processing` retorna `200` quando requisitado pelo dono autenticado.
- Seguir a `url` de download resulta em transferência com `Content-Disposition: attachment` e filename derivado do título, sem revelar a chave de storage.
- A `url` de playback continua válida após múltiplas requisições Range dentro da janela de TTL configurada.
- Nenhuma das duas respostas expõe o `id` interno do vídeo.

---

### SI-03.11 — Implementar reaper de uploads abandonados

**Description:** Recolher periodicamente uploads tus abandonados e as rows que ficariam presas em `uploading`, mantendo storage e banco sincronizados por uma única operação.

**Technical actions:**

1. Criar `src/worker/reaper.processor.ts` — job `reap` na mesma fila, hospedado no `video-worker` (per `phase-03-videos/TD-17`)
2. Construir no worker um `S3Store` + `Server` tus próprios, **sem montar rota**, apenas para invocar `cleanUpExpiredUploads()` — o `Server` que a API monta como rota de controller não é alcançável a partir deste processo (per `phase-03-videos/TD-17` Revision)
3. Registrar o agendamento no boot do worker com `queue.upsertJobScheduler('abandoned-upload-reaper', { every: 3_600_000 }, ...)` — API de Job Scheduler da v6; `queue.add(..., { repeat })` é a forma legada da v5 e `QueueScheduler` não existe mais (per `phase-03-videos/TD-17`, `library-refs.md` → `bullmq`)
4. Na mesma execução, transicionar para `failed` com `processing_error` preenchido toda row cujo upload expirou, preservando a row como evidência da tentativa (per `phase-03-videos/TD-17`, `phase-03-videos/TD-05`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ReaperProcessor` | Integration: upload criado com expiração curta é recolhido do MinIO e sua row transiciona para `failed`; upload ativo permanece intocado | `src/worker/reaper.processor.integration-spec.ts` |

**Dependencies:** SI-03.6 (configuração do `S3Store` e expiração), SI-03.7 (worker), SI-03.3 (entidade).

**Acceptance criteria:**

- Um upload abandonado além de `UPLOAD_EXPIRATION_HOURS` deixa de ocupar partes multipart no bucket após uma execução do reaper.
- A row correspondente termina em `status = failed` com `processing_error` indicando expiração — e continua existindo.
- Um upload ainda dentro da janela de expiração não é afetado por uma execução do reaper.
- Chamar o registro do agendamento duas vezes (dois boots do worker) resulta em um único scheduler ativo.
- Uma segunda execução do reaper sobre o mesmo upload já recolhido não produz erro.

---

## Technical Specifications

### Data Model

#### Video

New entity, table `videos`. Owned by `phase-03-videos/TD-05` (lifecycle state) and `phase-03-videos/TD-06` (public identifier); the metadata columns are fixed by TD-09's Revision and the `title` column by TD-05's Revision.

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated — internal only; never appears in a URL (per `phase-03-videos/TD-06`) |
| public_id | varchar(11) | unique, not null — 11-char base62, generated via `crypto.randomBytes` with retry-on-conflict (per `phase-03-videos/TD-06`) |
| channel_id | uuid | FK → `channels.id`, not null |
| title | varchar(255) | not null — seeded from the sanitised upload filename, extension stripped (per `phase-03-videos/TD-05` Revision 2026-08-30) |
| status | `video_status` (Postgres enum) | not null, default `draft` — one of `draft`, `uploading`, `processing`, `ready`, `failed` (per `phase-03-videos/TD-05`) |
| processing_error | text | nullable — set when `status = failed` (per `phase-03-videos/TD-05`; also written by the reaper per `phase-03-videos/TD-17`) |
| duration | numeric | nullable — seconds, from `ffprobe` (per `phase-03-videos/TD-09` Revision 2026-08-30) |
| width | integer | nullable — from `ffprobe` (per `phase-03-videos/TD-09` Revision) |
| height | integer | nullable — from `ffprobe` (per `phase-03-videos/TD-09` Revision) |
| ffprobe_metadata | jsonb | nullable — full `ffprobe -print_format json -show_format -show_streams` output, retained verbatim (per `phase-03-videos/TD-09` Revision) |
| source_ext | varchar(16) | nullable — source file extension; composes the storage key `videos/{id}/source{ext}` (per `phase-03-videos/TD-02`) and the download filename (per `phase-03-videos/TD-13`) |
| size_bytes | bigint | nullable — completed upload size; summed for the per-user storage quota (per `phase-03-videos/TD-16`) |
| upload_id | varchar(255) | nullable — tus upload id; maps an expired upload back to its row during reaping (per `phase-03-videos/TD-17`) |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel` via `channel_id`.

**Indexes:**
- unique on `public_id` — the uniqueness guarantee behind "URL única por vídeo, sem conflito" (per `phase-03-videos/TD-06`)
- composite on `(channel_id, status)` — serves the per-user concurrency count in `onUploadCreate` (per `phase-03-videos/TD-16`) and the Fase 04 channel dashboard listing (per `phase-03-videos/TD-05`)
- index on `status` — serves the reaper sweep for rows stranded in `uploading` (per `phase-03-videos/TD-17`)

**Deliberate exclusion:** `visibility` (`public` / `unlisted`) is **not** a value of `video_status` and not a column in this phase — it is a separate orthogonal axis owned by Fase 04 (per `phase-03-videos/TD-05`).

**Enum type:** `video_status` is created as a Postgres enum in the same migration. Migrations follow the inherited TypeORM CLI setup (per `## Inherited Conventions` — `data-source.ts` shares the `databaseConfig` factory).

### API Contracts

> Backend tier only. No BFF tier is emitted — this slice is `ui_in_scope: false` (backend-only phase; `next-frontend/` is deferred), so the join-driven BFF trigger does not fire. All responses use the inherited error envelope `{ statusCode, error, message }` (per `## Inherited Decisions Detail` → `phase-02-auth/TD-07`). All endpoints are annotated with `@nestjs/swagger` decorators so the exported `openapi.json` stays complete (per `## Inherited Decisions Detail` → `openapi-docs-nestjs/TD-01`, incl. its 2026-05-12 Revision requiring explicit `@ApiOperation` / `@ApiResponse` / `@ApiParam`).

#### ALL /videos/upload/* — tus resumable upload (SI-03.6)

The tus 1.0.0 protocol surface, mounted as a Nest controller route (`@All('videos/upload/*')` delegating to `tusServer.handle(req, res)`) with `NestFactory.create({ bodyParser: false })` and JSON parsing re-applied to the other routes — this keeps the guard pipeline, filters and Swagger metadata active for the route (per `phase-03-videos/TD-16`, and `phase-03-videos/TD-04` Revision 2026-08-30).

**Request headers:**
- Authorization: `Bearer <accessToken>`, required — verified by the ordinary `JwtAuthGuard`, not by the tus `onIncomingRequest` hook (per `phase-03-videos/TD-04` Revision 2026-08-30; guard per `## Inherited Decisions Detail` → `phase-02-auth/TD-02`)
- Tus-Resumable: `1.0.0`, required by the protocol
- Upload-Length: integer, required on creation (`POST`) — the declared total size, checked against `STORAGE_MAX_UPLOAD_BYTES` before any byte is stored (per `phase-03-videos/TD-04`)
- Upload-Metadata: base64 key-value pairs — carries `filename`, which seeds `Video.title` (per `phase-03-videos/TD-05` Revision)
- Upload-Offset: integer, required on `PATCH`
- Content-Type: `application/offset+octet-stream` on `PATCH`

**Request body:** raw byte stream on `PATCH`; empty on `POST` / `HEAD` / `OPTIONS`. Parts are forwarded to an S3 multipart upload as they arrive — never buffered whole (per `phase-03-videos/TD-03`).

**Response 201:** `Location` header carrying the upload URL. Side effect: a `videos` row is created with `status = draft` and `title` seeded from the upload filename, inside `onUploadCreate` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`).

**Response 204:** on `PATCH`, with `Upload-Offset` reflecting the new offset. On the final `PATCH` the `onUploadFinish` hook enqueues the processing job (see `### Events/Messages` → `video.process`).

**Error responses:**
- 401 (unauthenticated): missing or invalid bearer token — emitted by `JwtAuthGuard` before the tus handler runs
- 413 UPLOAD_TOO_LARGE: declared `Upload-Length` exceeds `STORAGE_MAX_UPLOAD_BYTES` (default 10 GiB) — rejected at creation, before storage is consumed (per `phase-03-videos/TD-04`)
- 409 UPLOAD_QUOTA_EXCEEDED: per-user concurrent-upload count or aggregate stored bytes exceeded (per `phase-03-videos/TD-16`)
- 410 UPLOAD_EXPIRED: the upload URL is past `UPLOAD_EXPIRATION_HOURS` — the tus expiration extension returns `410 Gone` (per `phase-03-videos/TD-17`)

---

#### GET /videos/{publicId}/playback (SI-03.10)

Returns a short-lived presigned GET URL; the client streams bytes directly from the object storage, which serves HTTP Range natively. The API is not in the byte path (per `phase-03-videos/TD-12`).

**Request headers:**
- Authorization: `Bearer <accessToken>`, **optional** — parsed when present, never rejected when absent. Marked `@Public()` with an additional `@OptionalAuth()` decorator that populates `request.user` when a valid header is supplied (per `phase-03-videos/TD-15`).

**Request path parameters:**
- publicId: string, required — the 11-char base62 identifier (per `phase-03-videos/TD-06`)

**Response 200:**
- url: string — presigned GET URL, signed against `STORAGE_PUBLIC_ENDPOINT` (per `phase-03-videos/TD-01`)
- expiresIn: integer — seconds, from `STORAGE_PLAYBACK_URL_TTL_SECONDS` (default 6h; must be passed explicitly — `getSignedUrl` defaults to 900s, see `library-refs.md` → `@aws-sdk/s3-request-presigner`) (per `phase-03-videos/TD-12`)

**Error responses:**
- 404 VIDEO_NOT_FOUND: no video with that `publicId`, **or** the video is not `ready` and the requester is not its owner. Non-ready videos return `404`, never `403`, so they are indistinguishable from non-existent ones and cannot be enumerated (per `phase-03-videos/TD-15`)

---

#### GET /videos/{publicId}/download (SI-03.10)

Kept deliberately separate from `/playback` rather than parameterised, because Fase 04 is expected to gate them differently (a video may be watchable but not downloadable); splitting later would be a breaking contract change (per `phase-03-videos/TD-13`).

**Request headers:**
- Authorization: `Bearer <accessToken>`, **optional** — same `@Public()` + `@OptionalAuth()` treatment as `/playback` (per `phase-03-videos/TD-15`)

**Request path parameters:**
- publicId: string, required — the 11-char base62 identifier (per `phase-03-videos/TD-06`)

**Response 200:**
- url: string — presigned GET URL carrying `response-content-disposition=attachment; filename="{sanitised title}{source_ext}"`. The override is signed into the URL by the serializer, so the storage layer itself forces the download and names the file; the internal storage key is never exposed (per `phase-03-videos/TD-13`; mechanism per `library-refs.md` → `@aws-sdk/client-s3`, which documents that header overrides require a signed request)
- expiresIn: integer — seconds

**Error responses:**
- 404 VIDEO_NOT_FOUND: same resource-state gating as `/playback` (per `phase-03-videos/TD-15`)

---

#### Validation Rules — upload ingest

Enforced inside the tus lifecycle hooks, which is the only place every check runs *before* storage is consumed (per `phase-03-videos/TD-04`):

- `Upload-Length` ≤ `STORAGE_MAX_UPLOAD_BYTES` — checked at handshake via the tus `maxSize` option, which also accepts an async `(req, uploadId) => number` form so the ceiling can be per-user (per `phase-03-videos/TD-04`, `phase-03-videos/TD-16`)
- concurrent uploads for the channel < `UPLOAD_MAX_CONCURRENT_PER_USER` (default 3) — one indexed `COUNT` over `(channel_id, status)` in `onUploadCreate` (per `phase-03-videos/TD-16`)
- aggregate `size_bytes` for the channel < `UPLOAD_MAX_TOTAL_BYTES_PER_USER` (default 50 GiB) — one indexed `SUM` in the same hook (per `phase-03-videos/TD-16`)
- client-declared `Content-Type` is **advisory only and never trusted**; the authoritative content check is `ffprobe`'s stream list in the worker, which transitions the video to `failed` when no video stream is present (per `phase-03-videos/TD-04`)

### Authorization Matrix

Access to the two delivery endpoints is gated on **resource state, not identity** — anonymous access is allowed only when `status = ready`, with an owner bypass for the uploader's own non-ready videos (per `phase-03-videos/TD-15`). "Owner" means an authenticated user whose `channel_id` matches the video's.

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| `ALL /videos/upload/*` (tus) | ✗ | ✓ | ✓ |
| `GET /videos/{publicId}/playback` | ✓ (only when `status = ready`) | ✓ (only when `status = ready`) | ✓ (any `status`) |
| `GET /videos/{publicId}/download` | ✓ (only when `status = ready`) | ✓ (only when `status = ready`) | ✓ (any `status`) |

Notes:

- Anonymous playback and download are **required** by Fase 05 (`Acesso anônimo à visualização de vídeos`, and the download button on that same anonymous page) — this phase must not gate them on identity (per `phase-03-videos/TD-15`).
- The upload route is guarded by the ordinary `JwtAuthGuard` because the tus handler is mounted as a Nest controller route (per `phase-03-videos/TD-04` Revision, `phase-03-videos/TD-16`). The rate-limiting guard inherited from `phase-02-auth/TD-08` is scoped to `AuthModule` and does **not** cover this route; upload abuse is bounded by the quota checks in `#### Validation Rules — upload ingest` instead.
- Fase 04's `visibility` (`public` / `unlisted`) slots into the same resolver method as a second predicate — it is not part of this matrix (per `phase-03-videos/TD-05`, `phase-03-videos/TD-15`).

### Error Catalog

Response shape is the inherited envelope `{ statusCode, error, message }` (per `## Inherited Decisions Detail` → `phase-02-auth/TD-07`). The machine-readable field carrying the codes below is named **`error`** — the `errorCode` column header is this table's label, not the wire field name.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | No video for the given `publicId`, **or** the video is not `ready` and the requester is not its owner (deliberately indistinguishable, to prevent enumeration — per `phase-03-videos/TD-15`) |
| UPLOAD_TOO_LARGE | 413 | Declared `Upload-Length` exceeds `STORAGE_MAX_UPLOAD_BYTES` (default 10 GiB), rejected at tus handshake before any byte is stored (per `phase-03-videos/TD-04`) |
| UPLOAD_QUOTA_EXCEEDED | 409 | Per-user concurrent-upload count ≥ `UPLOAD_MAX_CONCURRENT_PER_USER`, or aggregate stored bytes ≥ `UPLOAD_MAX_TOTAL_BYTES_PER_USER` (per `phase-03-videos/TD-16`) |
| UPLOAD_EXPIRED | 410 | The tus upload URL is past `UPLOAD_EXPIRATION_HOURS` (default 48); the expiration extension returns `410 Gone`, which is a resumable client's signal to restart rather than a silent failure (per `phase-03-videos/TD-17`) |

**Processing failures are not HTTP errors.** A corrupt or non-video upload, an FFmpeg crash, or a permanently failing job does not surface through this catalog — the job exhausts its 3 attempts and the video transitions to `status = failed` with the reason recorded in `processing_error` (per `phase-03-videos/TD-11`, `phase-03-videos/TD-05`). The same terminal state is used by the reaper for abandoned uploads (per `phase-03-videos/TD-17`). Fase 04's dashboard reads that column; no endpoint in this phase returns it as an error response.

### Events/Messages

Transport is BullMQ over Redis, registered via `@nestjs/bullmq` (per `phase-03-videos/TD-07`). The API process registers **only the producer** (`BullModule.registerQueue`); the `@Processor` is hosted by the separate `video-worker` container running a NestJS standalone application context, so an FFmpeg run can never starve the API's event loop (per `phase-03-videos/TD-08`).

#### video.process

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** the tus `onUploadFinish` hook in the API process (per `phase-03-videos/TD-04`, `phase-03-videos/TD-11`)
**Consumer:** `VideoProcessor` (`WorkerHost`) in the `video-worker` container (per `phase-03-videos/TD-08`)
**Trigger:** the final `PATCH` of a tus upload completes, so the source object is fully written to the private bucket.
**Delivery semantics:** at-least-once, deduplicated per video. Job options (per `phase-03-videos/TD-11`):
- `deduplication: { id: videoId }` — Simple Mode: no new job with this id is enqueued until the current one completes or fails. This is the BullMQ 6.x idiom for what TD-11 describes as `jobId = videoId`; it makes a retried final `PATCH` (which tus clients do) a no-op rather than a second transcode. See `library-refs.md` → `bullmq` § Correction 2.
- `attempts: 3` with `backoff: { type: 'exponential', delay: 30_000 }` — bounded retries; a permanently corrupt input reaches `status = failed` rather than being retried forever
- `removeOnComplete` bounded; `removeOnFail: false` — failed jobs retained for diagnostics
- Stalled-job recovery (worker OOM-killed mid-transcode) is handled by the Worker's lock-renewal heartbeat and is **separate from the `attempts` counter** — the job is requeued, not counted as a failed attempt. This is the property TD-07 chose BullMQ over pg-boss for.

**Work performed by the consumer:** `ffprobe` metadata extraction into `duration` / `width` / `height` / `ffprobe_metadata` (per `phase-03-videos/TD-09` + its Revision), thumbnail extraction at 10% of duration scaled to 1280×720 JPEG q3 written to `thumbnails/{video_id}/auto.jpg` (per `phase-03-videos/TD-10`), then `status → ready`. Both invoke the system binaries via `child_process.spawn` — no wrapper library (per `phase-03-videos/TD-09`). Output keys are deterministic, so a retried job overwrites rather than duplicating — idempotent by construction (per `phase-03-videos/TD-02`, `phase-03-videos/TD-11`).

#### abandoned-upload-reaper

**Payload:**

```json
{}
```

**Producer:** a Job Scheduler upserted at `video-worker` boot (per `phase-03-videos/TD-17`)
**Consumer:** `ReaperProcessor` in the `video-worker` container (per `phase-03-videos/TD-17` Revision 2026-08-30)
**Trigger:** hourly, on a fixed interval.
**Delivery semantics:** at-least-once; idempotent by construction (reaping an already-reaped upload is a no-op).

Implementation notes:

- Registered with `queue.upsertJobScheduler('abandoned-upload-reaper', { every: 3_600_000 }, { name: 'reap', ... })`. **Not** `queue.add(..., { repeat })` — that is the BullMQ v5 API; v6 replaces repeatable jobs with Job Schedulers, and `upsertJobScheduler` is idempotent by scheduler id so calling it on every worker boot is safe. `QueueScheduler` no longer exists in v6. See `library-refs.md` → `bullmq` § Correction 1.
- The worker constructs its **own** `S3Store` + tus `Server` with no route mounted, purely to call `server.cleanUpExpiredUploads()` — the tus `Server` that the API mounts as a controller route is not reachable from the worker process (per `phase-03-videos/TD-17` Revision 2026-08-30).
- In the same run it transitions every `videos` row whose upload expired to `status = failed` with `processing_error` set, rather than deleting it — the row is the user's only evidence that an upload was attempted, and TD-05 already has a terminal state for exactly this (per `phase-03-videos/TD-17`).
- Expiry is driven by `expirationPeriodInMilliseconds` on the `S3Store`, derived from `UPLOAD_EXPIRATION_HOURS` (default 48 — deliberately generous, since a resumable 10GB upload on a poor connection may legitimately span more than a day). The extension is implemented with **object tagging**; `useTags` stays at its default `true` (MinIO supports tagging). Switching to a storage backend without tagging support silently disables expiry (per `phase-03-videos/TD-17`; mechanism per `library-refs.md` → `@tus/s3-store`).

---

## Dependency Map

```
SI-03.1 (root — Compose: minio + redis, configs, env schema)
├── SI-03.2 — depends on SI-03.1 (minio + storage.config antes do cliente S3)
│   └── SI-03.10 — depends on SI-03.2 + SI-03.3 + SI-03.4 (presigner + entidade + public_id na rota)
├── SI-03.3 — depends on SI-03.1 (migration roda contra o db configurado)
│   └── SI-03.4 — depends on SI-03.3 (coluna e constraint unique de public_id)
└── SI-03.5 — depends on SI-03.1 + SI-03.3 (redis + VideosModule)
    ├── SI-03.6 — depends on SI-03.2 + SI-03.3 + SI-03.5 (storage + entidade + fila)
    │   └── SI-03.11 — depends on SI-03.6 + SI-03.7 + SI-03.3 (config do S3Store + worker + entidade)
    └── SI-03.7 — depends on SI-03.1 + SI-03.5 (Compose + fila registrada)
        └── SI-03.8 — depends on SI-03.7 (binários FFmpeg só existem na imagem do worker)
            └── SI-03.9 — depends on SI-03.8 + SI-03.2 + SI-03.3 + SI-03.5
```

Notas de leitura:

- A árvore mostra cada SI sob a sua dependência mais restritiva; as demais aparecem na linha do próprio nó. `SI-03.9`, `SI-03.10` e `SI-03.11` são os pontos de convergência — cada um fecha um caminho distinto (processamento, entrega, limpeza).
- `SI-03.10` (entrega) não depende de `SI-03.6` nem de `SI-03.9`: os endpoints de playback e download podem ser implementados e testados contra vídeos semeados diretamente em `ready`, sem passar pelo fluxo de upload.
- `SI-03.11` depende de `SI-03.6` apenas pela configuração compartilhada do `S3Store` (`expirationPeriodInMilliseconds`), não pelo controller — o reaper instancia o seu próprio `Server` tus no worker.

---

## Deliverables

- [ ] SI-03.1 — Provisionar infraestrutura de storage e fila
- [ ] SI-03.2 — Implementar módulo de storage S3
- [ ] SI-03.3 — Criar entidade Video e migration
- [ ] SI-03.4 — Implementar gerador de identificador público
- [ ] SI-03.5 — Registrar fila de processamento (lado produtor)
- [ ] SI-03.6 — Expor ingest tus com autorização, quota e pré-cadastro
- [ ] SI-03.7 — Provisionar container video-worker
- [ ] SI-03.8 — Implementar wrapper FFmpeg
- [ ] SI-03.9 — Implementar job de processamento de vídeo
- [ ] SI-03.10 — Expor endpoints de playback e download
- [ ] SI-03.11 — Implementar reaper de uploads abandonados

**Full test suites:**

Todos os comandos rodam **dentro do container**, per `nestjs-project/CLAUDE.md` — executá-los no host causa divergência de env (`DB_HOST` resolveria para `localhost` em vez do nome de serviço do Compose).

- [ ] Backend unit tests pass (`docker compose exec nestjs-api npm test`)
- [ ] Backend integration tests pass (`docker compose exec nestjs-api npm run test:integration`) — exige `db`, `minio` e `redis` de pé; roda com `--runInBand`
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)

**Infra readiness:**

- [ ] `docker compose ps` mostra `nestjs-api`, `db`, `mailpit`, `minio`, `redis` e `video-worker` em `running`
- [ ] `docker compose exec db pg_isready -U streamtube` responde `accepting connections`
- [ ] `docker compose exec video-worker ffmpeg -version` responde com uma versão instalada

**Artefato de contrato:**

- [ ] `nestjs-project/openapi.json` regenerado (`docker compose exec nestjs-api npm run openapi:export`) contendo os três endpoints desta fase com parâmetros, respostas por status e contratos de erro explícitos (per `## Inherited Decisions Detail` → `openapi-docs-nestjs/TD-01`)
