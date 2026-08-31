# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 2/11 completed

### SI-03.1 — Provisionar infraestrutura de storage e fila
- **Status:** completed
- **Tests:** 12 passing
- **Observations:**
  - Adicionadas 5 chaves de env além das 9 enumeradas na technical action 4 — `STORAGE_VIDEOS_BUCKET`, `STORAGE_THUMBNAILS_BUCKET`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_REGION`. A action 2 exige os campos `videosBucket`/`thumbnailsBucket` no config, e o cliente S3 de SI-03.2 não tem como ser construído sem credenciais; sem elas a própria action 2 seria inimplementável.
  - `STORAGE_ACCESS_KEY` e `STORAGE_SECRET_KEY` ficaram `.required()` (mesmo padrão dos segredos JWT), o que quebraria os testes pré-existentes de `SWAGGER_ENABLED` — todos compartilham o objeto `requiredEnv`. Estendi esse fixture em vez de afrouxar o schema; as asserções originais seguem intactas.
  - `env.validation.integration-spec.ts` é teste de schema puro, sem I/O de banco — por `nestjs-project/CLAUDE.md` § "Test Type Selection" o sufixo correto seria `*.spec.ts`. Mantido o nome atual porque o SI nomeia esse path exato e o arquivo já existia; renomear é fora de escopo.
  - Healthcheck do MinIO usa `mc ready local`, que depende do binário `mc` estar presente na imagem. **Confirmado durante SI-03.2**: `docker compose up -d` deixou `minio` e `redis` em `running (healthy)`, então o AC #1 já está satisfeito na prática.

### SI-03.2 — Implementar módulo de storage S3
- **Status:** completed
- **Tests:** 10 passing (1 fix attempt)
- **Observations:**
  - `.env` é gitignored, então a atualização de `.env.example` feita em SI-03.1 não chegou nele. Adicionei o mesmo bloco ao `.env` local e reiniciei `nestjs-api` — sem isso o Joi rejeita no boot e o `StorageService` lança no construtor. **Quem clonar esta branch precisa copiar o bloco de `.env.example` para o seu `.env` antes de rodar a suíte.**
  - O teste "credenciais ausentes" falhou na primeira execução por um bug de setup meu: `ConfigModule.forRoot()` relê o arquivo `.env` do disco e repopula `process.env`, desfazendo os `delete process.env.STORAGE_*` antes do factory rodar. Sem `ignoreEnvFile: true` a asserção era vazia — o módulo compilava e o teste só provava que compilar funciona. Corrigido com `ignoreEnvFile: true` nesse módulo de teste específico.
  - Leitura anônima no bucket de thumbnails é concedida via `PutBucketPolicyCommand` (statement `s3:GetObject` para `Principal: *`), reaplicada a cada boot — idempotente por construção, junto com a criação dos buckets.
  - `getObjectBuffer` usa `result.Body!.transformToByteArray()`. O `!` é necessário porque o SDK tipa `Body` como opcional; numa resposta 200 de `GetObject` ele está sempre presente. Vale trocar por narrowing explícito se a regra de strict-null apertar.

### SI-03.3 — Criar entidade Video e migration
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Implementar gerador de identificador público
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Registrar fila de processamento (lado produtor)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Expor ingest tus com autorização, quota e pré-cadastro
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Provisionar container video-worker
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Implementar wrapper FFmpeg
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Implementar job de processamento de vídeo
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Expor endpoints de playback e download
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Implementar reaper de uploads abandonados
- **Status:** pending
- **Tests:** —
- **Observations:** none
