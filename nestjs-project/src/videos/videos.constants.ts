/**
 * Nome da fila de processamento de vídeo.
 *
 * Compartilhado entre o produtor (o processo da API, aqui) e o consumidor (o
 * container `video-worker` de SI-03.7): os dois lados precisam concordar na
 * string ou os jobs são enfileirados numa fila que ninguém consome.
 */
export const VIDEO_PROCESSING_QUEUE = 'video-processing';

/** Nome do job dentro da fila (per `## Technical Specifications` → `### Events/Messages`). */
export const VIDEO_PROCESS_JOB = 'video.process';

/**
 * Opções de confiabilidade do job (per `phase-03-videos/TD-11`).
 *
 * `attempts: 3` com backoff exponencial de 30s limita o retry: uma entrada
 * permanentemente corrompida chega a `failed` em vez de ser retentada para
 * sempre, o que num FFmpeg sobre 10GB seria uma conta de CPU sem teto.
 *
 * A recuperação de job travado (worker morto por OOM no meio do transcode) é
 * separada deste contador — vem do heartbeat de renovação de lock do Worker,
 * que requeue o job em vez de contá-lo como tentativa falha. É a propriedade
 * que fez TD-07 escolher BullMQ em vez de pg-boss.
 */
export const VIDEO_PROCESS_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 30_000 },
  removeOnComplete: { count: 1000 },
  // Jobs falhos ficam retidos para diagnóstico — é a única evidência de por que
  // um vídeo parou em `failed`.
  removeOnFail: false,
} as const;

/**
 * Caminho onde o servidor tus é montado.
 *
 * Precisa casar com a rota do `UploadController`: o tus usa este valor para
 * montar o header `Location` e para reconhecer o próprio prefixo ao extrair o
 * id do upload da URL.
 */
export const TUS_UPLOAD_PATH = '/videos/upload';

/** Tamanho de parte do multipart S3 (per `phase-03-videos/TD-03`). */
export const TUS_PART_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * Teto de partes do multipart. 10.000 é o limite da AWS; a 50MB por parte um
 * upload de 10GB fica em ~200 partes, dentro também do limite menor de 1.000 que
 * alguns provedores compatíveis impõem (per `phase-03-videos/TD-03`).
 */
export const TUS_MAX_MULTIPART_PARTS = 10000;
