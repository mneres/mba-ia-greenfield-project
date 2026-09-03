---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: nestjs-project/test/videos-upload.e2e-spec.ts
---

# POST /videos/upload — Test Plan

## Application Overview

O ingest de vídeo expõe o protocolo tus 1.0.0 numa rota de controller Nest (`@All('videos/upload/*')`), sob `JwtAuthGuard`. A criação do upload (`POST`) é o ponto onde toda a defesa acontece: o token é verificado pelo guard, o `Upload-Length` declarado é confrontado com o teto configurado, a cota do canal é checada, e a row de vídeo é pré-cadastrada como rascunho — tudo antes de qualquer byte ser gravado no bucket. A conclusão do upload (último `PATCH`) transiciona o vídeo para `processing` e enfileira o job de processamento exatamente uma vez.

## Test Scenarios

### 1. Autorização e limites de ingest

**Setup:** `beforeEach` trunca `videos` e `channels`; bootstrap do módulo de teste via `Test.createTestingModule(...).compile()` reproduzindo os pipes/filters globais de `main.ts`; MinIO e Redis reais do Compose.

#### 1.1. rejeita-criacao-sem-token

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-31T02:57:10Z

**Steps:**
  1. POST /videos/upload sem header `Authorization`, com `Tus-Resumable: 1.0.0` e `Upload-Length` válido
    - expect: status 401
    - expect: nenhuma row em `videos` foi criada
    - expect: nenhum objeto foi gravado no bucket privado

#### 1.2. rejeita-upload-length-acima-do-teto

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-31T02:57:10Z

**Steps:**
  1. POST /videos/upload autenticado, com `Upload-Length` maior que `STORAGE_MAX_UPLOAD_BYTES`
    - expect: status 413
    - expect: body no envelope `{ statusCode, error, message }` com `error: "UPLOAD_TOO_LARGE"`
    - expect: nenhum byte foi gravado no bucket privado
    - expect: nenhuma row em `videos` foi criada

#### 1.3. rejeita-quando-cota-de-concorrencia-esgotada

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-31T02:57:10Z

**Steps:**
  1. Semear `UPLOAD_MAX_CONCURRENT_PER_USER` vídeos do mesmo canal em `status = uploading`
  2. POST /videos/upload autenticado pelo dono desse canal
    - expect: status 409
    - expect: body com `error: "UPLOAD_QUOTA_EXCEEDED"`
    - expect: a contagem de rows em `videos` do canal não aumentou

### 2. Pré-cadastro e enfileiramento

**Setup:** mesma do grupo 1.

#### 2.1. pre-cadastra-rascunho-na-criacao

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-08-31T02:57:10Z

**Steps:**
  1. POST /videos/upload autenticado, com `Upload-Metadata` carregando `filename` base64 de `Minha Ferias.mp4`
    - expect: status 201
    - expect: header `Location` presente apontando para a URL do upload
    - expect: exatamente uma row nova em `videos` para o canal
    - expect: essa row tem `status = draft`
    - expect: essa row tem `title` derivado do filename, sem a extensão
    - expect: essa row tem `public_id` de 11 caracteres

#### 2.2. enfileira-job-ao-concluir-upload

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-08-31T02:57:10Z

**Steps:**
  1. POST /videos/upload autenticado para criar o upload
  2. PATCH na URL retornada, enviando o conteúdo completo da fixture com `Content-Type: application/offset+octet-stream` e `Upload-Offset: 0`
    - expect: status 204
    - expect: a row transicionou para `status = processing`
    - expect: a row tem `size_bytes` e `source_ext` preenchidos
    - expect: exatamente um job `video.process` na fila para esse `videoId`

#### 2.3. patch-final-reenviado-nao-duplica-job

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-08-31T02:57:10Z

**Steps:**
  1. Completar um upload conforme o cenário 2.2
  2. Reenviar o mesmo PATCH final (retry idempotente do cliente tus)
    - expect: continua existindo exatamente um job `video.process` para esse `videoId`
    - expect: a row permanece em `status = processing`, sem transição espúria
