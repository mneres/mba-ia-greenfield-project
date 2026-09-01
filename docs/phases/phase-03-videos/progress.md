# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 5/11 completed

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
- **Status:** completed
- **Tests:** 43 passing (2 fix attempts)
- **Observations:**
  - O banco de dev estava com resíduo de `synchronize`: as 4 tabelas existiam mas a tabela `migrations` tinha 0 linhas, então `migration:run` abortava com "relation channels already exists". Segui a recuperação documentada em `.claude/rules/typeorm-migrations.md` — **com aprovação explícita do usuário, porque destruía 21 linhas** (2 users, 2 channels, 15 refresh_tokens, 2 verification_tokens; pelo formato, resíduo de suíte de teste).
  - **A causa raiz do resíduo continua ativa:** `createTestDataSource` usa `synchronize: true` por padrão, então toda spec de entidade recria tabelas por fora do runner de migration. O mesmo estado vai se formar de novo na próxima máquina de dev. Vale uma task separada.
  - Duas correções no teardown do `migrations.integration-spec.ts`, ambas bugs latentes desde a fase 02 que a entrada de `videos` tornou determinísticos: (1) `Promise.all` sobre `DROP ... CASCADE` em tabelas ligadas por FK adquire locks em ordens diferentes e o Postgres aborta com deadlock — serializado; (2) `DROP TABLE ... CASCADE` **não** derruba tipos enum no Postgres, então `verification_tokens_type_enum` sobrevivia e fazia o `CREATE TYPE` do próximo `runMigrations()` falhar — varredura dinâmica de `pg_type` em vez de lista fixa.
  - `duration` (numeric) e `size_bytes` (bigint) voltam como string no driver pg; ambos passam por transformer para chegar como `number`. Sem isso a conversão vazaria para todo consumidor em SI-03.9 e SI-03.10.
  - Transição inválida lança `Error` comum, não `DomainException`. `DomainException` é abstrata e nenhum endpoint desta fase deixa o cliente pedir transição arbitrária — logo é erro de programação e `INVALID_VIDEO_TRANSITION` não pertence ao Error Catalog.
  - Dois arquivos fora dos nomeados pelo SI: `Channel` ganhou o lado inverso `videos` (o Data Model especifica o one-to-many e o callback do `@ManyToOne` exige) e `cleanAllTables` passou a limpar `videos` antes de `channels` (ordem da FK). Ambos exigidos pelo contrato.
  - **Jest não encerra sozinho após reportar** (open handles) — a execução anterior consumiu os 600s do timeout apesar de os testes terminarem em 4s. Provável `DataSource` não destruído quando uma suíte falha antes do `afterAll`. Fora do escopo deste SI, mas é um imposto em toda rodada de teste.

### SI-03.4 — Implementar gerador de identificador público
- **Status:** completed
- **Tests:** 217 unit+integration passing (30 suites) + 52 e2e passing; 1 fix attempt
- **Observations:**
  - **A suíte completa estava vermelha ao entrar neste SI — 63 falhas em 10 suítes, regressão do SI-03.3 que só apareceu agora.** A relação inversa `Channel.videos` faz o TypeORM exigir `Video` no mesmo DataSource, e toda suíte com `Channel` numa lista de 4 entidades morria em `DataSource.initialize()` com "Entity metadata for Channel#videos was not found". O SI-03.3 rodou só os seus 4 arquivos de teste, nunca a suíte completa — o passo 2 da Definition of Done foi pulado lá.
  - A correção não foi acrescentar `Video` em dez cópias da lista: `ALL_ENTITIES` passou a ser exportado de `src/test/create-test-data-source.ts` e as 13 declarações locais viraram import. A duplicação era a causa real — cada entidade nova com relação inversa quebrava todas as suítes de uma vez, e as fases 04–07 acrescentam `Comment`, `Like` e `Subscription`.
  - `jest.spyOn(crypto, 'randomBytes')` não funciona: o Node define a propriedade como não-configurável e o spy lança `Cannot redefine property`. Em vez de mockar o builtin, extraí `appendUnbiasedChars` — função pura sobre bytes conhecidos. O CSPRNG virou fronteira e a lógica de rejeição ficou testável de forma determinística.
  - O teste estatístico de viés foi verificado contra a implementação defeituosa: sem rejeição a razão dá 1,24 contra o limite de 1,1 do assert. Não é um teste que passa por vacuidade.
  - `create` não faz SELECT prévio, ao contrário do retry de nickname em `ChannelsService`: lá a base vem do e-mail e colidir é o caso normal; aqui o id é aleatório sobre ~65 bits e o SELECT seria um round trip desperdiçado em todo create.
  - `isPublicIdConflict` lê `err.driverError` com uma interface estreita em vez do `as any` que `ChannelsService` usa — o `as any` gera 6 erros de `no-unsafe-*` e não valia replicar. `channels.service.ts` segue com os seus (fora de escopo).
  - AC #4 ("o `id` interno não aparece em nenhuma resposta de API desta fase") **não é verificável neste SI** — nenhum endpoint existe ainda. Cai em SI-03.6 e SI-03.10.
  - **`npm run lint` não passa no repositório, e não passava antes desta fase:** 119 erros no HEAD, 113 agora. Nenhum introduzido aqui; os 6 a menos são 5 violações de Prettier dos SI-03.1/03.2/03.3 e um import morto. O grosso está em arquivos de teste da fase 02 (`auth.service.spec.ts` 45, `mail.service.integration-spec.ts` 16, `channels.service.spec.ts` 15, `env.validation.integration-spec.ts` 14). O critério 4 da Definition of Done está descumprido desde antes da fase 03 e precisa de uma task própria.

