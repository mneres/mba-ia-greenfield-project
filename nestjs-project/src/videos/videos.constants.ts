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
