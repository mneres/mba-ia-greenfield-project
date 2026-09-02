---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: nestjs-project/test/videos-delivery.e2e-spec.ts
---

# GET /videos/{publicId}/playback e /download — Test Plan

## Application Overview

Os dois endpoints de entrega devolvem URLs presignadas de curta duração; o cliente busca os bytes direto do object storage, que serve HTTP Range nativamente — a API nunca está no caminho dos bytes. O acesso é barrado por **estado do recurso**, não por identidade: anônimos leem vídeos `ready`, e o dono autenticado alcança também os seus vídeos ainda não prontos. Vídeos não-prontos respondem `404` (nunca `403`), de modo que não são distinguíveis de um `publicId` inexistente e portanto não são enumeráveis.

> **Restrição de ambiente (registrada em 2026-09-02, durante SI-03.10).** TD-01 assina as URLs contra `STORAGE_PUBLIC_ENDPOINT` (`localhost:9000`), que é o host do browser e, por construção, **não é alcançável de dentro da rede do Compose** — ali `localhost` é o próprio container. Como SigV4 assina o header `Host`, trocar o host da URL pronta invalida a assinatura, então não há contorno.
>
> Isso torna inexecutáveis, como escritos, o passo 2–3 do cenário **1.4** e o passo 3 do **2.1**: ambos exigem *requisitar* a URL retornada. A verificação foi dividida:
>
> - o E2E confere os parâmetros assinados que a URL carrega (`X-Amz-Expires`, `X-Amz-Signature`, `response-content-disposition`);
> - `src/videos/videos.controller.integration-spec.ts` sobe uma segunda instância de `StorageService` assinando contra o endpoint **interno** e aí sim busca os bytes, cobrindo Range (dois `206` consecutivos), `Content-Disposition: attachment` e rejeição de assinatura adulterada.

## Test Scenarios

### 1. Playback

**Setup:** `beforeEach` trunca `videos` e `channels`; bootstrap do módulo de teste via `Test.createTestingModule(...).compile()` reproduzindo os pipes/filters globais de `main.ts`; MinIO real do Compose com um objeto semeado no bucket privado.

#### 1.1. anonimo-obtem-url-de-video-ready

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-31T02:57:37Z

**Steps:**
  1. Semear um vídeo em `status = ready` com objeto correspondente no bucket privado
  2. GET /videos/{publicId}/playback sem header `Authorization`
    - expect: status 200
    - expect: body contém `url` não vazia
    - expect: body contém `expiresIn` igual a `STORAGE_PLAYBACK_URL_TTL_SECONDS`
    - expect: a `url` aponta para o host público do storage, não para o endpoint interno

#### 1.2. video-nao-pronto-e-indistinguivel-de-inexistente

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-31T02:57:37Z

**Steps:**
  1. Semear um vídeo em `status = processing`
  2. GET /videos/{publicId}/playback sem autenticação
    - expect: status 404
    - expect: body com `error: "VIDEO_NOT_FOUND"`
  3. GET /videos/{publicIdInexistente}/playback sem autenticação
    - expect: status 404
    - expect: body byte-idêntico ao da resposta anterior — nada no corpo revela que o primeiro vídeo existe

#### 1.3. dono-alcanca-proprio-video-nao-pronto

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-31T02:57:37Z

**Steps:**
  1. Semear um vídeo em `status = processing` pertencente ao canal do usuário autenticado
  2. GET /videos/{publicId}/playback com `Authorization: Bearer <token do dono>`
    - expect: status 200
    - expect: body contém `url`
  3. GET /videos/{publicId}/playback com o token de um outro usuário autenticado
    - expect: status 404
    - expect: body com `error: "VIDEO_NOT_FOUND"`

#### 1.4. url-suporta-requisicoes-range-repetidas

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-08-31T02:57:37Z

**Steps:**
  1. Obter a `url` de playback de um vídeo `ready`
  2. Requisitar a `url` com header `Range: bytes=0-99`
    - expect: status 206
    - expect: header `Content-Range` presente
  3. Requisitar a mesma `url` novamente com `Range: bytes=100-199`
    - expect: status 206 — a assinatura continua válida entre requisições dentro da janela de TTL

### 2. Download

**Setup:** mesma do grupo 1.

#### 2.1. download-forca-attachment-com-filename-legivel

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-08-31T02:57:37Z

**Steps:**
  1. Semear um vídeo `ready` com `title = "Minha Ferias"` e `source_ext = ".mp4"`
  2. GET /videos/{publicId}/download sem autenticação
    - expect: status 200
    - expect: body contém `url`
  3. Requisitar a `url` retornada
    - expect: header `Content-Disposition` com `attachment`
    - expect: o filename do `Content-Disposition` deriva do título e termina em `.mp4`
    - expect: nem a `url` nem os headers revelam a chave interna de storage (`videos/{id}/source...`)

#### 2.2. download-aplica-a-mesma-porta-de-estado

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-31T02:57:37Z

**Steps:**
  1. Semear um vídeo em `status = failed`
  2. GET /videos/{publicId}/download sem autenticação
    - expect: status 404
    - expect: body com `error: "VIDEO_NOT_FOUND"`

#### 2.3. nenhuma-resposta-expoe-o-id-interno

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-08-31T02:57:37Z

**Steps:**
  1. GET /videos/{publicId}/playback de um vídeo `ready`
    - expect: o corpo da resposta não contém o uuid interno do vídeo em nenhum campo
  2. GET /videos/{publicId}/download do mesmo vídeo
    - expect: o corpo da resposta não contém o uuid interno do vídeo em nenhum campo