### SI-03.5 — Registrar fila de processamento (lado produtor)
- **Status:** completed
- **Tests:** 223 unit+integration passing (31 suites) + 52 e2e passing; 2 fix attempts
- **Observations:**
  - **`@nestjs/bullmq@12` é `type: module` — ESM puro — e quebra o transform CJS do ts-jest** (`SyntaxError: Unexpected token 'export'`). O Node 25 do container aceita `require(esm)`, então a aplicação subiria e o problema só apareceria na suíte. Fixado em `^11.0.5`, que é CJS, mantém `extraOptions.manualRegistration` (verificado no `.d.ts` instalado) e cujo peer range aceita `bullmq ^6`. É a mesma restrição que TD-06 já havia ratificado ao recusar `nanoid` v6 — vale registrar que ela agora vinculou a versão de um segundo pacote, e vai vincular outros enquanto o backend for CommonJS.
  - **`bullmq@6` tornou o `ioredis` peer opcional** (na v5 era dependência direta): sem instalá-lo explicitamente, toda construção de `Queue` falha com "BullMQ could not load the optional 'ioredis' package". Adicionado como dependência direta.
  - O teste de deduplicação foi conferido contra a implementação sem a opção: 2 jobs sem `deduplication`, 1 com. Não passa por vacuidade.
  - AC #2 ("o processo da API não instancia nenhum Worker") **é estrutural, não observável por teste direto**: vem de `manualRegistration: true` no `forRoot` somado à ausência do array `processors` no `registerQueue`. O teste cobre a parte observável — um job enfileirado continua em `waiting` e nunca vai para `active`, provando que nada neste processo o consome.
  - **Uma execução da suíte e2e falhou 47 de 52 testes e não foi reproduzida depois** (3 tentativas: 2 na mesma sequência combinada, 1 isolada; todas verdes). O texto do erro se perdeu porque o comando estava filtrado por grep. Descartei estado de schema (banco com 6 tabelas e 3 migrations logo após a suíte unit) e truncamento do `afterAll` pelo `--forceExit` (3 execuções seguidas restauraram corretamente). A explicação mais provável é contenção de CPU: eu rodei `eslint` sobre todo o `src/` concorrentemente com a fase e2e, e 47 falhas em cascata combinam com timeout de boot da aplicação. **Não é uma causa comprovada** — se reaparecer, capturar o erro antes de qualquer outra coisa.
  - `createTestQueue` isola por nome de fila com UUID e faz `obliterate` no close: filas BullMQ são globais no Redis, então duas suítes na mesma fila veriam os jobs uma da outra.
  - As constantes de fila e as opções de job ficam em `videos.constants.ts` porque o container `video-worker` de SI-03.7 precisa concordar na mesma string de nome de fila — divergir ali enfileira jobs numa fila que ninguém consome.

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
